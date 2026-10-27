import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnprocessableEntityException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { InjectModel, InjectConnection } from '@nestjs/mongoose';
import type { Connection, ClientSession } from 'mongoose';
import { Model, Types } from 'mongoose';
import { randomUUID, createHash } from 'crypto';
import {
  Prescription,
  PrescriptionDocument,
  PrescriptionStatus,
} from './schemas/prescription.schema.js';
import {
  PrescriptionRevision,
  PrescriptionRevisionDocument,
  PrescriptionClinicalSnapshot,
} from './schemas/prescription-revision.schema.js';
import {
  Consultation,
  ConsultationDocument,
  ConsultationStatus,
} from '../consultation/schemas/consultation.schema.js';
import {
  Patient,
  PatientDocument,
} from '../patient/schemas/patient.schema.js';
import {
  ClinicSequenceCounter,
  ClinicSequenceCounterDocument,
} from '../patient/schemas/clinic-sequence-counter.schema.js';
import {
  ClinicAuditLog,
  ClinicAuditLogDocument,
  ClinicAuditAction,
} from '../clinic/schemas/clinic-audit-log.schema.js';
import {
  IdempotencyRecord,
  IdempotencyRecordDocument,
} from '../common/schemas/idempotency-record.schema.js';
import { ClinicRole } from '../clinic/schemas/clinic-membership.schema.js';
import { executeInTransaction } from '../database/transaction.helper.js';
import { redactString } from '../common/logging/app-logger.service.js';
import { validatePrescriptionItem } from './validators/formulation-route.validator.js';
import type { CreatePrescriptionDto } from './dto/create-prescription.dto.js';
import type { RevisePrescriptionDto } from './dto/revise-prescription.dto.js';
import type { DiscontinuePrescriptionDto } from './dto/discontinue-prescription.dto.js';
import type { CancelPrescriptionDto } from './dto/cancel-prescription.dto.js';
import type { QueryPrescriptionsDto } from './dto/query-prescriptions.dto.js';

export function canonicalJsonStringify(obj: any): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return `[${obj.map((item) => canonicalJsonStringify(item)).join(',')}]`;
  }
  const keys = Object.keys(obj).sort();
  const entries = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalJsonStringify(obj[k])}`,
  );
  return `{${entries.join(',')}}`;
}

export function computeRequestFingerprint(
  httpMethod: string,
  normalizedRoute: string,
  body: any,
): string {
  const canonicalBody = canonicalJsonStringify(body || {});
  const payload = `${httpMethod.toUpperCase()}:${normalizedRoute.trim()}:${canonicalBody}`;
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Narrows E11000 retry predicate to strictly match the clinic_counters unique compound index
 * ({ clinicId: 1, sequenceName: 1 } / uniq_clinic_sequence_counter / clinicId_1_sequenceName_1).
 * Avoids retrying unrelated E11000 errors (such as duplicate patient, prescription or draft errors).
 */
export function isCounterInitializationRace(err: any): boolean {
  if (err?.code !== 11000) return false;

  const hasExactSequenceKeyPattern =
    err?.keyPattern?.clinicId !== undefined &&
    err?.keyPattern?.sequenceName !== undefined;

  const msg = typeof err?.message === 'string' ? err.message : '';
  const isCountersCollectionOrIndex =
    msg.includes('clinic_counters') ||
    msg.includes('clinicId_1_sequenceName_1') ||
    msg.includes('uniq_clinic_sequence_counter');

  return hasExactSequenceKeyPattern && isCountersCollectionOrIndex;
}

/**
 * Derives patient age dynamically using the clinic's local timezone via formatToParts.
 * Falls back to patient.age if dateOfBirth is not populated.
 */
export function computePatientCurrentAge(
  patient: { age: number; dateOfBirth?: Date | null },
  clinicTimezone: string = 'Asia/Kolkata',
  referenceDate: Date = new Date(),
): number {
  if (!patient.dateOfBirth) {
    return patient.age;
  }

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: clinicTimezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  });

  const extractParts = (d: Date) => {
    const parts = formatter.formatToParts(d);
    let year = 0;
    let month = 0;
    let day = 0;
    for (const part of parts) {
      if (part.type === 'year') year = Number(part.value);
      if (part.type === 'month') month = Number(part.value);
      if (part.type === 'day') day = Number(part.value);
    }
    return { year, month, day };
  };

  const refParts = extractParts(referenceDate);
  const dobParts = extractParts(new Date(patient.dateOfBirth));

  let age = refParts.year - dobParts.year;
  if (
    refParts.month < dobParts.month ||
    (refParts.month === dobParts.month && refParts.day < dobParts.day)
  ) {
    age--;
  }

  return Math.max(0, age);
}

@Injectable()
export class PrescriptionService {
  private readonly logger = new Logger(PrescriptionService.name);

  constructor(
    @InjectModel(Prescription.name)
    private readonly prescriptionModel: Model<PrescriptionDocument>,
    @InjectModel(PrescriptionRevision.name)
    private readonly revisionModel: Model<PrescriptionRevisionDocument>,
    @InjectModel(Consultation.name)
    private readonly consultationModel: Model<ConsultationDocument>,
    @InjectModel(Patient.name)
    private readonly patientModel: Model<PatientDocument>,
    @InjectModel(ClinicSequenceCounter.name)
    private readonly counterModel: Model<ClinicSequenceCounterDocument>,
    @InjectModel(ClinicAuditLog.name)
    private readonly auditLogModel: Model<ClinicAuditLogDocument>,
    @InjectModel(IdempotencyRecord.name)
    private readonly idempotencyModel: Model<IdempotencyRecordDocument>,
    @InjectConnection()
    private readonly connection: Connection,
  ) {}

  /**
   * Pre-claims or checks an idempotency lease before transaction execution.
   */
  private async claimIdempotencyLease(
    clinicId: Types.ObjectId,
    key: string,
    httpMethod: string,
    normalizedRoute: string,
    requestFingerprint: string,
  ): Promise<{
    replayed?: boolean;
    responseCode?: number;
    responseBody?: any;
    claimToken: string;
  }> {
    const claimToken = randomUUID();
    const now = new Date();
    const leaseExpiry = new Date(now.getTime() + 60_000); // 60s lease
    const ttlExpiry = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24h TTL

    try {
      await this.idempotencyModel.create({
        clinicId,
        key,
        httpMethod,
        normalizedRoute,
        requestFingerprint,
        status: 'PROCESSING',
        claimToken,
        lockedUntil: leaseExpiry,
        expiresAt: ttlExpiry,
      });
      return { claimToken };
    } catch (err: any) {
      if (err?.code !== 11000) throw err;

      const existing = await this.idempotencyModel.findOne({ clinicId, key });
      if (!existing) {
        throw new InternalServerErrorException(
          'Idempotency record race condition encountered.',
        );
      }

      if (existing.requestFingerprint !== requestFingerprint) {
        throw new UnprocessableEntityException(
          'Idempotency key was previously used with a different HTTP method, route, or request payload.',
        );
      }

      if (existing.status === 'COMPLETED') {
        return {
          replayed: true,
          responseCode: existing.responseCode || 200,
          responseBody: existing.responseBody,
          claimToken: existing.claimToken,
        };
      }

      if (
        existing.status === 'PROCESSING' &&
        existing.lockedUntil &&
        existing.lockedUntil > now
      ) {
        throw new ConflictException({
          statusCode: 409,
          message:
            'A request with this Idempotency-Key is currently in progress.',
          retryAfterSeconds: 2,
        });
      }

      // Expired lease (crash recovery) or retry of FAILED record
      const reclaimed = await this.idempotencyModel.findOneAndUpdate(
        {
          clinicId,
          key,
          $or: [
            { status: 'PROCESSING', lockedUntil: { $lte: now } },
            { status: 'FAILED' },
          ],
        },
        {
          $set: {
            status: 'PROCESSING',
            claimToken,
            lockedUntil: leaseExpiry,
            lastError: null,
          },
          $inc: { recoveryAttempts: 1 },
        },
        { returnDocument: 'after' },
      );

      if (!reclaimed) {
        throw new ConflictException({
          statusCode: 409,
          message:
            'A concurrent retry claimed the processing lease. Please retry shortly.',
          retryAfterSeconds: 2,
        });
      }

      return { claimToken };
    }
  }

  /**
   * Updates idempotency record to FAILED outside an aborted transaction.
   * Conditioned strictly on claimToken to avoid overwriting a newer worker lease.
   */
  private async updateIdempotencyToFailed(
    clinicId: Types.ObjectId,
    key: string,
    claimToken: string,
    errorMessage: string,
  ): Promise<void> {
    const sanitizedMsg = redactString(errorMessage);
    await this.idempotencyModel.updateOne(
      {
        clinicId,
        key: key.trim(),
        claimToken,
        status: 'PROCESSING',
      },
      {
        $set: {
          status: 'FAILED',
          lastError: sanitizedMsg,
          lockedUntil: null,
        },
      },
    );
  }

  /**
   * Generates next sequential prescription number for a clinic (RX-00101, RX-00102, ...).
   * Atomically upserts counter with initial value 101 on first allocation within session.
   */
  async generatePrescriptionNumber(
    clinicId: Types.ObjectId,
    session?: ClientSession,
  ): Promise<string> {
    const updatePipeline = [
      {
        $set: {
          seq: { $ifNull: [{ $add: ['$seq', 1] }, 101] },
          createdAt: { $ifNull: ['$createdAt', '$$NOW'] },
          updatedAt: '$$NOW',
        },
      },
    ];

    const counterDoc = await this.counterModel.findOneAndUpdate(
      { clinicId, sequenceName: 'prescription' },
      updatePipeline,
      {
        upsert: true,
        returnDocument: 'after',
        updatePipeline: true,
        ...(session ? { session } : {}),
      },
    );

    if (
      !counterDoc ||
      typeof counterDoc.seq !== 'number' ||
      !Number.isFinite(counterDoc.seq) ||
      counterDoc.seq < 101
    ) {
      throw new InternalServerErrorException(
        'Failed to allocate valid sequential prescription number from clinic counter.',
      );
    }

    return `RX-${String(counterDoc.seq).padStart(5, '0')}`;
  }

  /**
   * Issues a new prescription or replacement prescription against a finalized consultation.
   */
  async createPrescription(
    clinicId: Types.ObjectId,
    consultationId: string,
    dto: CreatePrescriptionDto,
    actorDoctorId: Types.ObjectId,
    idempotencyKey?: string,
  ): Promise<any> {
    if (!Types.ObjectId.isValid(consultationId)) {
      throw new NotFoundException('Invalid consultation identifier');
    }

    if (!dto.items || dto.items.length === 0) {
      throw new BadRequestException('Prescription must contain at least one medicine item');
    }

    for (const item of dto.items) {
      validatePrescriptionItem(item);
    }

    const consultationObjId = new Types.ObjectId(consultationId);

    let claimToken: string | undefined;
    const normalizedRoute = `/clinics/${clinicId.toString()}/consultations/${consultationId}/prescriptions`;

    if (idempotencyKey && idempotencyKey.trim()) {
      const cleanKey = idempotencyKey.trim();
      const fingerprint = computeRequestFingerprint('POST', normalizedRoute, dto);
      const claim = await this.claimIdempotencyLease(
        clinicId,
        cleanKey,
        'POST',
        normalizedRoute,
        fingerprint,
      );

      if (claim.replayed) {
        return claim.responseBody;
      }
      claimToken = claim.claimToken;
    }

    try {
      return await executeInTransaction(
        this.connection,
        async (session) => {
          // 1. Session-bound read of the Consultation under snapshot read concern
          const consultation = await this.consultationModel
            .findOne({ _id: consultationObjId, clinicId })
            .session(session);

          if (!consultation) {
            throw new NotFoundException('Consultation not found in this clinic');
          }
          if (consultation.status !== ConsultationStatus.FINALIZED) {
            throw new ConflictException(
              'Prescriptions can only be issued for finalized consultations.',
            );
          }

          // 2. Validate Replacement or Initial Invariants
          let oldPrescription: PrescriptionDocument | null = null;
          if (dto.replacesPrescriptionId) {
            if (!Types.ObjectId.isValid(dto.replacesPrescriptionId)) {
              throw new NotFoundException('Invalid replacement prescription identifier');
            }
            const oldId = new Types.ObjectId(dto.replacesPrescriptionId);
            oldPrescription = await this.prescriptionModel
              .findOne({ _id: oldId, clinicId })
              .session(session);

            if (!oldPrescription) {
              throw new NotFoundException('Target prescription to replace was not found in this clinic');
            }
            if (oldPrescription.consultationId.toString() !== consultationObjId.toString()) {
              throw new BadRequestException(
                'The replaced prescription does not belong to this consultation',
              );
            }
            if (
              oldPrescription.status !== PrescriptionStatus.DISCONTINUED &&
              oldPrescription.status !== PrescriptionStatus.CANCELLED
            ) {
              throw new ConflictException(
                `Cannot replace an active prescription (status is '${oldPrescription.status}'). Discontinue or cancel it first.`,
              );
            }
            if (oldPrescription.replacedByPrescriptionId) {
              throw new ConflictException(
                'Target prescription has already been replaced by another prescription',
              );
            }
          } else {
            // Check for existing ACTIVE prescription on this consultation
            const existingActive = await this.prescriptionModel
              .findOne({
                clinicId,
                consultationId: consultationObjId,
                status: PrescriptionStatus.ACTIVE,
              })
              .session(session);

            if (existingActive) {
              throw new ConflictException(
                'An active prescription already exists for this consultation. Use revision or discontinue/cancel first.',
              );
            }
          }

          // 3. In-Session Derivation of Verified Snapshot (All 9 fields)
          const clinicalSnapshot: PrescriptionClinicalSnapshot = {
            consultationId: consultation._id,
            patientId: consultation.patientId,
            patientCode: consultation.patientCode,
            doctorId: consultation.doctorId,
            consultationDate: consultation.consultationDate,
            chiefComplaint: consultation.chiefComplaint,
            diagnosis: consultation.diagnosis,
            vitals: consultation.vitals || {},
            provisionalMedicines: consultation.provisionalMedicines || [],
          };

          // 4. Allocate Prescription Number in Session
          const prescriptionNumber = await this.generatePrescriptionNumber(clinicId, session);
          const newPrescriptionId = new Types.ObjectId();

          // 5. Create Immutable Revision 1
          const [newRevision] = await this.revisionModel.create(
            [
              {
                clinicId,
                prescriptionId: newPrescriptionId,
                consultationId: consultationObjId,
                patientId: consultation.patientId,
                prescribedBy: actorDoctorId,
                revisionNumber: 1,
                reasonForRevision: oldPrescription
                  ? `Replacement for ${oldPrescription.prescriptionNumber}`
                  : 'Initial prescription issuance',
                items: dto.items,
                generalAdvice: dto.generalAdvice?.trim() || null,
                clinicalSnapshot,
              },
            ],
            { session },
          );

          // 6. Create Parent Prescription Document
          const [newPrescription] = await this.prescriptionModel.create(
            [
              {
                _id: newPrescriptionId,
                clinicId,
                patientId: consultation.patientId,
                patientCode: consultation.patientCode,
                consultationId: consultationObjId,
                prescriptionNumber,
                status: PrescriptionStatus.ACTIVE,
                currentRevisionNumber: 1,
                latestRevisionId: newRevision._id,
                prescribedBy: actorDoctorId,
                replacesPrescriptionId: oldPrescription ? oldPrescription._id : null,
                replacedByPrescriptionId: null,
                version: 1,
              },
            ],
            { session },
          );

          // 7. If replacement: verify conditional update on old prescription
          if (oldPrescription) {
            const updatedOld = await this.prescriptionModel.findOneAndUpdate(
              {
                _id: oldPrescription._id,
                clinicId,
                status: {
                  $in: [
                    PrescriptionStatus.DISCONTINUED,
                    PrescriptionStatus.CANCELLED,
                  ],
                },
                replacedByPrescriptionId: null,
                version: oldPrescription.version,
              },
              {
                $set: {
                  replacedByPrescriptionId: newPrescription._id,
                  updatedBy: actorDoctorId,
                },
                $inc: { version: 1 },
              },
              { session },
            );

            if (!updatedOld) {
              throw new ConflictException(
                'Replacement conflict: Target prescription was concurrently modified or replaced by another request',
              );
            }
          }

          // 8. Update Consultation bridge fields: assert matchedCount === 1
          const updateConsultationResult = await this.consultationModel.updateOne(
            {
              _id: consultationObjId,
              clinicId,
              status: ConsultationStatus.FINALIZED,
            },
            {
              $set: {
                prescriptionId: newPrescription._id,
                hasPrescription: true,
                updatedBy: actorDoctorId,
              },
              $inc: { version: 1 },
            },
            { session },
          );

          if (updateConsultationResult.matchedCount !== 1) {
            throw new ConflictException(
              'Consultation linkage failed: Consultation is no longer finalized or not found in clinic.',
            );
          }

          // 9. Commit Audit Log
          const action = oldPrescription
            ? ClinicAuditAction.PRESCRIPTION_REPLACED
            : ClinicAuditAction.PRESCRIPTION_ISSUED;

          await this.auditLogModel.create(
            [
              {
                clinicId,
                actorDoctorId,
                action,
                metadata: {
                  prescriptionId: newPrescription._id.toString(),
                  prescriptionNumber: newPrescription.prescriptionNumber,
                  consultationId: consultationObjId.toString(),
                  patientId: consultation.patientId.toString(),
                  revisionNumber: 1,
                  ...(oldPrescription
                    ? {
                        replacedPrescriptionId: oldPrescription._id.toString(),
                        replacedPrescriptionNumber: oldPrescription.prescriptionNumber,
                      }
                    : {}),
                },
              },
            ],
            { session },
          );

          const responsePayload = Object.assign(newPrescription.toObject(), {
            latestRevision: newRevision.toObject(),
          });

          // 10. Fenced Idempotency Record Transition
          if (idempotencyKey && claimToken) {
            const fenced = await this.idempotencyModel.findOneAndUpdate(
              {
                clinicId,
                key: idempotencyKey.trim(),
                claimToken,
                status: 'PROCESSING',
                lockedUntil: { $gt: new Date() },
              },
              {
                $set: {
                  status: 'COMPLETED',
                  responseCode: 201,
                  responseBody: responsePayload,
                  lockedUntil: null,
                },
              },
              { session },
            );

            if (!fenced) {
              throw new ConflictException(
                'Idempotency lease expired or was revoked by a concurrent retry. Transaction aborted.',
              );
            }
          }

          return responsePayload;
        },
        { isRetryableError: isCounterInitializationRace },
      );
    } catch (err: any) {
      if (idempotencyKey && claimToken) {
        await this.updateIdempotencyToFailed(
          clinicId,
          idempotencyKey,
          claimToken,
          err?.message || 'Transaction aborted',
        );
      }
      throw err;
    }
  }

  /**
   * Appends an immutable revision to an active prescription with optimistic concurrency locking.
   */
  async revisePrescription(
    clinicId: Types.ObjectId,
    prescriptionId: string,
    dto: RevisePrescriptionDto,
    actorDoctorId: Types.ObjectId,
    idempotencyKey?: string,
  ): Promise<any> {
    if (!Types.ObjectId.isValid(prescriptionId)) {
      throw new NotFoundException('Invalid prescription identifier');
    }

    if (!dto.items || dto.items.length === 0) {
      throw new BadRequestException('Revised prescription must contain at least one medicine item');
    }

    for (const item of dto.items) {
      validatePrescriptionItem(item);
    }

    const prescriptionObjId = new Types.ObjectId(prescriptionId);

    let claimToken: string | undefined;
    const normalizedRoute = `/clinics/${clinicId.toString()}/prescriptions/${prescriptionId}/revisions`;

    if (idempotencyKey && idempotencyKey.trim()) {
      const cleanKey = idempotencyKey.trim();
      const fingerprint = computeRequestFingerprint('POST', normalizedRoute, dto);
      const claim = await this.claimIdempotencyLease(
        clinicId,
        cleanKey,
        'POST',
        normalizedRoute,
        fingerprint,
      );

      if (claim.replayed) {
        return claim.responseBody;
      }
      claimToken = claim.claimToken;
    }

    try {
      return await executeInTransaction(this.connection, async (session) => {
        const parent = await this.prescriptionModel
          .findOne({ _id: prescriptionObjId, clinicId })
          .session(session);

        if (!parent) {
          throw new NotFoundException('Prescription not found in this clinic');
        }

        if (parent.status === PrescriptionStatus.DISCONTINUED) {
          throw new ConflictException(
            'Cannot revise a discontinued prescription. Issue a replacement instead.',
          );
        }
        if (parent.status === PrescriptionStatus.CANCELLED) {
          throw new ConflictException(
            'Cannot revise a cancelled prescription.',
          );
        }

        if (parent.currentRevisionNumber !== dto.expectedRevisionNumber) {
          throw new ConflictException(
            `Optimistic lock conflict: Prescription revision sequence was modified (expected: ${dto.expectedRevisionNumber}, current: ${parent.currentRevisionNumber}).`,
          );
        }
        if (parent.version !== dto.expectedVersion) {
          throw new ConflictException(
            `Optimistic lock conflict: Prescription document version mismatch (expected: ${dto.expectedVersion}, current: ${parent.version}).`,
          );
        }

        // Fetch previous revision to carry forward the clinical snapshot
        const previousRevision = await this.revisionModel
          .findOne({
            prescriptionId: parent._id,
            revisionNumber: parent.currentRevisionNumber,
          })
          .session(session);

        if (!previousRevision) {
          throw new InternalServerErrorException(
            'Previous prescription revision could not be loaded.',
          );
        }

        const newRevisionId = new Types.ObjectId();
        const nextRevisionNumber = parent.currentRevisionNumber + 1;

        // 1. Insert new immutable revision
        const [newRevision] = await this.revisionModel.create(
          [
            {
              _id: newRevisionId,
              clinicId,
              prescriptionId: parent._id,
              consultationId: parent.consultationId,
              patientId: parent.patientId,
              prescribedBy: actorDoctorId,
              revisionNumber: nextRevisionNumber,
              reasonForRevision: dto.reasonForRevision.trim(),
              items: dto.items,
              generalAdvice: dto.generalAdvice?.trim() || null,
              clinicalSnapshot: previousRevision.clinicalSnapshot,
            },
          ],
          { session },
        );

        // 2. Conditional optimistic update on parent prescription
        const updatedParent = await this.prescriptionModel.findOneAndUpdate(
          {
            _id: parent._id,
            clinicId,
            status: PrescriptionStatus.ACTIVE,
            currentRevisionNumber: dto.expectedRevisionNumber,
            version: dto.expectedVersion,
          },
          {
            $set: {
              currentRevisionNumber: nextRevisionNumber,
              latestRevisionId: newRevisionId,
              updatedBy: actorDoctorId,
            },
            $inc: { version: 1 },
          },
          { returnDocument: 'after', session },
        );

        if (!updatedParent) {
          throw new ConflictException(
            'Optimistic lock conflict: Prescription parent document was modified by another session.',
          );
        }

        // 3. Commit Audit Log
        await this.auditLogModel.create(
          [
            {
              clinicId,
              actorDoctorId,
              action: ClinicAuditAction.PRESCRIPTION_REVISED,
              metadata: {
                prescriptionId: updatedParent._id.toString(),
                prescriptionNumber: updatedParent.prescriptionNumber,
                revisionNumber: nextRevisionNumber,
                reasonForRevision: dto.reasonForRevision.trim(),
              },
            },
          ],
          { session },
        );

        const responsePayload = Object.assign(updatedParent.toObject(), {
          latestRevision: newRevision.toObject(),
        });

        // 4. Fenced Idempotency Completion
        if (idempotencyKey && claimToken) {
          const fenced = await this.idempotencyModel.findOneAndUpdate(
            {
              clinicId,
              key: idempotencyKey.trim(),
              claimToken,
              status: 'PROCESSING',
              lockedUntil: { $gt: new Date() },
            },
            {
              $set: {
                status: 'COMPLETED',
                responseCode: 201,
                responseBody: responsePayload,
                lockedUntil: null,
              },
            },
            { session },
          );

          if (!fenced) {
            throw new ConflictException(
              'Idempotency lease expired or revoked during revision. Transaction aborted.',
            );
          }
        }

        return responsePayload;
      });
    } catch (err: any) {
      if (idempotencyKey && claimToken) {
        await this.updateIdempotencyToFailed(
          clinicId,
          idempotencyKey,
          claimToken,
          err?.message || 'Transaction aborted',
        );
      }
      throw err;
    }
  }

  /**
   * Discontinues an active prescription.
   */
  async discontinuePrescription(
    clinicId: Types.ObjectId,
    prescriptionId: string,
    dto: DiscontinuePrescriptionDto,
    actorDoctorId: Types.ObjectId,
    idempotencyKey?: string,
  ): Promise<any> {
    if (!Types.ObjectId.isValid(prescriptionId)) {
      throw new NotFoundException('Invalid prescription identifier');
    }

    const prescriptionObjId = new Types.ObjectId(prescriptionId);

    let claimToken: string | undefined;
    const normalizedRoute = `/clinics/${clinicId.toString()}/prescriptions/${prescriptionId}/discontinue`;

    if (idempotencyKey && idempotencyKey.trim()) {
      const cleanKey = idempotencyKey.trim();
      const fingerprint = computeRequestFingerprint('POST', normalizedRoute, dto);
      const claim = await this.claimIdempotencyLease(
        clinicId,
        cleanKey,
        'POST',
        normalizedRoute,
        fingerprint,
      );

      if (claim.replayed) {
        return claim.responseBody;
      }
      claimToken = claim.claimToken;
    }

    try {
      return await executeInTransaction(this.connection, async (session) => {
        const prescription = await this.prescriptionModel
          .findOne({ _id: prescriptionObjId, clinicId })
          .session(session);

        if (!prescription) {
          throw new NotFoundException('Prescription not found in this clinic');
        }

        if (prescription.status === PrescriptionStatus.DISCONTINUED) {
          throw new ConflictException('Prescription is already discontinued.');
        }
        if (prescription.status === PrescriptionStatus.CANCELLED) {
          throw new ConflictException('Cancelled prescriptions cannot be discontinued.');
        }

        const query: Record<string, any> = {
          _id: prescription._id,
          clinicId,
          status: PrescriptionStatus.ACTIVE,
        };
        if (dto.expectedVersion) {
          query.version = dto.expectedVersion;
        }

        const updated = await this.prescriptionModel.findOneAndUpdate(
          query,
          {
            $set: {
              status: PrescriptionStatus.DISCONTINUED,
              discontinuationReason: dto.discontinuationReason.trim(),
              discontinuedAt: new Date(),
              discontinuedBy: actorDoctorId,
              updatedBy: actorDoctorId,
            },
            $inc: { version: 1 },
          },
          { returnDocument: 'after', session },
        );

        if (!updated) {
          throw new ConflictException(
            'Prescription could not be discontinued (concurrent update or version conflict).',
          );
        }

        await this.auditLogModel.create(
          [
            {
              clinicId,
              actorDoctorId,
              action: ClinicAuditAction.PRESCRIPTION_DISCONTINUED,
              reason: dto.discontinuationReason.trim(),
              metadata: {
                prescriptionId: updated._id.toString(),
                prescriptionNumber: updated.prescriptionNumber,
              },
            },
          ],
          { session },
        );

        const responsePayload = updated.toObject();

        if (idempotencyKey && claimToken) {
          const fenced = await this.idempotencyModel.findOneAndUpdate(
            {
              clinicId,
              key: idempotencyKey.trim(),
              claimToken,
              status: 'PROCESSING',
              lockedUntil: { $gt: new Date() },
            },
            {
              $set: {
                status: 'COMPLETED',
                responseCode: 200,
                responseBody: responsePayload,
                lockedUntil: null,
              },
            },
            { session },
          );

          if (!fenced) {
            throw new ConflictException(
              'Idempotency lease expired. Transaction aborted.',
            );
          }
        }

        return responsePayload;
      });
    } catch (err: any) {
      if (idempotencyKey && claimToken) {
        await this.updateIdempotencyToFailed(
          clinicId,
          idempotencyKey,
          claimToken,
          err?.message || 'Transaction aborted',
        );
      }
      throw err;
    }
  }

  /**
   * Cancels a prescription with strict authorization ordering.
   * Authorized callers: prescribing doctor OR clinic OWNER.
   * Unauthorized callers receive 403 Forbidden even if targeting an already-cancelled prescription.
   */
  async cancelPrescription(
    clinicId: Types.ObjectId,
    prescriptionId: string,
    actorDoctorId: Types.ObjectId,
    actorRole: ClinicRole,
    dto: CancelPrescriptionDto,
  ): Promise<{ message: string }> {
    if (!Types.ObjectId.isValid(prescriptionId)) {
      throw new NotFoundException('Invalid prescription identifier');
    }

    const prescription = await this.prescriptionModel.findOne({
      _id: new Types.ObjectId(prescriptionId),
      clinicId,
    });

    if (!prescription) {
      throw new NotFoundException('Prescription not found in this clinic');
    }

    // 1. AUTHORIZE FIRST: Enforce authorization before inspecting/revealing status
    const isPrescribingDoctor =
      prescription.prescribedBy.toString() === actorDoctorId.toString();
    const isClinicOwner = actorRole === ClinicRole.OWNER;

    if (!isPrescribingDoctor && !isClinicOwner) {
      throw new ForbiddenException(
        'You are not authorized to cancel a prescription issued by another doctor.',
      );
    }

    // 2. Short-circuit idempotently if already cancelled (Authorized callers only)
    if (prescription.status === PrescriptionStatus.CANCELLED) {
      return { message: 'Prescription is already cancelled.' };
    }

    return executeInTransaction(this.connection, async (session) => {
      const query: Record<string, any> = {
        _id: prescription._id,
        clinicId,
        status: PrescriptionStatus.ACTIVE,
      };
      if (dto.expectedVersion) {
        query.version = dto.expectedVersion;
      }

      const updated = await this.prescriptionModel.findOneAndUpdate(
        query,
        {
          $set: {
            status: PrescriptionStatus.CANCELLED,
            cancellationReason: dto.cancellationReason.trim(),
            cancelledAt: new Date(),
            cancelledBy: actorDoctorId,
            updatedBy: actorDoctorId,
          },
          $inc: { version: 1 },
        },
        { returnDocument: 'after', session },
      );

      if (!updated) {
        throw new ConflictException(
          'Prescription cannot be cancelled (it was concurrently modified, discontinued, or cancelled).',
        );
      }

      await this.auditLogModel.create(
        [
          {
            clinicId,
            actorDoctorId,
            targetDoctorId: prescription.prescribedBy,
            role: actorRole,
            action: ClinicAuditAction.PRESCRIPTION_CANCELLED,
            reason: dto.cancellationReason.trim(),
            metadata: {
              prescriptionId: prescription._id.toString(),
              prescriptionNumber: prescription.prescriptionNumber,
              isCancelledByOwner: isClinicOwner && !isPrescribingDoctor,
            },
          },
        ],
        { session },
      );

      return { message: 'Prescription successfully cancelled.' };
    });
  }

  /**
   * Retrieves single prescription with latest or specific revision and dynamic patient demographics.
   */
  async getPrescriptionById(
    clinicId: Types.ObjectId,
    prescriptionId: string,
    revisionNumber?: number,
  ): Promise<any> {
    if (!Types.ObjectId.isValid(prescriptionId)) {
      throw new NotFoundException('Invalid prescription identifier');
    }

    const prescription = await this.prescriptionModel.findOne({
      _id: new Types.ObjectId(prescriptionId),
      clinicId,
    });

    if (!prescription) {
      throw new NotFoundException('Prescription not found in this clinic');
    }

    const targetRevNumber = revisionNumber || prescription.currentRevisionNumber;
    const revision = await this.revisionModel.findOne({
      prescriptionId: prescription._id,
      revisionNumber: targetRevNumber,
    });

    if (!revision) {
      throw new NotFoundException(`Prescription revision ${targetRevNumber} not found`);
    }

    // Dynamic Demographics Resolution from Patient Domain
    const patient = await this.patientModel.findOne({
      _id: prescription.patientId,
      clinicId,
    });

    const dynamicAge = patient
      ? computePatientCurrentAge(patient, 'Asia/Kolkata', prescription.createdAt)
      : null;

    return Object.assign(prescription.toObject(), {
      patient: patient
        ? {
            patientName: patient.name,
            patientCode: prescription.patientCode,
            age: dynamicAge,
            gender: patient.gender,
            contactNumber: patient.phone,
          }
        : null,
      patientDetails: patient
        ? {
            name: patient.name,
            gender: patient.gender,
            phone: patient.phone,
            currentAge: dynamicAge,
          }
        : null,
      latestRevision: revision.toObject(),
      revision: revision.toObject(),
    });
  }

  /**
   * Lists all revisions for a prescription.
   */
  async getPrescriptionRevisions(
    clinicId: Types.ObjectId,
    prescriptionId: string,
  ): Promise<any[]> {
    if (!Types.ObjectId.isValid(prescriptionId)) {
      throw new NotFoundException('Invalid prescription identifier');
    }

    const prescription = await this.prescriptionModel.findOne({
      _id: new Types.ObjectId(prescriptionId),
      clinicId,
    });

    if (!prescription) {
      throw new NotFoundException('Prescription not found in this clinic');
    }

    return this.revisionModel
      .find({ prescriptionId: prescription._id, clinicId })
      .sort({ revisionNumber: 1 })
      .exec();
  }

  /**
   * Retrieves the active prescription for a consultation.
   */
  async getConsultationPrescription(
    clinicId: Types.ObjectId,
    consultationId: string,
  ): Promise<any> {
    if (!Types.ObjectId.isValid(consultationId)) {
      throw new NotFoundException('Invalid consultation identifier');
    }

    const prescription = await this.prescriptionModel.findOne({
      clinicId,
      consultationId: new Types.ObjectId(consultationId),
      status: PrescriptionStatus.ACTIVE,
    });

    if (!prescription) {
      throw new NotFoundException('No active prescription found for this consultation');
    }

    return this.getPrescriptionById(clinicId, prescription._id.toString());
  }

  /**
   * Lists paginated prescriptions for a patient or clinic.
   */
  async queryPrescriptions(
    clinicId: Types.ObjectId,
    query: QueryPrescriptionsDto,
  ): Promise<{ data: any[]; total: number; page: number; limit: number }> {
    const filter: Record<string, any> = { clinicId };

    if (query.patientId && Types.ObjectId.isValid(query.patientId)) {
      filter.patientId = new Types.ObjectId(query.patientId);
    }
    if (query.consultationId && Types.ObjectId.isValid(query.consultationId)) {
      filter.consultationId = new Types.ObjectId(query.consultationId);
    }
    if (query.status) {
      filter.status = query.status;
    }

    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prescriptionModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      this.prescriptionModel.countDocuments(filter),
    ]);

    return {
      data,
      total,
      page,
      limit,
    };
  }
}
