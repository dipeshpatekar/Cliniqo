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
import { Model, Connection, Types } from 'mongoose';
import { createHash, randomUUID } from 'crypto';
import {
  Consultation,
  ConsultationDocument,
  ConsultationStatus,
} from './schemas/consultation.schema.js';
import {
  ConsultationAddendum,
  ConsultationAddendumDocument,
} from './schemas/consultation-addendum.schema.js';
import {
  IdempotencyRecord,
  IdempotencyRecordDocument,
} from '../common/schemas/idempotency-record.schema.js';
import {
  Patient,
  PatientDocument,
  PatientStatus,
} from '../patient/schemas/patient.schema.js';
import {
  ClinicAuditLog,
  ClinicAuditLogDocument,
  ClinicAuditAction,
} from '../clinic/schemas/clinic-audit-log.schema.js';
import { ClinicRole } from '../clinic/schemas/clinic-membership.schema.js';
import { executeInTransaction } from '../database/transaction.helper.js';
import { redactString } from '../common/logging/app-logger.service.js';
import { CreateConsultationDto } from './dto/create-consultation.dto.js';
import { UpdateConsultationDto } from './dto/update-consultation.dto.js';
import { FinalizeConsultationDto } from './dto/finalize-consultation.dto.js';
import { AddAddendumDto } from './dto/add-addendum.dto.js';
import { CancelConsultationDto } from './dto/cancel-consultation.dto.js';
import { QueryConsultationsDto } from './dto/query-consultations.dto.js';
import { VitalsDto } from './dto/vitals.dto.js';

export interface ClinicalSnapshot {
  consultationId: Types.ObjectId;
  patientId: Types.ObjectId;
  patientCode: string;
  doctorId: Types.ObjectId;
  consultationDate: Date;
  chiefComplaint: string;
  diagnosis: string;
  vitals: Record<string, any>;
  provisionalMedicines: any[];
}

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

export function validateVitalsCoupling(vitals?: VitalsDto): void {
  if (!vitals) return;
  if (
    typeof vitals.systolic === 'number' &&
    typeof vitals.diastolic === 'number'
  ) {
    if (vitals.systolic < vitals.diastolic + 10) {
      throw new BadRequestException(
        'Systolic blood pressure must be at least 10 mmHg greater than diastolic blood pressure',
      );
    }
  }
}

export function validateConsultationDate(dateStr?: string): Date {
  if (!dateStr) return new Date();
  const parsed = new Date(dateStr);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException('Invalid consultation date format');
  }
  const maxFuture = Date.now() + 24 * 60 * 60 * 1000;
  if (parsed.getTime() > maxFuture) {
    throw new BadRequestException(
      'Consultation date cannot be set more than 24 hours into the future',
    );
  }
  return parsed;
}

@Injectable()
export class ConsultationService {
  private readonly logger = new Logger(ConsultationService.name);

  constructor(
    @InjectModel(Consultation.name)
    private readonly consultationModel: Model<ConsultationDocument>,
    @InjectModel(ConsultationAddendum.name)
    private readonly addendumModel: Model<ConsultationAddendumDocument>,
    @InjectModel(IdempotencyRecord.name)
    private readonly idempotencyModel: Model<IdempotencyRecordDocument>,
    @InjectModel(Patient.name)
    private readonly patientModel: Model<PatientDocument>,
    @InjectModel(ClinicAuditLog.name)
    private readonly auditLogModel: Model<ClinicAuditLogDocument>,
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
   */
  private async markIdempotencyFailed(
    clinicId: Types.ObjectId,
    key: string,
    claimToken: string,
    err: any,
  ): Promise<void> {
    try {
      await this.idempotencyModel.updateOne(
        {
          clinicId,
          key,
          claimToken,
          status: 'PROCESSING',
        },
        {
          $set: {
            status: 'FAILED',
            lockedUntil: null,
            lastError: redactString(err?.message || 'Transaction aborted'),
          },
        },
      );
    } catch (updateErr: any) {
      this.logger.error(
        `Failed to mark idempotency record failed: ${updateErr.message}`,
      );
    }
  }

  /**
   * Resolves patient within clinic scope by ObjectId or human-readable patientId.
   */
  private async resolvePatientInClinic(
    clinicId: Types.ObjectId,
    patientIdentifier: string,
  ): Promise<PatientDocument> {
    const isObjectId = Types.ObjectId.isValid(patientIdentifier);
    const filter: Record<string, any> = {
      clinicId,
      ...(isObjectId
        ? {
            $or: [
              { _id: new Types.ObjectId(patientIdentifier) },
              { patientId: patientIdentifier },
            ],
          }
        : { patientId: patientIdentifier }),
    };

    const patient = await this.patientModel.findOne(filter).exec();
    if (!patient) {
      throw new NotFoundException('Patient not found in this clinic');
    }
    return patient;
  }

  /**
   * Starts a new draft consultation for a patient in the clinic.
   */
  async createConsultation(
    clinicId: Types.ObjectId,
    patientIdentifier: string,
    dto: CreateConsultationDto,
    actorDoctorId: Types.ObjectId,
    idempotencyKey?: string,
  ): Promise<any> {
    const patient = await this.resolvePatientInClinic(
      clinicId,
      patientIdentifier,
    );

    if (patient.status === PatientStatus.ARCHIVED) {
      throw new BadRequestException(
        'Cannot start consultation for an archived patient. Reactivate the patient record first.',
      );
    }

    validateVitalsCoupling(dto.vitals);
    const consultationDate = validateConsultationDate(dto.consultationDate);

    let claimToken: string | undefined;
    const normalizedRoute = `/clinics/${clinicId.toString()}/patients/${patient._id.toString()}/consultations`;

    if (idempotencyKey && idempotencyKey.trim()) {
      const cleanKey = idempotencyKey.trim();
      const fingerprint = computeRequestFingerprint(
        'POST',
        normalizedRoute,
        dto,
      );
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
        const [consultation] = await this.consultationModel.create(
          [
            {
              clinicId,
              patientId: patient._id,
              patientCode: patient.patientId,
              doctorId: actorDoctorId,
              status: ConsultationStatus.DRAFT,
              consultationDate,
              consultationTime: dto.consultationTime || null,
              vitals: dto.vitals || {},
              chiefComplaint: dto.chiefComplaint?.trim() || '',
              symptomDuration: dto.symptomDuration?.trim() || null,
              diagnosis: dto.diagnosis?.trim() || '',
              clinicalNotes: dto.clinicalNotes?.trim() || null,
              followUp: dto.followUp || {},
              provisionalMedicines: dto.provisionalMedicines || [],
              version: 1,
              createdBy: actorDoctorId,
              updatedBy: actorDoctorId,
            },
          ],
          { session },
        );

        await this.auditLogModel.create(
          [
            {
              clinicId,
              actorDoctorId,
              action: ClinicAuditAction.CONSULTATION_CREATED,
              metadata: {
                consultationId: consultation._id.toString(),
                patientId: patient._id.toString(),
                patientCode: patient.patientId,
                status: consultation.status,
              },
            },
          ],
          { session },
        );

        const responsePayload = consultation.toObject();

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
            { returnDocument: 'after', session },
          );

          if (!fenced) {
            throw new ConflictException(
              'Idempotency lease expired or was revoked by a concurrent retry. Transaction aborted.',
            );
          }
        }

        return responsePayload;
      });
    } catch (err: any) {
      if (idempotencyKey && claimToken) {
        await this.markIdempotencyFailed(
          clinicId,
          idempotencyKey.trim(),
          claimToken,
          err,
        );
      }

      const errMsg =
        err?.driverMessage || err?.cause?.message || err?.message || '';
      if (
        (err?.code === 11000 || err?.cause?.code === 11000) &&
        typeof errMsg === 'string' &&
        errMsg.includes('uniq_active_consultation_draft_per_patient')
      ) {
        const existingDraft = await this.consultationModel
          .findOne({
            clinicId,
            patientId: patient._id,
            status: ConsultationStatus.DRAFT,
          })
          .select('_id patientId doctorId consultationDate createdAt')
          .exec();

        throw new ConflictException({
          statusCode: 409,
          message:
            'An active consultation draft already exists for this patient in this clinic.',
          existingConsultationId: existingDraft?._id?.toString(),
        });
      }

      throw err;
    }
  }

  /**
   * Retrieves paginated consultations for a patient within clinic scope.
   */
  async getPatientConsultations(
    clinicId: Types.ObjectId,
    patientIdentifier: string,
    query: QueryConsultationsDto,
  ): Promise<{
    consultations: any[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const patient = await this.resolvePatientInClinic(
      clinicId,
      patientIdentifier,
    );

    const filter: Record<string, any> = {
      clinicId,
      patientId: patient._id,
    };

    if (query.status) {
      filter.status = query.status;
    }
    if (query.doctorId && Types.ObjectId.isValid(query.doctorId)) {
      filter.doctorId = new Types.ObjectId(query.doctorId);
    }

    const page = Math.max(1, query.page || 1);
    const limit = Math.min(100, Math.max(1, query.limit || 20));
    const skip = (page - 1) * limit;

    const [consultations, total] = await Promise.all([
      this.consultationModel
        .find(filter)
        .populate('doctorId', 'firstName lastName email')
        .sort({ consultationDate: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      this.consultationModel.countDocuments(filter),
    ]);

    return {
      consultations,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    };
  }

  /**
   * Retrieves recent consultations for the clinic dashboard.
   */
  async getRecentConsultations(
    clinicId: Types.ObjectId,
    limit: number = 10,
  ): Promise<any[]> {
    const safeLimit = Math.min(50, Math.max(1, limit));
    return this.consultationModel
      .find({ clinicId })
      .populate('patientId', 'name initials age gender phone patientId allergies')
      .populate('doctorId', 'firstName lastName email')
      .sort({ consultationDate: -1, createdAt: -1 })
      .limit(safeLimit)
      .lean();
  }

  /**
   * Retrieves a single consultation by ID with its append-only addenda.
   */
  async getConsultationById(
    clinicId: Types.ObjectId,
    consultationId: string,
  ): Promise<any> {
    if (!Types.ObjectId.isValid(consultationId)) {
      throw new NotFoundException('Invalid consultation identifier');
    }

    const consultation = await this.consultationModel
      .findOne({ _id: new Types.ObjectId(consultationId), clinicId })
      .populate('patientId', 'name initials age gender phone patientId allergies conditions')
      .populate('doctorId', 'firstName lastName email')
      .populate('finalizedBy', 'firstName lastName email')
      .lean();

    if (!consultation) {
      throw new NotFoundException('Consultation not found in this clinic');
    }

    let addenda: any[] = [];
    if (consultation.hasAddenda) {
      addenda = await this.addendumModel
        .find({
          clinicId,
          consultationId: consultation._id,
        })
        .populate('authorDoctorId', 'firstName lastName email')
        .sort({ sequenceNumber: 1 })
        .lean();
    }

    return Object.assign({}, consultation, { addenda });
  }

  /**
   * Updates an in-progress draft consultation with mandatory optimistic version locking.
   */
  async updateConsultation(
    clinicId: Types.ObjectId,
    consultationId: string,
    dto: UpdateConsultationDto,
    actorDoctorId: Types.ObjectId,
  ): Promise<ConsultationDocument> {
    if (!Types.ObjectId.isValid(consultationId)) {
      throw new NotFoundException('Invalid consultation identifier');
    }

    validateVitalsCoupling(dto.vitals);
    const consultationObjId = new Types.ObjectId(consultationId);

    const updateFields: Record<string, any> = {
      updatedBy: actorDoctorId,
    };

    if (dto.consultationDate !== undefined) {
      updateFields.consultationDate = validateConsultationDate(
        dto.consultationDate,
      );
    }
    if (dto.consultationTime !== undefined) {
      updateFields.consultationTime = dto.consultationTime;
    }
    if (dto.vitals !== undefined) {
      updateFields.vitals = dto.vitals;
    }
    if (dto.chiefComplaint !== undefined) {
      updateFields.chiefComplaint = dto.chiefComplaint.trim();
    }
    if (dto.symptomDuration !== undefined) {
      updateFields.symptomDuration = dto.symptomDuration.trim();
    }
    if (dto.diagnosis !== undefined) {
      updateFields.diagnosis = dto.diagnosis.trim();
    }
    if (dto.clinicalNotes !== undefined) {
      updateFields.clinicalNotes = dto.clinicalNotes.trim();
    }
    if (dto.followUp !== undefined) {
      updateFields.followUp = dto.followUp;
    }
    if (dto.provisionalMedicines !== undefined) {
      updateFields.provisionalMedicines = dto.provisionalMedicines;
    }

    return executeInTransaction(this.connection, async (session) => {
      const updated = await this.consultationModel.findOneAndUpdate(
        {
          _id: consultationObjId,
          clinicId,
          status: ConsultationStatus.DRAFT,
          version: dto.expectedVersion,
        },
        {
          $set: updateFields,
          $inc: { version: 1 },
        },
        { returnDocument: 'after', session },
      );

      if (!updated) {
        const current = await this.consultationModel
          .findOne({ _id: consultationObjId, clinicId })
          .session(session);

        if (!current) {
          throw new NotFoundException('Consultation not found in this clinic');
        }
        if (current.status === ConsultationStatus.FINALIZED) {
          throw new ConflictException(
            'Finalized consultations are strictly immutable and cannot be modified.',
          );
        }
        if (current.version !== dto.expectedVersion) {
          throw new ConflictException(
            `Optimistic lock conflict: Consultation was modified by another session (current version: ${current.version}, expected: ${dto.expectedVersion}).`,
          );
        }
        throw new ConflictException('Unable to update consultation.');
      }

      await this.auditLogModel.create(
        [
          {
            clinicId,
            actorDoctorId,
            action: ClinicAuditAction.CONSULTATION_UPDATED,
            metadata: {
              consultationId: updated._id.toString(),
              patientId: updated.patientId.toString(),
              version: updated.version,
            },
          },
        ],
        { session },
      );

      return updated;
    });
  }

  /**
   * Finalizes a consultation, permanently locking clinical records and updating Patient.lastVisitAt.
   */
  async finalizeConsultation(
    clinicId: Types.ObjectId,
    consultationId: string,
    dto: FinalizeConsultationDto,
    actorDoctorId: Types.ObjectId,
    idempotencyKey?: string,
  ): Promise<any> {
    if (!Types.ObjectId.isValid(consultationId)) {
      throw new NotFoundException('Invalid consultation identifier');
    }

    validateVitalsCoupling(dto.vitals);
    const consultationObjId = new Types.ObjectId(consultationId);

    let claimToken: string | undefined;
    const normalizedRoute = `/clinics/${clinicId.toString()}/consultations/${consultationId}/finalize`;

    if (idempotencyKey && idempotencyKey.trim()) {
      const cleanKey = idempotencyKey.trim();
      const fingerprint = computeRequestFingerprint(
        'POST',
        normalizedRoute,
        dto,
      );
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
        const finalizeUpdates: Record<string, any> = {
          status: ConsultationStatus.FINALIZED,
          chiefComplaint: dto.chiefComplaint.trim(),
          diagnosis: dto.diagnosis.trim(),
          finalizedAt: new Date(),
          finalizedBy: actorDoctorId,
          updatedBy: actorDoctorId,
        };

        if (dto.symptomDuration !== undefined) {
          finalizeUpdates.symptomDuration = dto.symptomDuration.trim();
        }
        if (dto.clinicalNotes !== undefined) {
          finalizeUpdates.clinicalNotes = dto.clinicalNotes.trim();
        }
        if (dto.vitals !== undefined) {
          finalizeUpdates.vitals = dto.vitals;
        }
        if (dto.followUp !== undefined) {
          finalizeUpdates.followUp = dto.followUp;
        }
        if (dto.provisionalMedicines !== undefined) {
          finalizeUpdates.provisionalMedicines = dto.provisionalMedicines;
        }

        const finalized = await this.consultationModel.findOneAndUpdate(
          {
            _id: consultationObjId,
            clinicId,
            status: ConsultationStatus.DRAFT,
            version: dto.expectedVersion,
          },
          {
            $set: finalizeUpdates,
            $inc: { version: 1 },
          },
          { returnDocument: 'after', session },
        );

        if (!finalized) {
          const current = await this.consultationModel
            .findOne({ _id: consultationObjId, clinicId })
            .session(session);

          if (!current) {
            throw new NotFoundException('Consultation not found in this clinic');
          }
          if (current.status === ConsultationStatus.FINALIZED) {
            if (idempotencyKey) {
              return current.toObject();
            }
            throw new ConflictException('Consultation is already finalized.');
          }
          if (current.version !== dto.expectedVersion) {
            throw new ConflictException(
              `Optimistic lock conflict: Consultation was modified (current version: ${current.version}, expected: ${dto.expectedVersion}). Review changes before finalization.`,
            );
          }
          throw new ConflictException('Unable to finalize consultation.');
        }

        // Invariant: Patient.lastVisitAt never moves backward ($max)
        await this.patientModel.findOneAndUpdate(
          { _id: finalized.patientId, clinicId },
          {
            $max: { lastVisitAt: finalized.consultationDate },
            $set: { updatedBy: actorDoctorId },
          },
          { session },
        );

        await this.auditLogModel.create(
          [
            {
              clinicId,
              actorDoctorId,
              action: ClinicAuditAction.CONSULTATION_FINALIZED,
              metadata: {
                consultationId: finalized._id.toString(),
                patientId: finalized.patientId.toString(),
                finalizedAt: finalized.finalizedAt,
                version: finalized.version,
              },
            },
          ],
          { session },
        );

        const responsePayload = finalized.toObject();

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
            { returnDocument: 'after', session },
          );

          if (!fenced) {
            throw new ConflictException(
              'Idempotency lease expired or was revoked by a concurrent retry. Transaction aborted.',
            );
          }
        }

        return responsePayload;
      });
    } catch (err: any) {
      if (idempotencyKey && claimToken) {
        await this.markIdempotencyFailed(
          clinicId,
          idempotencyKey.trim(),
          claimToken,
          err,
        );
      }
      throw err;
    }
  }

  /**
   * Appends an immutable addendum to a finalized consultation with atomic sequence allocation.
   */
  async addAddendum(
    clinicId: Types.ObjectId,
    consultationId: string,
    dto: AddAddendumDto,
    actorDoctorId: Types.ObjectId,
  ): Promise<ConsultationAddendumDocument> {
    if (!Types.ObjectId.isValid(consultationId)) {
      throw new NotFoundException('Invalid consultation identifier');
    }

    const consultationObjId = new Types.ObjectId(consultationId);

    return executeInTransaction(this.connection, async (session) => {
      // 1. Atomically allocate sequence number on parent consultation
      const parent = await this.consultationModel.findOneAndUpdate(
        {
          _id: consultationObjId,
          clinicId,
          status: ConsultationStatus.FINALIZED,
        },
        {
          $inc: { addendumCount: 1, version: 1 },
          $set: { hasAddenda: true, updatedBy: actorDoctorId },
        },
        { returnDocument: 'after', session },
      );

      if (!parent) {
        const current = await this.consultationModel
          .findOne({ _id: consultationObjId, clinicId })
          .session(session);

        if (!current) {
          throw new NotFoundException('Consultation not found in this clinic');
        }
        if (current.status !== ConsultationStatus.FINALIZED) {
          throw new BadRequestException(
            'Addenda can only be appended to finalized consultations.',
          );
        }
        throw new ConflictException('Unable to append addendum to consultation.');
      }

      const sequenceNumber = parent.addendumCount;

      // 2. Insert into consultation_addenda with sequenceNumber
      const [addendum] = await this.addendumModel.create(
        [
          {
            clinicId,
            consultationId: parent._id,
            patientId: parent.patientId,
            authorDoctorId: actorDoctorId,
            note: dto.note.trim(),
            reasonForAddendum: dto.reasonForAddendum.trim(),
            sequenceNumber,
          },
        ],
        { session },
      );

      // 3. Atomically write audit log
      await this.auditLogModel.create(
        [
          {
            clinicId,
            actorDoctorId,
            action: ClinicAuditAction.CONSULTATION_ADDENDUM_ADDED,
            metadata: {
              consultationId: parent._id.toString(),
              addendumId: addendum._id.toString(),
              sequenceNumber,
              reasonForAddendum: addendum.reasonForAddendum,
            },
          },
        ],
        { session },
      );

      return addendum;
    });
  }

  /**
   * Cancels a draft consultation with doctor ownership check.
   */
  async cancelDraftConsultation(
    clinicId: Types.ObjectId,
    consultationId: string,
    actorDoctorId: Types.ObjectId,
    actorRole: ClinicRole,
    dto: CancelConsultationDto,
  ): Promise<{ message: string }> {
    if (!Types.ObjectId.isValid(consultationId)) {
      throw new NotFoundException('Invalid consultation identifier');
    }

    const consultationObjId = new Types.ObjectId(consultationId);
    const consultation = await this.consultationModel.findOne({
      _id: consultationObjId,
      clinicId,
    });

    if (!consultation) {
      throw new NotFoundException('Consultation not found in this clinic');
    }

    if (consultation.status === ConsultationStatus.FINALIZED) {
      throw new ConflictException(
        'Finalized clinical records cannot be cancelled or deleted. Use an addendum.',
      );
    }

    if (consultation.status === ConsultationStatus.CANCELLED) {
      return { message: 'Consultation is already cancelled.' };
    }

    // Ownership verification for doctors
    if (actorRole === ClinicRole.DOCTOR) {
      const isOwner =
        consultation.doctorId.toString() === actorDoctorId.toString() ||
        consultation.createdBy.toString() === actorDoctorId.toString();

      if (!isOwner) {
        throw new ForbiddenException(
          'You are not authorized to cancel a consultation draft created by another doctor.',
        );
      }
    }

    return executeInTransaction(this.connection, async (session) => {
      const updated = await this.consultationModel.findOneAndUpdate(
        {
          _id: consultationObjId,
          clinicId,
          status: ConsultationStatus.DRAFT,
        },
        {
          $set: {
            status: ConsultationStatus.CANCELLED,
            cancellationReason: dto.reason.trim(),
            cancelledAt: new Date(),
            cancelledBy: actorDoctorId,
            updatedBy: actorDoctorId,
          },
          $inc: { version: 1 },
        },
        { returnDocument: 'after', session },
      );

      if (!updated) {
        throw new ConflictException('Unable to cancel consultation draft.');
      }

      await this.auditLogModel.create(
        [
          {
            clinicId,
            actorDoctorId,
            action: ClinicAuditAction.CONSULTATION_CANCELLED,
            metadata: {
              consultationId: updated._id.toString(),
              patientId: (updated.patientId || consultation.patientId).toString(),
              cancellationReason: updated.cancellationReason,
            },
          },
        ],
        { session },
      );

      return { message: 'Consultation draft successfully cancelled.' };
    });
  }

  /**
   * Stable integration snapshot method for future Phase 3 Prescription Domain.
   */
  async getClinicalSnapshot(
    clinicId: Types.ObjectId,
    consultationId: Types.ObjectId,
  ): Promise<ClinicalSnapshot> {
    const consultation = await this.consultationModel.findOne({
      _id: consultationId,
      clinicId,
    });

    if (!consultation) {
      throw new NotFoundException('Consultation not found in this clinic');
    }

    return {
      consultationId: consultation._id,
      patientId: consultation.patientId,
      patientCode: consultation.patientCode,
      doctorId: consultation.doctorId,
      consultationDate: consultation.consultationDate,
      chiefComplaint: consultation.chiefComplaint,
      diagnosis: consultation.diagnosis,
      vitals: consultation.vitals as any,
      provisionalMedicines: consultation.provisionalMedicines,
    };
  }
}
