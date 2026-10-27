import {
  Injectable,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel, InjectConnection } from '@nestjs/mongoose';
import type { Connection, ClientSession } from 'mongoose';
import { Model, Types } from 'mongoose';
import crypto from 'node:crypto';
import {
  SyncChangeFeed,
  SyncChangeFeedDocument,
  SyncEntityType,
  SyncActionType,
} from './schemas/sync-change-feed.schema.js';
import {
  ClinicSyncCounter,
  ClinicSyncCounterDocument,
} from './schemas/clinic-sync-counter.schema.js';
import {
  SyncConflict,
  SyncConflictDocument,
  SyncConflictStatus,
} from './schemas/sync-conflict.schema.js';
import {
  IdempotencyRecord,
  IdempotencyRecordDocument,
} from '../common/schemas/idempotency-record.schema.js';
import { Patient, PatientDocument, PatientGender, PatientStatus } from '../patient/schemas/patient.schema.js';
import {
  Consultation,
  ConsultationDocument,
  ConsultationStatus,
} from '../consultation/schemas/consultation.schema.js';
import {
  Prescription,
  PrescriptionDocument,
  PrescriptionStatus,
} from '../prescription/schemas/prescription.schema.js';
import {
  PrescriptionRevision,
  PrescriptionRevisionDocument,
} from '../prescription/schemas/prescription-revision.schema.js';
import {
  ClinicSequenceCounter,
  ClinicSequenceCounterDocument,
} from '../patient/schemas/clinic-sequence-counter.schema.js';
import {
  SyncPushDto,
  SyncMutationDto,
  SyncMutationResult,
  SyncPushResponse,
} from './dto/sync-push.dto.js';
import {
  SyncPullQueryDto,
  SyncPullResponse,
  SyncFeedItem,
} from './dto/sync-pull.dto.js';

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(SyncChangeFeed.name)
    private readonly changeFeedModel: Model<SyncChangeFeedDocument>,
    @InjectModel(ClinicSyncCounter.name)
    private readonly counterModel: Model<ClinicSyncCounterDocument>,
    @InjectModel(SyncConflict.name)
    private readonly conflictModel: Model<SyncConflictDocument>,
    @InjectModel(IdempotencyRecord.name)
    private readonly idempotencyModel: Model<IdempotencyRecordDocument>,
    @InjectModel(Patient.name)
    private readonly patientModel: Model<PatientDocument>,
    @InjectModel(Consultation.name)
    private readonly consultationModel: Model<ConsultationDocument>,
    @InjectModel(Prescription.name)
    private readonly prescriptionModel: Model<PrescriptionDocument>,
    @InjectModel(PrescriptionRevision.name)
    private readonly revisionModel: Model<PrescriptionRevisionDocument>,
    @InjectModel(ClinicSequenceCounter.name)
    private readonly seqCounterModel: Model<ClinicSequenceCounterDocument>,
  ) {}

  /**
   * Processes a batch of sync mutations pushed from the desktop client.
   * Every mutation is executed atomically within its own transaction alongside an
   * idempotency record and an append-only change feed entry.
   */
  async push(
    clinicId: Types.ObjectId,
    doctorId: Types.ObjectId,
    dto: SyncPushDto,
  ): Promise<SyncPushResponse> {
    const results: SyncMutationResult[] = [];

    for (const mutation of dto.mutations) {
      const result = await this.processMutation(clinicId, doctorId, mutation);
      results.push(result);
    }

    return {
      processedAt: new Date().toISOString(),
      clinicId: clinicId.toString(),
      results,
    };
  }

  /**
   * Pulls incremental change events since a given monotonic sequence cursor.
   * Because sequence numbers are contiguous and monotonic per clinic, this cursor
   * cannot skip records during concurrent writes or equal timestamps.
   */
  async pull(
    clinicId: Types.ObjectId,
    query: SyncPullQueryDto,
  ): Promise<SyncPullResponse> {
    const sinceSeq = query.sinceSeq ?? 0;
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);

    const changes = await this.changeFeedModel
      .find({
        clinicId,
        seq: { $gt: sinceSeq },
      })
      .sort({ seq: 1 })
      .limit(limit)
      .lean();

    const counter = await this.counterModel.findOne({ clinicId });
    const currentSeq = counter?.lastSeq ?? 0;

    const highestRetrievedSeq =
      changes.length > 0 ? changes[changes.length - 1].seq : sinceSeq;
    const hasMore = highestRetrievedSeq < currentSeq;

    const feedItems: SyncFeedItem[] = changes.map((c) => ({
      seq: c.seq,
      entityType: c.entityType,
      entityId: c.entityId,
      clientEntityId: c.clientEntityId,
      action: c.action,
      version: c.version,
      payload: c.payload,
      committedAt: c.committedAt.toISOString(),
      actorDoctorId: c.actorDoctorId.toString(),
    }));

    return {
      clinicId: clinicId.toString(),
      sinceSeq,
      currentSeq,
      hasMore,
      changes: feedItems,
    };
  }

  private async processMutation(
    clinicId: Types.ObjectId,
    doctorId: Types.ObjectId,
    mutation: SyncMutationDto,
  ): Promise<SyncMutationResult> {
    const payloadFingerprint = crypto
      .createHash('sha256')
      .update(JSON.stringify(mutation.payload))
      .digest('hex');

    // 1. Idempotency Check
    const existingIdempotency = await this.idempotencyModel.findOne({
      clinicId,
      key: mutation.idempotencyKey,
    });

    if (existingIdempotency) {
      if (existingIdempotency.requestFingerprint !== payloadFingerprint) {
        return {
          outboxId: mutation.outboxId,
          status: 'REJECTED',
          entityType: mutation.entityType,
          entityId: mutation.entityId,
          error:
            'Idempotency key was previously used with a different request payload.',
        };
      }

      if (existingIdempotency.status === 'COMPLETED' && existingIdempotency.responseBody) {
        return existingIdempotency.responseBody as SyncMutationResult;
      }

      if (
        existingIdempotency.status === 'PROCESSING' &&
        existingIdempotency.lockedUntil &&
        existingIdempotency.lockedUntil > new Date()
      ) {
        return {
          outboxId: mutation.outboxId,
          status: 'REJECTED',
          entityType: mutation.entityType,
          entityId: mutation.entityId,
          error:
            'A sync request with this Idempotency-Key is currently in progress.',
        };
      }
    }

    const session: ClientSession = await this.connection.startSession();
    try {
      let finalResult: SyncMutationResult | null = null;

      await session.withTransaction(async () => {
        // Record idempotency lease
        const leaseExpiry = new Date(Date.now() + 60 * 1000);
        const ttlExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

        await this.idempotencyModel.findOneAndUpdate(
          { clinicId, key: mutation.idempotencyKey },
          {
            $set: {
              clinicId,
              key: mutation.idempotencyKey,
              httpMethod: 'POST',
              normalizedRoute: '/api/v1/sync/push',
              requestFingerprint: payloadFingerprint,
              status: 'PROCESSING',
              claimToken: crypto.randomUUID(),
              lockedUntil: leaseExpiry,
              expiresAt: ttlExpiry,
            },
          },
          { upsert: true, session },
        );

        // Execute entity-specific business logic
        switch (mutation.entityType) {
          case SyncEntityType.PATIENT:
            finalResult = await this.applyPatientMutation(
              clinicId,
              doctorId,
              mutation,
              session,
            );
            break;

          case SyncEntityType.CONSULTATION:
            finalResult = await this.applyConsultationMutation(
              clinicId,
              doctorId,
              mutation,
              session,
            );
            break;

          case SyncEntityType.PRESCRIPTION:
          case SyncEntityType.PRESCRIPTION_REVISION:
            finalResult = await this.applyPrescriptionMutation(
              clinicId,
              doctorId,
              mutation,
              session,
            );
            break;

          default:
            finalResult = {
              outboxId: mutation.outboxId,
              status: 'REJECTED',
              entityType: mutation.entityType,
              entityId: mutation.entityId,
              error: `Unsupported entity type: ${mutation.entityType}`,
            };
        }

        // Finalize idempotency record with outcome
        await this.idempotencyModel.updateOne(
          { clinicId, key: mutation.idempotencyKey },
          {
            $set: {
              status: 'COMPLETED',
              responseCode: finalResult.status === 'APPLIED' ? 200 : 409,
              responseBody: finalResult,
              lockedUntil: null,
            },
          },
          { session },
        );
      });

      return finalResult ?? {
        outboxId: mutation.outboxId,
        status: 'REJECTED',
        entityType: mutation.entityType,
        entityId: mutation.entityId,
        error: 'Transaction ended without generating result.',
      };
    } catch (err: any) {
      this.logger.error(
        `Sync mutation ${mutation.outboxId} failed: ${err.message}`,
        err.stack,
      );
      return {
        outboxId: mutation.outboxId,
        status: 'REJECTED',
        entityType: mutation.entityType,
        entityId: mutation.entityId,
        error: err.message || 'Internal error during sync transaction.',
      };
    } finally {
      await session.endSession();
    }
  }

  // -------------------------------------------------------------------------
  // PATIENT MUTATION HANDLER
  // -------------------------------------------------------------------------

  private async applyPatientMutation(
    clinicId: Types.ObjectId,
    doctorId: Types.ObjectId,
    mutation: SyncMutationDto,
    session: ClientSession,
  ): Promise<SyncMutationResult> {
    if (mutation.action === SyncActionType.CREATE) {
      const patientCode =
        mutation.payload.patientCode || mutation.payload.patientId;

      let canonicalPatientCode = patientCode;
      if (!canonicalPatientCode) {
        // Allocate sequential patient code
        const counter = await this.seqCounterModel.findOneAndUpdate(
          { clinicId, sequenceName: 'patient' },
          { $inc: { seq: 1 } },
          { upsert: true, returnDocument: 'after', session },
        );
        canonicalPatientCode = `P-${counter.seq.toString().padStart(5, '0')}`;
      }

      // Check unique patient code per clinic
      const existing = await this.patientModel.findOne(
        { clinicId, patientId: canonicalPatientCode },
        null,
        { session },
      );

      if (existing) {
        return {
          outboxId: mutation.outboxId,
          status: 'CONFLICT',
          entityType: mutation.entityType,
          entityId: mutation.entityId,
          serverId: existing._id.toString(),
          serverVersion: existing.version,
          conflictDetails: {
            conflictReason: 'PATIENT_CODE_COLLISION',
            serverVersion: existing.version,
            clientVersion: mutation.clientVersion,
            reason: `Patient with code ${canonicalPatientCode} already exists in clinic.`,
            serverState: existing.toObject(),
            clientPayload: mutation.payload,
          },
        };
      }

      const phone = mutation.payload.phone || '';
      const normalizedPhone = phone.replace(/\D/g, '');

      const [newPatient] = await this.patientModel.create(
        [
          {
            clinicId,
            patientId: canonicalPatientCode,
            name: mutation.payload.name || 'Unnamed Patient',
            initials: (mutation.payload.name || 'U')
              .split(' ')
              .map((p: string) => p[0])
              .join('')
              .toUpperCase(),
            age: mutation.payload.age ?? 0,
            gender: mutation.payload.gender || PatientGender.OTHER,
            phone,
            normalizedPhone,
            dateOfBirth: mutation.payload.dateOfBirth
              ? new Date(mutation.payload.dateOfBirth)
              : null,
            allergies: Array.isArray(mutation.payload.allergies)
              ? mutation.payload.allergies
              : [],
            conditions: Array.isArray(mutation.payload.conditions)
              ? mutation.payload.conditions
              : [],
            status: PatientStatus.ACTIVE,
            version: 1,
            createdBy: doctorId,
            updatedBy: doctorId,
          },
        ],
        { session },
      );

      const seq = await this.incrementClinicSeq(clinicId, session);

      await this.changeFeedModel.create(
        [
          {
            clinicId,
            seq,
            entityType: SyncEntityType.PATIENT,
            entityId: newPatient._id.toString(),
            clientEntityId: mutation.entityId,
            action: SyncActionType.CREATE,
            version: 1,
            payload: newPatient.toObject(),
            committedAt: new Date(),
            actorDoctorId: doctorId,
          },
        ],
        { session },
      );

      return {
        outboxId: mutation.outboxId,
        status: 'APPLIED',
        entityType: mutation.entityType,
        entityId: mutation.entityId,
        serverId: newPatient._id.toString(),
        serverVersion: 1,
      };
    }

    if (mutation.action === SyncActionType.UPDATE) {
      const patient = await this.findPatient(clinicId, mutation, session);
      if (!patient) {
        return {
          outboxId: mutation.outboxId,
          status: 'REJECTED',
          entityType: mutation.entityType,
          entityId: mutation.entityId,
          error: 'Patient record not found on server.',
        };
      }

      // Concurrency check: does client version match server version?
      if (mutation.clientVersion < patient.version) {
        // Detect divergent clinical fields: Allergies and conditions must NEVER be auto-unioned
        const conflictFields: string[] = [];

        if (mutation.payload.allergies) {
          const clientAllergies = new Set(mutation.payload.allergies);
          const serverAllergies = new Set(patient.allergies);
          if (
            clientAllergies.size !== serverAllergies.size ||
            [...clientAllergies].some((a) => !serverAllergies.has(a as string))
          ) {
            conflictFields.push('allergies');
          }
        }

        if (mutation.payload.conditions) {
          const clientConditions = new Set(mutation.payload.conditions);
          const serverConditions = new Set(patient.conditions);
          if (
            clientConditions.size !== serverConditions.size ||
            [...clientConditions].some((c) => !serverConditions.has(c as string))
          ) {
            conflictFields.push('conditions');
          }
        }

        if (conflictFields.length > 0) {
          // Mandatory constraint: requires explicit clinical review
          await this.conflictModel.create(
            [
              {
                clinicId,
                outboxId: mutation.outboxId,
                entityType: SyncEntityType.PATIENT,
                entityId: patient._id.toString(),
                serverVersion: patient.version,
                clientVersion: mutation.clientVersion,
                conflictReason: 'DIVERGENT_CLINICAL_DATA',
                serverPayload: patient.toObject(),
                clientPayload: mutation.payload,
                conflictFields,
                status: SyncConflictStatus.OPEN,
              },
            ],
            { session },
          );

          return {
            outboxId: mutation.outboxId,
            status: 'CONFLICT',
            entityType: mutation.entityType,
            entityId: mutation.entityId,
            serverId: patient._id.toString(),
            serverVersion: patient.version,
            conflictDetails: {
              conflictReason: 'DIVERGENT_CLINICAL_DATA',
              serverVersion: patient.version,
              clientVersion: mutation.clientVersion,
              conflictFields,
              serverState: patient.toObject(),
              clientPayload: mutation.payload,
            },
          };
        }
      }

      // Safe update
      if (mutation.payload.name) patient.name = mutation.payload.name;
      if (mutation.payload.phone) {
        patient.phone = mutation.payload.phone;
        patient.normalizedPhone = mutation.payload.phone.replace(/\D/g, '');
      }
      if (mutation.payload.age !== undefined) patient.age = mutation.payload.age;
      if (mutation.payload.allergies) patient.allergies = mutation.payload.allergies;
      if (mutation.payload.conditions) patient.conditions = mutation.payload.conditions;

      patient.version += 1;
      patient.updatedBy = doctorId;
      await patient.save({ session });

      const seq = await this.incrementClinicSeq(clinicId, session);
      await this.changeFeedModel.create(
        [
          {
            clinicId,
            seq,
            entityType: SyncEntityType.PATIENT,
            entityId: patient._id.toString(),
            clientEntityId: mutation.entityId,
            action: SyncActionType.UPDATE,
            version: patient.version,
            payload: patient.toObject(),
            committedAt: new Date(),
            actorDoctorId: doctorId,
          },
        ],
        { session },
      );

      return {
        outboxId: mutation.outboxId,
        status: 'APPLIED',
        entityType: mutation.entityType,
        entityId: mutation.entityId,
        serverId: patient._id.toString(),
        serverVersion: patient.version,
      };
    }

    return {
      outboxId: mutation.outboxId,
      status: 'REJECTED',
      entityType: mutation.entityType,
      entityId: mutation.entityId,
      error: `Unsupported patient sync action: ${mutation.action}`,
    };
  }

  // -------------------------------------------------------------------------
  // CONSULTATION MUTATION HANDLER
  // -------------------------------------------------------------------------

  private async applyConsultationMutation(
    clinicId: Types.ObjectId,
    doctorId: Types.ObjectId,
    mutation: SyncMutationDto,
    session: ClientSession,
  ): Promise<SyncMutationResult> {
    if (mutation.action === SyncActionType.CREATE) {
      const patientId = new Types.ObjectId(mutation.payload.patientId);
      const patient = await this.patientModel.findOne(
        { clinicId, _id: patientId },
        null,
        { session },
      );

      if (!patient) {
        return {
          outboxId: mutation.outboxId,
          status: 'REJECTED',
          entityType: mutation.entityType,
          entityId: mutation.entityId,
          error: 'Consultation patient not found in clinic.',
        };
      }

      // Check partial unique index: at most one active DRAFT per patient in clinic
      const existingDraft = await this.consultationModel.findOne(
        { clinicId, patientId, status: ConsultationStatus.DRAFT },
        null,
        { session },
      );

      if (existingDraft) {
        await this.conflictModel.create(
          [
            {
              clinicId,
              outboxId: mutation.outboxId,
              entityType: SyncEntityType.CONSULTATION,
              entityId: mutation.entityId,
              serverVersion: existingDraft.version,
              clientVersion: mutation.clientVersion,
              conflictReason: 'CONCURRENT_DRAFT_COLLISION',
              serverPayload: existingDraft.toObject(),
              clientPayload: mutation.payload,
              conflictFields: ['status', 'chiefComplaint', 'diagnosis'],
              status: SyncConflictStatus.OPEN,
            },
          ],
          { session },
        );

        return {
          outboxId: mutation.outboxId,
          status: 'CONFLICT',
          entityType: mutation.entityType,
          entityId: mutation.entityId,
          serverId: existingDraft._id.toString(),
          serverVersion: existingDraft.version,
          conflictDetails: {
            conflictReason: 'CONCURRENT_DRAFT_COLLISION',
            serverVersion: existingDraft.version,
            clientVersion: mutation.clientVersion,
            serverState: existingDraft.toObject(),
            clientPayload: mutation.payload,
          },
        };
      }

      const [newConsultation] = await this.consultationModel.create(
        [
          {
            clinicId,
            patientId,
            patientCode: patient.patientId,
            doctorId,
            status: ConsultationStatus.DRAFT,
            consultationDate: mutation.payload.consultationDate
              ? new Date(mutation.payload.consultationDate)
              : new Date(),
            chiefComplaint: mutation.payload.chiefComplaint || '',
            diagnosis: mutation.payload.diagnosis || '',
            vitals: mutation.payload.vitals || {},
            provisionalMedicines: mutation.payload.provisionalMedicines || [],
            version: 1,
            createdBy: doctorId,
            updatedBy: doctorId,
          },
        ],
        { session },
      );

      const seq = await this.incrementClinicSeq(clinicId, session);
      await this.changeFeedModel.create(
        [
          {
            clinicId,
            seq,
            entityType: SyncEntityType.CONSULTATION,
            entityId: newConsultation._id.toString(),
            clientEntityId: mutation.entityId,
            action: SyncActionType.CREATE,
            version: 1,
            payload: newConsultation.toObject(),
            committedAt: new Date(),
            actorDoctorId: doctorId,
          },
        ],
        { session },
      );

      return {
        outboxId: mutation.outboxId,
        status: 'APPLIED',
        entityType: mutation.entityType,
        entityId: mutation.entityId,
        serverId: newConsultation._id.toString(),
        serverVersion: 1,
      };
    }

    if (mutation.action === SyncActionType.FINALIZE) {
      const consultation = await this.findConsultation(
        clinicId,
        mutation,
        session,
      );

      if (!consultation) {
        return {
          outboxId: mutation.outboxId,
          status: 'REJECTED',
          entityType: mutation.entityType,
          entityId: mutation.entityId,
          error: 'Consultation not found.',
        };
      }

      if (consultation.status === ConsultationStatus.FINALIZED) {
        // Finalized consultations are immutable
        return {
          outboxId: mutation.outboxId,
          status: 'CONFLICT',
          entityType: mutation.entityType,
          entityId: mutation.entityId,
          serverId: consultation._id.toString(),
          serverVersion: consultation.version,
          conflictDetails: {
            conflictReason: 'IMMUTABLE_FINALIZED_COLLISION',
            serverVersion: consultation.version,
            clientVersion: mutation.clientVersion,
            serverState: consultation.toObject(),
            clientPayload: mutation.payload,
          },
        };
      }

      consultation.status = ConsultationStatus.FINALIZED;
      consultation.finalizedAt = new Date();
      consultation.finalizedBy = doctorId;
      consultation.version += 1;
      consultation.updatedBy = doctorId;
      await consultation.save({ session });

      const seq = await this.incrementClinicSeq(clinicId, session);
      await this.changeFeedModel.create(
        [
          {
            clinicId,
            seq,
            entityType: SyncEntityType.CONSULTATION,
            entityId: consultation._id.toString(),
            clientEntityId: mutation.entityId,
            action: SyncActionType.FINALIZE,
            version: consultation.version,
            payload: consultation.toObject(),
            committedAt: new Date(),
            actorDoctorId: doctorId,
          },
        ],
        { session },
      );

      return {
        outboxId: mutation.outboxId,
        status: 'APPLIED',
        entityType: mutation.entityType,
        entityId: mutation.entityId,
        serverId: consultation._id.toString(),
        serverVersion: consultation.version,
      };
    }

    return {
      outboxId: mutation.outboxId,
      status: 'REJECTED',
      entityType: mutation.entityType,
      entityId: mutation.entityId,
      error: `Unsupported consultation sync action: ${mutation.action}`,
    };
  }

  // -------------------------------------------------------------------------
  // PRESCRIPTION MUTATION HANDLER (STRICT IMMUTABILITY)
  // -------------------------------------------------------------------------

  private async applyPrescriptionMutation(
    clinicId: Types.ObjectId,
    doctorId: Types.ObjectId,
    mutation: SyncMutationDto,
    session: ClientSession,
  ): Promise<SyncMutationResult> {
    if (mutation.action === SyncActionType.CREATE) {
      const consultationId = new Types.ObjectId(mutation.payload.consultationId);
      const consultation = await this.consultationModel.findOne(
        { clinicId, _id: consultationId },
        null,
        { session },
      );

      if (!consultation) {
        return {
          outboxId: mutation.outboxId,
          status: 'REJECTED',
          entityType: mutation.entityType,
          entityId: mutation.entityId,
          error: 'Consultation not found for prescription.',
        };
      }

      // Check active prescription uniqueness per consultation
      const existingActive = await this.prescriptionModel.findOne(
        { clinicId, consultationId, status: PrescriptionStatus.ACTIVE },
        null,
        { session },
      );

      if (existingActive) {
        return {
          outboxId: mutation.outboxId,
          status: 'CONFLICT',
          entityType: mutation.entityType,
          entityId: mutation.entityId,
          serverId: existingActive._id.toString(),
          serverVersion: existingActive.version,
          conflictDetails: {
            conflictReason: 'CONCURRENT_ACTIVE_PRESCRIPTION',
            serverVersion: existingActive.version,
            clientVersion: mutation.clientVersion,
            serverState: existingActive.toObject(),
            clientPayload: mutation.payload,
          },
        };
      }

      // Allocate canonical sequential prescription number: RX-XXXXX
      const counter = await this.seqCounterModel.findOneAndUpdate(
        { clinicId, sequenceName: 'prescription' },
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: 'after', session },
      );
      const prescriptionNumber = `RX-${counter.seq.toString().padStart(5, '0')}`;

      const [newPrescription] = await this.prescriptionModel.create(
        [
          {
            clinicId,
            patientId: consultation.patientId,
            patientCode: consultation.patientCode,
            consultationId,
            prescriptionNumber,
            status: PrescriptionStatus.ACTIVE,
            currentRevisionNumber: 1,
            prescribedBy: doctorId,
            version: 1,
          },
        ],
        { session },
      );

      // Create Revision 1 (IMMUTABLE)
      const items = Array.isArray(mutation.payload.items)
        ? mutation.payload.items
        : [];
      if (items.length === 0) {
        throw new BadRequestException('Prescription must contain at least one item.');
      }

      const [rev1] = await this.revisionModel.create(
        [
          {
            clinicId,
            prescriptionId: newPrescription._id,
            consultationId,
            patientId: consultation.patientId,
            prescribedBy: doctorId,
            revisionNumber: 1,
            reasonForRevision: 'Initial Prescription',
            items,
            generalAdvice: mutation.payload.generalAdvice || null,
            clinicalSnapshot: {
              consultationId,
              patientId: consultation.patientId,
              patientCode: consultation.patientCode,
              doctorId,
              consultationDate: consultation.consultationDate,
              chiefComplaint: consultation.chiefComplaint,
              diagnosis: consultation.diagnosis,
              vitals: consultation.vitals || {},
              provisionalMedicines: consultation.provisionalMedicines || [],
            },
          },
        ],
        { session },
      );

      newPrescription.latestRevisionId = rev1._id;
      await newPrescription.save({ session });

      consultation.prescriptionId = newPrescription._id;
      consultation.hasPrescription = true;
      await consultation.save({ session });

      const seq = await this.incrementClinicSeq(clinicId, session);
      await this.changeFeedModel.create(
        [
          {
            clinicId,
            seq,
            entityType: SyncEntityType.PRESCRIPTION,
            entityId: newPrescription._id.toString(),
            clientEntityId: mutation.entityId,
            action: SyncActionType.CREATE,
            version: 1,
            payload: Object.assign({}, newPrescription.toObject(), {
              revision: rev1.toObject(),
            }),
            committedAt: new Date(),
            actorDoctorId: doctorId,
          },
        ],
        { session },
      );

      return {
        outboxId: mutation.outboxId,
        status: 'APPLIED',
        entityType: mutation.entityType,
        entityId: mutation.entityId,
        serverId: newPrescription._id.toString(),
        serverVersion: 1,
      };
    }

    if (mutation.action === SyncActionType.REVISE) {
      const prescription = await this.findPrescription(
        clinicId,
        mutation,
        session,
      );

      if (!prescription) {
        return {
          outboxId: mutation.outboxId,
          status: 'REJECTED',
          entityType: mutation.entityType,
          entityId: mutation.entityId,
          error: 'Prescription not found on server.',
        };
      }

      // Concurrency check: does client version match current prescription revision?
      if (
        mutation.clientVersion < prescription.version ||
        (mutation.payload.expectedRevisionNumber &&
          mutation.payload.expectedRevisionNumber !== prescription.currentRevisionNumber)
      ) {
        // Invariant: Conflicting prescription revisions must NEVER be combined or silently merged
        await this.conflictModel.create(
          [
            {
              clinicId,
              outboxId: mutation.outboxId,
              entityType: SyncEntityType.PRESCRIPTION_REVISION,
              entityId: prescription._id.toString(),
              serverVersion: prescription.version,
              clientVersion: mutation.clientVersion,
              conflictReason: 'CONCURRENT_REVISION_COLLISION',
              serverPayload: prescription.toObject(),
              clientPayload: mutation.payload,
              conflictFields: ['currentRevisionNumber', 'items'],
              status: SyncConflictStatus.OPEN,
            },
          ],
          { session },
        );

        return {
          outboxId: mutation.outboxId,
          status: 'CONFLICT',
          entityType: mutation.entityType,
          entityId: mutation.entityId,
          serverId: prescription._id.toString(),
          serverVersion: prescription.version,
          conflictDetails: {
            conflictReason: 'CONCURRENT_REVISION_COLLISION',
            serverVersion: prescription.version,
            clientVersion: mutation.clientVersion,
            serverState: prescription.toObject(),
            clientPayload: mutation.payload,
          },
        };
      }

      const items = Array.isArray(mutation.payload.items)
        ? mutation.payload.items
        : [];
      if (items.length === 0) {
        throw new BadRequestException('Prescription revision must contain at least one item.');
      }

      // Canonical revision number assigned transactionally by server
      const nextRevisionNumber = prescription.currentRevisionNumber + 1;

      const [newRevision] = await this.revisionModel.create(
        [
          {
            clinicId,
            prescriptionId: prescription._id,
            consultationId: prescription.consultationId,
            patientId: prescription.patientId,
            prescribedBy: doctorId,
            revisionNumber: nextRevisionNumber,
            reasonForRevision:
              mutation.payload.reasonForRevision || 'Prescription amendment',
            items,
            generalAdvice: mutation.payload.generalAdvice || null,
            clinicalSnapshot: mutation.payload.clinicalSnapshot || {
              consultationId: prescription.consultationId,
              patientId: prescription.patientId,
              patientCode: prescription.patientCode,
              doctorId,
              consultationDate: new Date(),
              chiefComplaint: '',
              diagnosis: '',
              vitals: {},
              provisionalMedicines: [],
            },
          },
        ],
        { session },
      );

      prescription.currentRevisionNumber = nextRevisionNumber;
      prescription.latestRevisionId = newRevision._id;
      prescription.version += 1;
      await prescription.save({ session });

      const seq = await this.incrementClinicSeq(clinicId, session);
      await this.changeFeedModel.create(
        [
          {
            clinicId,
            seq,
            entityType: SyncEntityType.PRESCRIPTION_REVISION,
            entityId: prescription._id.toString(),
            clientEntityId: mutation.entityId,
            action: SyncActionType.REVISE,
            version: prescription.version,
            payload: {
              prescriptionId: prescription._id.toString(),
              revisionNumber: nextRevisionNumber,
              revision: newRevision.toObject(),
            },
            committedAt: new Date(),
            actorDoctorId: doctorId,
          },
        ],
        { session },
      );

      return {
        outboxId: mutation.outboxId,
        status: 'APPLIED',
        entityType: mutation.entityType,
        entityId: mutation.entityId,
        serverId: prescription._id.toString(),
        serverVersion: prescription.version,
      };
    }

    return {
      outboxId: mutation.outboxId,
      status: 'REJECTED',
      entityType: mutation.entityType,
      entityId: mutation.entityId,
      error: `Unsupported prescription sync action: ${mutation.action}`,
    };
  }

  // -------------------------------------------------------------------------
  // HELPER METHODS
  // -------------------------------------------------------------------------

  private async incrementClinicSeq(
    clinicId: Types.ObjectId,
    session: ClientSession,
  ): Promise<number> {
    const counter = await this.counterModel.findOneAndUpdate(
      { clinicId },
      { $inc: { lastSeq: 1 } },
      { upsert: true, returnDocument: 'after', session },
    );
    return counter.lastSeq;
  }

  private async findPatient(
    clinicId: Types.ObjectId,
    mutation: SyncMutationDto,
    session: ClientSession,
  ): Promise<PatientDocument | null> {
    if (mutation.serverId && Types.ObjectId.isValid(mutation.serverId)) {
      const p = await this.patientModel.findOne(
        { clinicId, _id: new Types.ObjectId(mutation.serverId) },
        null,
        { session },
      );
      if (p) return p;
    }

    if (Types.ObjectId.isValid(mutation.entityId)) {
      const p = await this.patientModel.findOne(
        { clinicId, _id: new Types.ObjectId(mutation.entityId) },
        null,
        { session },
      );
      if (p) return p;
    }

    return this.patientModel.findOne(
      { clinicId, patientId: mutation.entityId },
      null,
      { session },
    );
  }

  private async findConsultation(
    clinicId: Types.ObjectId,
    mutation: SyncMutationDto,
    session: ClientSession,
  ): Promise<ConsultationDocument | null> {
    const targetId = mutation.serverId || mutation.entityId;
    if (Types.ObjectId.isValid(targetId)) {
      return this.consultationModel.findOne(
        { clinicId, _id: new Types.ObjectId(targetId) },
        null,
        { session },
      );
    }
    return null;
  }

  private async findPrescription(
    clinicId: Types.ObjectId,
    mutation: SyncMutationDto,
    session: ClientSession,
  ): Promise<PrescriptionDocument | null> {
    const targetId = mutation.serverId || mutation.entityId;
    if (Types.ObjectId.isValid(targetId)) {
      return this.prescriptionModel.findOne(
        { clinicId, _id: new Types.ObjectId(targetId) },
        null,
        { session },
      );
    }
    return this.prescriptionModel.findOne(
      { clinicId, prescriptionNumber: mutation.entityId },
      null,
      { session },
    );
  }
}
