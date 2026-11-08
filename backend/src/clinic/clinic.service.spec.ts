import { describe, it, expect, beforeEach, vi } from "vitest"
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
} from "@nestjs/common"
import { Types } from "mongoose"
import { ClinicService } from "./clinic.service.js"
import { ClinicStatus } from "./schemas/clinic.schema.js"
import {
  ClinicRole,
  ClinicMembershipStatus,
} from "./schemas/clinic-membership.schema.js"
import { ClinicInvitationStatus } from "./schemas/clinic-invitation.schema.js"
import { ClinicAuditAction } from "./schemas/clinic-audit-log.schema.js"
import { executeInTransaction } from "../database/transaction.helper.js"

describe("ClinicService & Domain Security (Unit)", () => {
  let clinicService: ClinicService
  let mockConnection: any
  let mockSession: any
  let mockClinicModel: any
  let mockMembershipModel: any
  let mockInvitationModel: any
  let mockOutboxModel: any
  let mockDoctorModel: any
  let mockAuditService: any
  let mockOutboxService: any

  const mockDoctor: any = {
    _id: new Types.ObjectId(),
    email: "doctor@example.com",
    firstName: "Jane",
    lastName: "Doe",
  }

  beforeEach(() => {
    mockSession = {
      startTransaction: vi.fn(),
      commitTransaction: vi.fn().mockResolvedValue(undefined),
      abortTransaction: vi.fn().mockResolvedValue(undefined),
      endSession: vi.fn().mockResolvedValue(undefined),
      inTransaction: vi.fn().mockReturnValue(true),
    }

    mockConnection = {
      startSession: vi.fn().mockResolvedValue(mockSession),
    }

    mockClinicModel = {
      findOne: vi.fn().mockReturnValue({
        session: vi.fn().mockResolvedValue(null),
      }),
      findById: vi.fn().mockResolvedValue({
        _id: new Types.ObjectId(),
        name: "Test Clinic",
        slug: "test-clinic",
        status: ClinicStatus.ACTIVE,
      }),
      create: vi.fn().mockImplementation((docs) =>
        Promise.resolve(
          docs.map((d: any) => ({
            _id: new Types.ObjectId(),
            ...d,
          })),
        ),
      ),
      findOneAndUpdate: vi.fn(),
    }

    mockMembershipModel = {
      findOne: vi.fn().mockReturnValue({
        session: vi.fn().mockResolvedValue(null),
      }),
      find: vi.fn().mockReturnValue({
        populate: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([]),
        }),
      }),
      create: vi.fn().mockImplementation((docs) =>
        Promise.resolve(
          docs.map((d: any) => ({
            _id: new Types.ObjectId(),
            ...d,
          })),
        ),
      ),
      findOneAndUpdate: vi.fn(),
    }

    mockInvitationModel = {
      findOne: vi.fn().mockResolvedValue(null),
      find: vi.fn().mockReturnValue({
        populate: vi.fn().mockReturnValue({
          populate: vi.fn().mockReturnValue({
            sort: vi.fn().mockReturnValue({
              lean: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }),
      create: vi.fn().mockImplementation((docs) =>
        Promise.resolve(
          docs.map((d: any) => ({
            _id: new Types.ObjectId(),
            ...d,
          })),
        ),
      ),
      findOneAndUpdate: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    }

    mockOutboxModel = {
      create: vi.fn().mockImplementation((docs) =>
        Promise.resolve(
          docs.map((d: any) => ({
            _id: new Types.ObjectId(),
            ...d,
          })),
        ),
      ),
      findOneAndUpdate: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    }

    mockDoctorModel = {
      findOne: vi.fn().mockResolvedValue(null),
      findById: vi.fn().mockResolvedValue(mockDoctor),
    }

    mockAuditService = {
      logEvent: vi.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
      listClinicAuditLogs: vi.fn().mockResolvedValue({ logs: [], total: 0 }),
    }

    mockOutboxService = {
      encryptPayload: vi.fn().mockReturnValue({
        encryptedPayload: "deadbeef",
        iv: "0102030405060708090a0b0c",
        authTag: "11223344556677889900aabbccddeeff",
      }),
      decryptPayload: vi.fn(),
      dispatchJob: vi.fn().mockResolvedValue(true),
    }

    clinicService = new ClinicService(
      mockConnection,
      mockClinicModel,
      mockMembershipModel,
      mockInvitationModel,
      mockOutboxModel,
      mockDoctorModel,
      mockAuditService,
      mockOutboxService,
    )
  })

  describe("Clinic Creation", () => {
    it("creates clinic and assigns creator as OWNER atomically", async () => {
      const dto = {
        name: "Care First Medical",
        slug: "care-first-medical",
        phone: "1234567890",
        email: "care@example.com",
        address: {
          street: "123 Main St",
          city: "Metropolis",
          state: "NY",
          postalCode: "10001",
          country: "USA",
        },
      }

      const result = await clinicService.createClinicWithMembership(
        mockDoctor,
        dto,
      )

      expect(mockClinicModel.create).toHaveBeenCalled()
      expect(mockMembershipModel.create).toHaveBeenCalled()
      expect(mockAuditService.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: ClinicAuditAction.CLINIC_CREATED,
        }),
        expect.anything(),
      )
      expect(result.membership.role).toBe(ClinicRole.OWNER)
      expect(mockSession.commitTransaction).toHaveBeenCalled()
      expect(mockSession.endSession).toHaveBeenCalled()
    })

    it("rejects clinic creation when slug already exists", async () => {
      mockClinicModel.findOne.mockReturnValue({
        session: vi.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
      })

      const dto = {
        name: "Care First Medical",
        slug: "care-first-medical",
        phone: "1234567890",
        email: "care@example.com",
        address: {
          street: "123 Main St",
          city: "Metropolis",
          state: "NY",
          postalCode: "10001",
          country: "USA",
        },
      }

      await expect(
        clinicService.createClinicWithMembership(mockDoctor, dto),
      ).rejects.toThrow(ConflictException)

      expect(mockSession.abortTransaction).toHaveBeenCalled()
      expect(mockSession.endSession).toHaveBeenCalled()
    })
  })

  describe("Role Escalation Block", () => {
    it("strictly forbids inviting member with OWNER role", async () => {
      const clinicId = new Types.ObjectId()
      const dto: any = {
        inviteeEmail: "newdoc@example.com",
        role: "OWNER",
      }

      await expect(
        clinicService.inviteMember(clinicId, mockDoctor, dto),
      ).rejects.toThrow(BadRequestException)
    })

    it("strictly forbids inviting member with unrecognized role", async () => {
      const clinicId = new Types.ObjectId()
      const dto: any = {
        inviteeEmail: "newdoc@example.com",
        role: "SUPERADMIN",
      }

      await expect(
        clinicService.inviteMember(clinicId, mockDoctor, dto),
      ).rejects.toThrow(BadRequestException)
    })
  })

  describe("Single-Owner Invariant & Transfer", () => {
    it("blocks revoking clinic owner", async () => {
      const clinicId = new Types.ObjectId()
      const ownerId = new Types.ObjectId()

      mockMembershipModel.findOne.mockReturnValue({
        session: vi.fn().mockResolvedValue({
          role: ClinicRole.OWNER,
          status: ClinicMembershipStatus.ACTIVE,
        }),
      })

      await expect(
        clinicService.revokeMember(clinicId, ownerId, mockDoctor._id),
      ).rejects.toThrow(BadRequestException)
    })

    it("atomically transfers ownership and demotes previous owner to DOCTOR", async () => {
      const clinicId = new Types.ObjectId()
      const currentOwnerId = mockDoctor._id
      const targetDoctorId = new Types.ObjectId()

      mockMembershipModel.findOne.mockReturnValue({
        session: vi.fn().mockResolvedValue({
          doctorId: targetDoctorId,
          role: ClinicRole.DOCTOR,
          status: ClinicMembershipStatus.ACTIVE,
        }),
      })

      mockClinicModel.findOneAndUpdate.mockResolvedValue({
        _id: clinicId,
        ownerDoctorId: targetDoctorId,
      })

      mockMembershipModel.findOneAndUpdate
        .mockResolvedValueOnce({
          doctorId: currentOwnerId,
          role: ClinicRole.DOCTOR,
        })
        .mockResolvedValueOnce({
          doctorId: targetDoctorId,
          role: ClinicRole.OWNER,
        })

      const result = await clinicService.transferOwnership(
        clinicId,
        currentOwnerId,
        targetDoctorId,
      )

      expect(result.newOwnerDoctorId).toBe(targetDoctorId.toString())
      expect(mockClinicModel.findOneAndUpdate).toHaveBeenCalledWith(
        {
          _id: clinicId,
          ownerDoctorId: currentOwnerId,
          status: ClinicStatus.ACTIVE,
        },
        { $set: { ownerDoctorId: targetDoctorId } },
        expect.anything(),
      )
      expect(mockAuditService.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: ClinicAuditAction.OWNERSHIP_TRANSFERRED,
        }),
        expect.anything(),
      )
      expect(mockSession.commitTransaction).toHaveBeenCalled()
    })

    it("rejects ownership transfer if target doctor is not an active clinic member", async () => {
      const clinicId = new Types.ObjectId()
      const targetDoctorId = new Types.ObjectId()

      mockMembershipModel.findOne.mockReturnValue({
        session: vi.fn().mockResolvedValue(null),
      })

      await expect(
        clinicService.transferOwnership(
          clinicId,
          mockDoctor._id,
          targetDoctorId,
        ),
      ).rejects.toThrow(BadRequestException)
    })
  })

  describe("Historical Membership Acceptance Rules", () => {
    it("rejects invitation acceptance if recipient is already an active member", async () => {
      const rawToken = "0123456789abcdef0123456789abcdef"
      const clinicId = new Types.ObjectId()

      mockInvitationModel.findOneAndUpdate.mockResolvedValue({
        clinicId,
        inviteeEmail: mockDoctor.email,
        role: "DOCTOR",
        status: ClinicInvitationStatus.ACCEPTED,
      })

      mockClinicModel.findById.mockReturnValue({
        session: vi.fn().mockResolvedValue({
          status: ClinicStatus.ACTIVE,
        }),
      })

      mockMembershipModel.findOne.mockReturnValue({
        session: vi.fn().mockResolvedValue({
          status: ClinicMembershipStatus.ACTIVE,
        }),
      })

      await expect(
        clinicService.acceptInvitation(rawToken, mockDoctor),
      ).rejects.toThrow(ConflictException)
    })

    it("rejects invitation acceptance if recipient membership is suspended", async () => {
      const rawToken = "0123456789abcdef0123456789abcdef"
      const clinicId = new Types.ObjectId()

      mockInvitationModel.findOneAndUpdate.mockResolvedValue({
        clinicId,
        inviteeEmail: mockDoctor.email,
        role: "DOCTOR",
        status: ClinicInvitationStatus.ACCEPTED,
      })

      mockClinicModel.findById.mockReturnValue({
        session: vi.fn().mockResolvedValue({
          status: ClinicStatus.ACTIVE,
        }),
      })

      mockMembershipModel.findOne.mockReturnValue({
        session: vi.fn().mockResolvedValue({
          status: ClinicMembershipStatus.SUSPENDED,
        }),
      })

      await expect(
        clinicService.acceptInvitation(rawToken, mockDoctor),
      ).rejects.toThrow(ForbiddenException)
    })

    it("rejects stale invitation issued prior to member revocation", async () => {
      const rawToken = "0123456789abcdef0123456789abcdef"
      const clinicId = new Types.ObjectId()
      const revokedAt = new Date("2026-10-20T12:00:00Z")
      const invitationCreatedAt = new Date("2026-10-18T12:00:00Z") // Issued BEFORE revocation

      mockInvitationModel.findOneAndUpdate.mockResolvedValue({
        clinicId,
        inviteeEmail: mockDoctor.email,
        role: "DOCTOR",
        status: ClinicInvitationStatus.ACCEPTED,
        createdAt: invitationCreatedAt,
      })

      mockClinicModel.findById.mockReturnValue({
        session: vi.fn().mockResolvedValue({
          status: ClinicStatus.ACTIVE,
        }),
      })

      mockMembershipModel.findOne.mockReturnValue({
        session: vi.fn().mockResolvedValue({
          status: ClinicMembershipStatus.REVOKED,
          revokedAt,
        }),
      })

      await expect(
        clinicService.acceptInvitation(rawToken, mockDoctor),
      ).rejects.toThrow(ForbiddenException)
    })

    it("allows valid re-authorization invitation issued after member revocation", async () => {
      const rawToken = "0123456789abcdef0123456789abcdef"
      const clinicId = new Types.ObjectId()
      const revokedAt = new Date("2026-10-20T12:00:00Z")
      const invitationCreatedAt = new Date("2026-10-22T12:00:00Z") // Issued AFTER revocation

      mockInvitationModel.findOneAndUpdate.mockResolvedValue({
        _id: new Types.ObjectId(),
        clinicId,
        inviteeEmail: mockDoctor.email,
        role: "DOCTOR",
        status: ClinicInvitationStatus.ACCEPTED,
        createdAt: invitationCreatedAt,
      })

      mockClinicModel.findById.mockReturnValue({
        session: vi.fn().mockResolvedValue({
          status: ClinicStatus.ACTIVE,
        }),
      })

      mockMembershipModel.findOne.mockReturnValue({
        session: vi.fn().mockResolvedValue({
          _id: new Types.ObjectId(),
          status: ClinicMembershipStatus.REVOKED,
          revokedAt,
        }),
      })

      mockMembershipModel.findOneAndUpdate.mockResolvedValue({
        status: ClinicMembershipStatus.ACTIVE,
      })

      mockOutboxModel.updateMany.mockResolvedValue({ modifiedCount: 1 })

      const result = await clinicService.acceptInvitation(rawToken, mockDoctor)
      expect(result.message).toContain("Invitation accepted successfully")
      expect(mockMembershipModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          $set: expect.objectContaining({
            status: ClinicMembershipStatus.ACTIVE,
          }),
        }),
        expect.anything(),
      )
    })

    it("rejects invitation acceptance when recipient email does not match", async () => {
      const rawToken = "0123456789abcdef0123456789abcdef"

      mockInvitationModel.findOneAndUpdate.mockResolvedValue({
        clinicId: new Types.ObjectId(),
        inviteeEmail: "someoneelse@example.com",
        role: "DOCTOR",
        status: ClinicInvitationStatus.ACCEPTED,
      })

      await expect(
        clinicService.acceptInvitation(rawToken, mockDoctor),
      ).rejects.toThrow(ForbiddenException)
    })
  })

  describe("Clinic Lifecycle State Machine", () => {
    it("suspends active clinic and records audit reason", async () => {
      const clinicId = new Types.ObjectId()
      const reason = "Administrative compliance review pending"

      mockClinicModel.findOneAndUpdate.mockResolvedValue({
        _id: clinicId,
        status: ClinicStatus.SUSPENDED,
      })

      const updated = await clinicService.suspendClinic(
        clinicId,
        reason,
        mockDoctor._id,
      )
      expect(updated.status).toBe(ClinicStatus.SUSPENDED)
      expect(mockAuditService.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: ClinicAuditAction.CLINIC_SUSPENDED,
          reason,
        }),
        expect.anything(),
      )
    })

    it("reactivates suspended clinic", async () => {
      const clinicId = new Types.ObjectId()
      const reason = "Compliance review completed and approved"

      mockClinicModel.findOneAndUpdate.mockResolvedValue({
        _id: clinicId,
        status: ClinicStatus.ACTIVE,
      })

      const updated = await clinicService.reactivateClinic(
        clinicId,
        reason,
        mockDoctor._id,
      )
      expect(updated.status).toBe(ClinicStatus.ACTIVE)
      expect(mockAuditService.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: ClinicAuditAction.CLINIC_REACTIVATED,
          reason,
        }),
        expect.anything(),
      )
    })

    it("archives clinic and cancels all pending invites and outbox jobs", async () => {
      const clinicId = new Types.ObjectId()
      const reason = "Clinic permanently closing operations"

      mockClinicModel.findOneAndUpdate.mockResolvedValue({
        _id: clinicId,
        status: ClinicStatus.ARCHIVED,
      })

      const updated = await clinicService.archiveClinic(
        clinicId,
        reason,
        mockDoctor._id,
      )
      expect(updated.status).toBe(ClinicStatus.ARCHIVED)
      expect(mockInvitationModel.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          clinicId,
          status: ClinicInvitationStatus.PENDING,
        }),
        expect.anything(),
        expect.anything(),
      )
      expect(mockOutboxModel.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          clinicId,
        }),
        expect.anything(),
        expect.anything(),
      )
      expect(mockAuditService.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: ClinicAuditAction.CLINIC_ARCHIVED,
          reason,
        }),
        expect.anything(),
      )
    })
  })
})

describe("Transaction Helper (executeInTransaction & commitWithRetry)", () => {
  it("preserves known HttpExceptions without wrapping in 500", async () => {
    const mockSession: any = {
      startTransaction: vi.fn(),
      commitTransaction: vi.fn(),
      abortTransaction: vi.fn().mockResolvedValue(undefined),
      endSession: vi.fn().mockResolvedValue(undefined),
      inTransaction: vi.fn().mockReturnValue(true),
    }

    const mockConn: any = {
      startSession: vi.fn().mockResolvedValue(mockSession),
    }

    const forbiddenOp = vi
      .fn()
      .mockRejectedValue(new ForbiddenException("Custom forbidden"))

    await expect(executeInTransaction(mockConn, forbiddenOp)).rejects.toThrow(
      ForbiddenException,
    )

    expect(mockSession.abortTransaction).toHaveBeenCalled()
    expect(mockSession.endSession).toHaveBeenCalled()
  })

  it("retries on TransientTransactionError and succeeds within maxRetries", async () => {
    const mockSession: any = {
      startTransaction: vi.fn(),
      commitTransaction: vi.fn().mockResolvedValue(undefined),
      abortTransaction: vi.fn().mockResolvedValue(undefined),
      endSession: vi.fn().mockResolvedValue(undefined),
      inTransaction: vi.fn().mockReturnValue(true),
    }

    const mockConn: any = {
      startSession: vi.fn().mockResolvedValue(mockSession),
    }

    const transientError: any = new Error("Write conflict")
    transientError.hasErrorLabel = (label: string) =>
      label === "TransientTransactionError"

    let attempts = 0
    const retryOp = vi.fn().mockImplementation(() => {
      attempts++
      if (attempts === 1) throw transientError
      return Promise.resolve("success")
    })

    const result = await executeInTransaction(mockConn, retryOp, {
      maxRetries: 3,
      baseDelayMs: 5,
    })

    expect(result).toBe("success")
    expect(retryOp).toHaveBeenCalledTimes(2)
    expect(mockSession.commitTransaction).toHaveBeenCalledTimes(1)
    expect(mockSession.endSession).toHaveBeenCalled()
  })

  it("retries commitTransaction on UnknownTransactionCommitResult without rerunning operation", async () => {
    let commitAttempts = 0
    const unknownCommitError: any = new Error("Network timeout during commit")
    unknownCommitError.hasErrorLabel = (label: string) =>
      label === "UnknownTransactionCommitResult"

    const mockSession: any = {
      startTransaction: vi.fn(),
      commitTransaction: vi.fn().mockImplementation(() => {
        commitAttempts++
        if (commitAttempts === 1) throw unknownCommitError
        return Promise.resolve()
      }),
      abortTransaction: vi.fn().mockResolvedValue(undefined),
      endSession: vi.fn().mockResolvedValue(undefined),
      inTransaction: vi.fn().mockReturnValue(true),
    }

    const mockConn: any = {
      startSession: vi.fn().mockResolvedValue(mockSession),
    }

    let opCalls = 0
    const businessOp = vi.fn().mockImplementation(() => {
      opCalls++
      return Promise.resolve({ done: true })
    })

    const result = await executeInTransaction(mockConn, businessOp, {
      maxCommitRetries: 3,
      baseDelayMs: 5,
    })

    expect(result).toEqual({ done: true })
    expect(opCalls).toBe(1) // Crucial: operation executed ONLY once!
    expect(commitAttempts).toBe(2) // Commit retried directly
    expect(mockSession.endSession).toHaveBeenCalled()
  })

  it("fails with ambiguous commit error if UnknownTransactionCommitResult exhausted", async () => {
    const unknownCommitError: any = new Error("Network timeout during commit")
    unknownCommitError.hasErrorLabel = (label: string) =>
      label === "UnknownTransactionCommitResult"

    const mockSession: any = {
      startTransaction: vi.fn(),
      commitTransaction: vi.fn().mockRejectedValue(unknownCommitError),
      abortTransaction: vi.fn().mockResolvedValue(undefined),
      endSession: vi.fn().mockResolvedValue(undefined),
      inTransaction: vi.fn().mockReturnValue(true),
    }

    const mockConn: any = {
      startSession: vi.fn().mockResolvedValue(mockSession),
    }

    const businessOp = vi.fn().mockResolvedValue("value")

    await expect(
      executeInTransaction(mockConn, businessOp, {
        maxCommitRetries: 2,
        baseDelayMs: 5,
      }),
    ).rejects.toThrow(InternalServerErrorException)

    expect(businessOp).toHaveBeenCalledTimes(1) // Never rerun!
    expect(mockSession.commitTransaction).toHaveBeenCalledTimes(2)
    expect(mockSession.endSession).toHaveBeenCalled()
  })
})
