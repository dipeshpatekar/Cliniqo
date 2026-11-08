import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
  NotFoundException,
  ForbiddenException,
} from "@nestjs/common"
import { InjectModel, InjectConnection } from "@nestjs/mongoose"
import type { Connection } from "mongoose"
import { Model, Types } from "mongoose"
import crypto from "node:crypto"
import {
  Clinic,
  type ClinicDocument,
  ClinicStatus,
} from "./schemas/clinic.schema.js"
import {
  ClinicMembership,
  type ClinicMembershipDocument,
  ClinicRole,
  ClinicMembershipStatus,
} from "./schemas/clinic-membership.schema.js"
import {
  ClinicInvitation,
  type ClinicInvitationDocument,
  ClinicInvitationStatus,
} from "./schemas/clinic-invitation.schema.js"
import {
  InvitationOutbox,
  type InvitationOutboxDocument,
  OutboxStatus,
} from "./schemas/invitation-outbox.schema.js"
import { ClinicAuditAction } from "./schemas/clinic-audit-log.schema.js"
import { ClinicAuditService } from "./clinic-audit.service.js"
import { ClinicOutboxService } from "./clinic-outbox.service.js"
import { executeInTransaction } from "../database/transaction.helper.js"
import { CreateClinicDto } from "./dto/create-clinic.dto.js"
import { UpdateClinicDto } from "./dto/update-clinic.dto.js"
import { InviteMemberDto } from "./dto/invite-member.dto.js"
import { Doctor, type DoctorDocument } from "../auth/schemas/doctor.schema.js"

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

@Injectable()
export class ClinicService {
  private readonly logger = new Logger(ClinicService.name)

  constructor(
    @InjectConnection()
    private readonly connection: Connection,
    @InjectModel(Clinic.name)
    private readonly clinicModel: Model<ClinicDocument>,
    @InjectModel(ClinicMembership.name)
    private readonly membershipModel: Model<ClinicMembershipDocument>,
    @InjectModel(ClinicInvitation.name)
    private readonly invitationModel: Model<ClinicInvitationDocument>,
    @InjectModel(InvitationOutbox.name)
    private readonly outboxModel: Model<InvitationOutboxDocument>,
    @InjectModel(Doctor.name)
    private readonly doctorModel: Model<DoctorDocument>,
    private readonly auditService: ClinicAuditService,
    private readonly outboxService: ClinicOutboxService,
  ) {}

  /**
   * Creates a clinic and assigns the creator as the initial OWNER atomically.
   */
  async createClinicWithMembership(
    creator: DoctorDocument,
    dto: CreateClinicDto,
  ): Promise<{ clinic: ClinicDocument; membership: ClinicMembershipDocument }> {
    const candidateSlug = dto.slug ? slugify(dto.slug) : slugify(dto.name)
    if (!candidateSlug) {
      throw new BadRequestException("A valid clinic name or slug is required.")
    }

    return executeInTransaction(this.connection, async (session) => {
      const existing = await this.clinicModel
        .findOne({ slug: candidateSlug })
        .session(session)

      if (existing) {
        throw new ConflictException(
          "A clinic with this unique slug already exists. Please choose another name.",
        )
      }

      const clinics = await this.clinicModel.create(
        [
          {
            name: dto.name.trim(),
            slug: candidateSlug,
            phone: dto.phone.trim(),
            email: dto.email.toLowerCase().trim(),
            address: dto.address,
            status: ClinicStatus.ACTIVE,
            ownerDoctorId: creator._id,
            createdBy: creator._id,
          },
        ],
        { session },
      )
      const clinic = clinics[0]

      const memberships = await this.membershipModel.create(
        [
          {
            clinicId: clinic._id,
            doctorId: creator._id,
            role: ClinicRole.OWNER,
            status: ClinicMembershipStatus.ACTIVE,
            joinedAt: new Date(),
          },
        ],
        { session },
      )
      const membership = memberships[0]

      await this.auditService.logEvent(
        {
          clinicId: clinic._id,
          actorDoctorId: creator._id,
          action: ClinicAuditAction.CLINIC_CREATED,
          metadata: {
            clinicSlug: candidateSlug,
            initialOwnerDoctorId: creator._id.toString(),
          },
        },
        session,
      )

      return { clinic, membership }
    })
  }

  /**
   * Lists all active clinic memberships for an authenticated doctor.
   */
  async listDoctorClinics(doctorId: Types.ObjectId): Promise<any[]> {
    const memberships = await this.membershipModel
      .find({
        doctorId,
        status: ClinicMembershipStatus.ACTIVE,
      })
      .populate("clinicId")
      .lean()

    return memberships
      .filter((m) => m.clinicId != null)
      .map((m: any) => ({
        id: m.clinicId._id.toString(),
        name: m.clinicId.name,
        slug: m.clinicId.slug,
        phone: m.clinicId.phone,
        email: m.clinicId.email,
        address: m.clinicId.address,
        status: m.clinicId.status,
        role: m.role,
        joinedAt: m.joinedAt,
      }))
  }

  /**
   * Retrieves profile details for a validated clinic context.
   */
  async getClinicProfile(clinicId: Types.ObjectId): Promise<ClinicDocument> {
    const clinic = await this.clinicModel.findById(clinicId)
    if (!clinic) {
      throw new NotFoundException("Clinic not found.")
    }
    return clinic
  }

  /**
   * Updates an active clinic's details.
   */
  async updateClinic(
    clinicId: Types.ObjectId,
    dto: UpdateClinicDto,
    _actorId: Types.ObjectId,
  ): Promise<ClinicDocument> {
    const updatePayload: Record<string, any> = {}
    if (dto.name) updatePayload.name = dto.name.trim()
    if (dto.phone) updatePayload.phone = dto.phone.trim()
    if (dto.email) updatePayload.email = dto.email.toLowerCase().trim()
    if (dto.address) updatePayload.address = dto.address

    return executeInTransaction(this.connection, async (session) => {
      const updated = await this.clinicModel.findOneAndUpdate(
        { _id: clinicId, status: ClinicStatus.ACTIVE },
        { $set: updatePayload },
        { session, new: true },
      )

      if (!updated) {
        throw new NotFoundException("Active clinic not found for update.")
      }

      return updated
    })
  }

  /**
   * Suspends an active clinic (Owner only).
   */
  async suspendClinic(
    clinicId: Types.ObjectId,
    reason: string,
    actorId: Types.ObjectId,
  ): Promise<ClinicDocument> {
    return executeInTransaction(this.connection, async (session) => {
      const updated = await this.clinicModel.findOneAndUpdate(
        { _id: clinicId, status: ClinicStatus.ACTIVE },
        { $set: { status: ClinicStatus.SUSPENDED } },
        { session, new: true },
      )

      if (!updated) {
        throw new ConflictException(
          "Clinic cannot be suspended; it may not be in active state.",
        )
      }

      await this.auditService.logEvent(
        {
          clinicId,
          actorDoctorId: actorId,
          action: ClinicAuditAction.CLINIC_SUSPENDED,
          reason,
        },
        session,
      )

      return updated
    })
  }

  /**
   * Reactivates a suspended clinic (Owner only).
   */
  async reactivateClinic(
    clinicId: Types.ObjectId,
    reason: string,
    actorId: Types.ObjectId,
  ): Promise<ClinicDocument> {
    return executeInTransaction(this.connection, async (session) => {
      const updated = await this.clinicModel.findOneAndUpdate(
        { _id: clinicId, status: ClinicStatus.SUSPENDED },
        { $set: { status: ClinicStatus.ACTIVE } },
        { session, new: true },
      )

      if (!updated) {
        throw new ConflictException(
          "Clinic cannot be reactivated; it is not currently suspended.",
        )
      }

      await this.auditService.logEvent(
        {
          clinicId,
          actorDoctorId: actorId,
          action: ClinicAuditAction.CLINIC_REACTIVATED,
          reason,
        },
        session,
      )

      return updated
    })
  }

  /**
   * Permanently archives a clinic (Owner only, terminal state).
   */
  async archiveClinic(
    clinicId: Types.ObjectId,
    reason: string,
    actorId: Types.ObjectId,
  ): Promise<ClinicDocument> {
    const now = new Date()
    const retentionExpiry = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000)

    return executeInTransaction(this.connection, async (session) => {
      const updated = await this.clinicModel.findOneAndUpdate(
        {
          _id: clinicId,
          status: { $in: [ClinicStatus.ACTIVE, ClinicStatus.SUSPENDED] },
        },
        { $set: { status: ClinicStatus.ARCHIVED } },
        { session, new: true },
      )

      if (!updated) {
        throw new ConflictException(
          "Clinic cannot be archived; it may already be archived.",
        )
      }

      // Cancel all pending invitations
      const cancelInvResult = await this.invitationModel.updateMany(
        { clinicId, status: ClinicInvitationStatus.PENDING },
        {
          $set: {
            status: ClinicInvitationStatus.CANCELLED,
            respondedAt: now,
            retentionExpiresAt: retentionExpiry,
          },
        },
        { session },
      )

      // Cancel all pending or processing outbox jobs
      await this.outboxModel.updateMany(
        {
          clinicId,
          status: { $in: [OutboxStatus.PENDING, OutboxStatus.PROCESSING] },
        },
        {
          $set: {
            status: OutboxStatus.CANCELLED,
            encryptedPayload: null,
            iv: null,
            authTag: null,
            errorSummary: "Clinic archived; delivery cancelled",
          },
        },
        { session },
      )

      await this.auditService.logEvent(
        {
          clinicId,
          actorDoctorId: actorId,
          action: ClinicAuditAction.CLINIC_ARCHIVED,
          reason,
          metadata: {
            cancelledInvitationsCount: cancelInvResult.modifiedCount,
          },
        },
        session,
      )

      return updated
    })
  }

  /**
   * Lists active members of a clinic.
   */
  async listMembers(clinicId: Types.ObjectId): Promise<any[]> {
    const members = await this.membershipModel
      .find({
        clinicId,
        status: ClinicMembershipStatus.ACTIVE,
      })
      .populate("doctorId", "firstName lastName email phone")
      .lean()

    return members.map((m: any) => ({
      id: m._id.toString(),
      doctorId: m.doctorId?._id?.toString(),
      doctor: m.doctorId
        ? {
            firstName: m.doctorId.firstName,
            lastName: m.doctorId.lastName,
            email: m.doctorId.email,
            phone: m.doctorId.phone,
          }
        : null,
      role: m.role,
      joinedAt: m.joinedAt,
    }))
  }

  /**
   * Invites a new doctor or staff member to the clinic.
   * Restricts role to DOCTOR or STAFF (OWNER invitations strictly rejected).
   */
  async inviteMember(
    clinicId: Types.ObjectId,
    actor: DoctorDocument,
    dto: InviteMemberDto,
  ): Promise<any> {
    if (
      dto.role as any === ClinicRole.OWNER ||
      !["DOCTOR", "STAFF"].includes(dto.role)
    ) {
      throw new BadRequestException(
        "Invitations cannot grant OWNER privileges. Ownership can only be transferred.",
      )
    }

    const inviteeEmail = dto.inviteeEmail.toLowerCase().trim()
    const now = new Date()

    const clinic = await this.clinicModel.findById(clinicId)
    if (!clinic || clinic.status !== ClinicStatus.ACTIVE) {
      throw new BadRequestException("Clinic is not active for invitations.")
    }

    // Check if invitee is already an active member
    const existingDoctor = await this.doctorModel.findOne({
      email: inviteeEmail,
    })
    if (existingDoctor) {
      const existingMembership = await this.membershipModel.findOne({
        clinicId,
        doctorId: existingDoctor._id,
        status: ClinicMembershipStatus.ACTIVE,
      })
      if (existingMembership) {
        throw new ConflictException(
          "Doctor is already an active member of this clinic.",
        )
      }
    }

    // Concurrency-safe transition of expired pending invites
    const existingPending = await this.invitationModel.findOne({
      clinicId,
      inviteeEmail,
      status: ClinicInvitationStatus.PENDING,
    })

    if (existingPending) {
      if (existingPending.expiresAt > now) {
        throw new ConflictException(
          "An active invitation for this email is already pending.",
        )
      }
      // Expired: atomically transition to EXPIRED
      await this.invitationModel.findOneAndUpdate(
        {
          _id: existingPending._id,
          status: ClinicInvitationStatus.PENDING,
          expiresAt: { $lte: now },
        },
        {
          $set: {
            status: ClinicInvitationStatus.EXPIRED,
            respondedAt: now,
            retentionExpiresAt: new Date(now.getTime() + 90 * 86400 * 1000),
          },
        },
      )
    }

    // Cryptographic token generation
    const rawToken = crypto.randomBytes(32).toString("hex")
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex")
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000) // 7 days

    // Encrypt payload for Outbox
    const encrypted = this.outboxService.encryptPayload({
      rawToken,
      recipientEmail: inviteeEmail,
      clinicName: clinic.name,
      role: dto.role,
    })

    const correlationId = crypto.randomUUID()

    // Atomic insert of Invitation, Outbox, and Audit Log
    const { invitation, outboxJob } = await executeInTransaction(
      this.connection,
      async (session) => {
        const invs = await this.invitationModel.create(
          [
            {
              clinicId,
              inviteeEmail,
              role: dto.role,
              status: ClinicInvitationStatus.PENDING,
              invitedBy: actor._id,
              invitationTokenHash: tokenHash,
              expiresAt,
              retentionExpiresAt: null,
            },
          ],
          { session },
        )
        const inv = invs[0]

        const outboxDocs = await this.outboxModel.create(
          [
            {
              invitationId: inv._id,
              clinicId,
              recipientEmail: inviteeEmail,
              status: OutboxStatus.PENDING,
              encryptedPayload: encrypted.encryptedPayload,
              iv: encrypted.iv,
              authTag: encrypted.authTag,
              attempts: 0,
              maxAttempts: 3,
              nextAttemptAt: now,
              correlationId,
            },
          ],
          { session },
        )
        const outbox = outboxDocs[0]

        await this.auditService.logEvent(
          {
            clinicId,
            actorDoctorId: actor._id,
            action: ClinicAuditAction.MEMBER_INVITED,
            targetEmail: inviteeEmail,
            role: dto.role,
            metadata: {
              invitationId: inv._id.toString(),
            },
          },
          session,
        )

        return { invitation: inv, outboxJob: outbox }
      },
    )

    // Asynchronously dispatch the email delivery outside the transaction
    this.outboxService.dispatchJob(outboxJob._id).catch((err) => {
      this.logger.error(
        `[${correlationId}] Background outbox dispatch encountered error: ${err?.message}`,
      )
    })

    // Sanitized response (zero tokens or hashes exposed)
    return {
      id: invitation._id.toString(),
      clinicId: clinicId.toString(),
      inviteeEmail,
      role: dto.role,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
      createdAt: invitation.createdAt,
    }
  }

  /**
   * Lists pending invitations for the authenticated doctor's normalized email.
   * Zero raw tokens or token hashes are ever returned.
   */
  async listDoctorInvitations(doctorEmail: string): Promise<any[]> {
    const normalizedEmail = doctorEmail.toLowerCase().trim()
    const invitations = await this.invitationModel
      .find({
        inviteeEmail: normalizedEmail,
        status: ClinicInvitationStatus.PENDING,
        expiresAt: { $gt: new Date() },
      })
      .populate("clinicId", "name slug email phone address")
      .populate("invitedBy", "firstName lastName email")
      .sort({ createdAt: -1 })
      .lean()

    return invitations.map((inv: any) => ({
      id: inv._id.toString(),
      clinic: inv.clinicId
        ? {
            id: inv.clinicId._id.toString(),
            name: inv.clinicId.name,
            slug: inv.clinicId.slug,
            email: inv.clinicId.email,
            phone: inv.clinicId.phone,
          }
        : null,
      role: inv.role,
      invitedBy: inv.invitedBy
        ? {
            id: inv.invitedBy._id.toString(),
            name: `Dr. ${inv.invitedBy.firstName} ${inv.invitedBy.lastName}`,
          }
        : null,
      createdAt: inv.createdAt,
      expiresAt: inv.expiresAt,
    }))
  }

  /**
   * Accepts an invitation atomically with strict identity verification.
   */
  async acceptInvitation(
    rawToken: string,
    authenticatedDoctor: DoctorDocument,
  ): Promise<any> {
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex")
    const now = new Date()

    return executeInTransaction(this.connection, async (session) => {
      // 1. Atomically claim invitation
      const invitation = await this.invitationModel.findOneAndUpdate(
        {
          invitationTokenHash: tokenHash,
          status: ClinicInvitationStatus.PENDING,
          expiresAt: { $gt: now },
        },
        {
          $set: {
            status: ClinicInvitationStatus.ACCEPTED,
            respondedAt: now,
            respondedByDoctorId: authenticatedDoctor._id,
            retentionExpiresAt: null, // Indefinite audit trail
          },
        },
        { session, new: true },
      )

      if (!invitation) {
        throw new NotFoundException(
          "Invitation is invalid, expired, or already used.",
        )
      }

      // 2. Strict recipient identity verification
      if (
        authenticatedDoctor.email.toLowerCase().trim() !==
        invitation.inviteeEmail.toLowerCase().trim()
      ) {
        throw new ForbiddenException(
          "This invitation was sent to a different email address.",
        )
      }

      // 3. Verify target clinic status
      const clinic = await this.clinicModel
        .findById(invitation.clinicId)
        .session(session)

      if (!clinic || clinic.status !== ClinicStatus.ACTIVE) {
        throw new ForbiddenException("Clinic is not currently active.")
      }

      // 4. Historical membership validation
      const existingMembership = await this.membershipModel
        .findOne({
          clinicId: invitation.clinicId,
          doctorId: authenticatedDoctor._id,
        })
        .session(session)

      if (existingMembership) {
        if (existingMembership.status === ClinicMembershipStatus.ACTIVE) {
          throw new ConflictException(
            "Doctor is already an active member of this clinic.",
          )
        }
        if (existingMembership.status === ClinicMembershipStatus.SUSPENDED) {
          throw new ForbiddenException(
            "Doctor membership is suspended. Contact clinic owner for reactivation.",
          )
        }
        if (existingMembership.status === ClinicMembershipStatus.REVOKED) {
          if (
            existingMembership.revokedAt &&
            invitation.createdAt &&
            invitation.createdAt <= existingMembership.revokedAt
          ) {
            throw new ForbiddenException(
              "Invitation is invalid: membership was revoked after this invitation was issued.",
            )
          }
          // Valid re-authorization: reactivate membership
          await this.membershipModel.findOneAndUpdate(
            { _id: existingMembership._id },
            {
              $set: {
                role: invitation.role as ClinicRole,
                status: ClinicMembershipStatus.ACTIVE,
                joinedAt: now,
                revokedAt: null,
                revokedBy: null,
              },
            },
            { session, new: true },
          )
        }
      } else {
        // Create brand new active membership
        await this.membershipModel.create(
          [
            {
              clinicId: invitation.clinicId,
              doctorId: authenticatedDoctor._id,
              role: invitation.role as ClinicRole,
              status: ClinicMembershipStatus.ACTIVE,
              invitedBy: invitation.invitedBy,
              joinedAt: now,
            },
          ],
          { session },
        )
      }

      // 5. Cancel any lingering outbox delivery jobs
      await this.outboxModel.updateMany(
        {
          invitationId: invitation._id,
          status: { $in: [OutboxStatus.PENDING, OutboxStatus.PROCESSING] },
        },
        {
          $set: {
            status: OutboxStatus.CANCELLED,
            encryptedPayload: null,
            iv: null,
            authTag: null,
            errorSummary:
              "Invitation accepted by recipient; delivery cancelled",
          },
        },
        { session },
      )

      // 6. Record audit log
      await this.auditService.logEvent(
        {
          clinicId: invitation.clinicId,
          actorDoctorId: authenticatedDoctor._id,
          action: ClinicAuditAction.MEMBER_INVITATION_ACCEPTED,
          role: invitation.role,
          metadata: {
            invitationId: invitation._id?.toString(),
          },
        },
        session,
      )

      return {
        message: "Invitation accepted successfully.",
        clinicId: invitation.clinicId.toString(),
        role: invitation.role,
      }
    })
  }

  /**
   * Declines an invitation atomically.
   */
  async declineInvitation(
    rawToken: string,
    authenticatedDoctor: DoctorDocument,
  ): Promise<any> {
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex")
    const now = new Date()

    return executeInTransaction(this.connection, async (session) => {
      const invitation = await this.invitationModel
        .findOne({
          invitationTokenHash: tokenHash,
          expiresAt: { $gt: now },
        })
        .session(session)

      if (!invitation) {
        throw new NotFoundException(
          "Invitation is invalid, expired, or already used.",
        )
      }

      if (
        authenticatedDoctor.email.toLowerCase().trim() !==
        invitation.inviteeEmail.toLowerCase().trim()
      ) {
        throw new ForbiddenException(
          "This invitation was sent to a different email address.",
        )
      }

      const declined = await this.invitationModel.findOneAndUpdate(
        {
          _id: invitation._id,
          status: ClinicInvitationStatus.PENDING,
        },
        {
          $set: {
            status: ClinicInvitationStatus.DECLINED,
            respondedAt: now,
            respondedByDoctorId: authenticatedDoctor._id,
            retentionExpiresAt: new Date(now.getTime() + 90 * 86400 * 1000),
          },
        },
        { session, new: true },
      )

      if (!declined) {
        throw new NotFoundException(
          "Invitation is no longer pending or has already been responded to.",
        )
      }

      await this.outboxModel.updateMany(
        {
          invitationId: invitation._id,
          status: { $in: [OutboxStatus.PENDING, OutboxStatus.PROCESSING] },
        },
        {
          $set: {
            status: OutboxStatus.CANCELLED,
            encryptedPayload: null,
            iv: null,
            authTag: null,
            errorSummary:
              "Invitation declined by recipient; delivery cancelled",
          },
        },
        { session },
      )

      await this.auditService.logEvent(
        {
          clinicId: invitation.clinicId,
          actorDoctorId: authenticatedDoctor._id,
          action: ClinicAuditAction.MEMBER_INVITATION_DECLINED,
          metadata: {
            invitationId: invitation._id?.toString(),
          },
        },
        session,
      )

      return { message: "Invitation declined successfully." }
    })
  }

  /**
   * Cancels a pending invitation (Clinic Admin/Owner).
   */
  async cancelInvitation(
    clinicId: Types.ObjectId,
    invitationId: Types.ObjectId,
    actorId: Types.ObjectId,
  ): Promise<any> {
    const now = new Date()

    return executeInTransaction(this.connection, async (session) => {
      const invitation = await this.invitationModel.findOneAndUpdate(
        {
          _id: invitationId,
          clinicId,
          status: ClinicInvitationStatus.PENDING,
        },
        {
          $set: {
            status: ClinicInvitationStatus.CANCELLED,
            respondedAt: now,
            retentionExpiresAt: new Date(now.getTime() + 90 * 86400 * 1000),
          },
        },
        { session, new: true },
      )

      if (!invitation) {
        throw new NotFoundException(
          "Pending invitation not found for cancellation.",
        )
      }

      await this.outboxModel.updateMany(
        {
          invitationId,
          status: { $in: [OutboxStatus.PENDING, OutboxStatus.PROCESSING] },
        },
        {
          $set: {
            status: OutboxStatus.CANCELLED,
            encryptedPayload: null,
            iv: null,
            authTag: null,
            errorSummary: "Invitation cancelled by clinic administrator",
          },
        },
        { session },
      )

      await this.auditService.logEvent(
        {
          clinicId,
          actorDoctorId: actorId,
          action: ClinicAuditAction.MEMBER_INVITATION_CANCELLED,
          targetEmail: invitation.inviteeEmail,
          metadata: {
            invitationId: invitation._id.toString(),
          },
        },
        session,
      )

      return { message: "Invitation cancelled successfully." }
    })
  }

  /**
   * Revokes an active member's clinic membership (Blocks OWNER revocation).
   */
  async revokeMember(
    clinicId: Types.ObjectId,
    targetDoctorId: Types.ObjectId,
    actorId: Types.ObjectId,
  ): Promise<any> {
    const now = new Date()

    return executeInTransaction(this.connection, async (session) => {
      const membership = await this.membershipModel
        .findOne({
          clinicId,
          doctorId: targetDoctorId,
          status: ClinicMembershipStatus.ACTIVE,
        })
        .session(session)

      if (!membership) {
        throw new NotFoundException("Active clinic membership not found.")
      }

      if (membership.role === ClinicRole.OWNER) {
        throw new BadRequestException(
          "Cannot revoke clinic owner. Ownership must be transferred first.",
        )
      }

      membership.status = ClinicMembershipStatus.REVOKED
      membership.revokedAt = now
      membership.revokedBy = actorId
      await membership.save({ session })

      await this.auditService.logEvent(
        {
          clinicId,
          actorDoctorId: actorId,
          action: ClinicAuditAction.MEMBER_REVOKED,
          targetDoctorId,
          role: membership.role,
        },
        session,
      )

      return { message: "Member revoked successfully." }
    })
  }

  /**
   * Atomically transfers clinic ownership to an active member.
   */
  async transferOwnership(
    clinicId: Types.ObjectId,
    currentOwnerDoctorId: Types.ObjectId,
    newOwnerDoctorId: Types.ObjectId,
  ): Promise<any> {
    if (currentOwnerDoctorId.toString() === newOwnerDoctorId.toString()) {
      throw new BadRequestException(
        "Target doctor is already the current owner of this clinic.",
      )
    }

    return executeInTransaction(this.connection, async (session) => {
      // 1. Verify target doctor has an active membership
      const targetMembership = await this.membershipModel
        .findOne({
          clinicId,
          doctorId: newOwnerDoctorId,
          status: ClinicMembershipStatus.ACTIVE,
        })
        .session(session)

      if (!targetMembership) {
        throw new BadRequestException(
          "Target doctor is not an active member of this clinic.",
        )
      }

      // 2. Conditional clinic owner update
      const updatedClinic = await this.clinicModel.findOneAndUpdate(
        {
          _id: clinicId,
          ownerDoctorId: currentOwnerDoctorId,
          status: ClinicStatus.ACTIVE,
        },
        { $set: { ownerDoctorId: newOwnerDoctorId } },
        { session, new: true },
      )

      if (!updatedClinic) {
        throw new ConflictException(
          "Ownership transfer failed: Clinic status or current owner modified concurrently.",
        )
      }

      // 3. Demote current owner
      const demoted = await this.membershipModel.findOneAndUpdate(
        {
          clinicId,
          doctorId: currentOwnerDoctorId,
          role: ClinicRole.OWNER,
          status: ClinicMembershipStatus.ACTIVE,
        },
        { $set: { role: ClinicRole.DOCTOR } },
        { session, new: true },
      )

      if (!demoted) {
        throw new ConflictException(
          "Ownership transfer failed: Current owner membership could not be updated.",
        )
      }

      // 4. Promote target member
      const promoted = await this.membershipModel.findOneAndUpdate(
        {
          clinicId,
          doctorId: newOwnerDoctorId,
          status: ClinicMembershipStatus.ACTIVE,
        },
        { $set: { role: ClinicRole.OWNER } },
        { session, new: true },
      )

      if (!promoted) {
        throw new ConflictException(
          "Ownership transfer failed: Target member could not be promoted.",
        )
      }

      // 5. Append audit log
      await this.auditService.logEvent(
        {
          clinicId,
          actorDoctorId: currentOwnerDoctorId,
          action: ClinicAuditAction.OWNERSHIP_TRANSFERRED,
          targetDoctorId: newOwnerDoctorId,
          metadata: {
            previousOwnerDoctorId: currentOwnerDoctorId.toString(),
            newOwnerDoctorId: newOwnerDoctorId.toString(),
          },
        },
        session,
      )

      return {
        message: "Clinic ownership transferred successfully.",
        clinicId: clinicId.toString(),
        newOwnerDoctorId: newOwnerDoctorId.toString(),
      }
    })
  }
}
