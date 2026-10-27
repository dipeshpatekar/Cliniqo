import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectModel, InjectConnection } from '@nestjs/mongoose';
import type { Connection, ClientSession } from 'mongoose';
import { Model, Types } from 'mongoose';
import {
  Patient,
  PatientDocument,
  PatientGender,
  PatientStatus,
} from './schemas/patient.schema.js';
import {
  ClinicSequenceCounter,
  ClinicSequenceCounterDocument,
} from './schemas/clinic-sequence-counter.schema.js';
import {
  ClinicAuditLog,
  ClinicAuditLogDocument,
  ClinicAuditAction,
} from '../clinic/schemas/clinic-audit-log.schema.js';
import { executeInTransaction } from '../database/transaction.helper.js';
import { CreatePatientDto } from './dto/create-patient.dto.js';
import { UpdatePatientDto } from './dto/update-patient.dto.js';
import {
  QueryPatientsDto,
  PatientSortOption,
} from './dto/query-patients.dto.js';

export function isCounterInitializationRace(err: any): boolean {
  if (err?.code !== 11000) return false;
  const hasSequenceKey =
    err?.keyPattern?.sequenceName !== undefined &&
    err?.keyPattern?.clinicId !== undefined;
  const isCounterIndex =
    typeof err?.message === 'string' &&
    (err.message.includes('clinic_counters') ||
      err.message.includes('clinicId_1_sequenceName_1') ||
      err.message.includes('uniq_clinic_sequence_counter'));
  return hasSequenceKey || isCounterIndex;
}

export function normalizePhoneNumber(rawPhone: string): string {
  if (!rawPhone || typeof rawPhone !== 'string') {
    throw new BadRequestException('Phone number is required');
  }
  // Strip all non-digit characters
  const digitsOnly = rawPhone.replace(/\D/g, '');
  if (digitsOnly.length === 10) {
    return digitsOnly;
  }
  // If Indian country code +91 prefix (12 digits)
  if (digitsOnly.length === 12 && digitsOnly.startsWith('91')) {
    return digitsOnly.slice(2);
  }
  // If leading 0 prefix (11 digits)
  if (digitsOnly.length === 11 && digitsOnly.startsWith('0')) {
    return digitsOnly.slice(1);
  }
  throw new BadRequestException(
    'Phone number must be a valid 10-digit mobile number',
  );
}

export function computeInitials(name: string): string {
  if (!name || typeof name !== 'string') return 'PT';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'PT';
  if (parts.length === 1) {
    const single = parts[0].toUpperCase();
    return single.length >= 2 ? single.slice(0, 2) : `${single}X`;
  }
  const first = parts[0][0].toUpperCase();
  const last = parts[parts.length - 1][0].toUpperCase();
  return `${first}${last}`;
}

@Injectable()
export class PatientService {
  private readonly logger = new Logger(PatientService.name);

  constructor(
    @InjectModel(Patient.name)
    private readonly patientModel: Model<PatientDocument>,
    @InjectModel(ClinicSequenceCounter.name)
    private readonly counterModel: Model<ClinicSequenceCounterDocument>,
    @InjectModel(ClinicAuditLog.name)
    private readonly auditLogModel: Model<ClinicAuditLogDocument>,
    @InjectConnection()
    private readonly connection: Connection,
  ) {}

  /**
   * Generates next sequential patient ID for a clinic (P-00101, P-00102, ...).
   * Atomically upserts counter with initial value 101 on first registration using
   * an aggregation pipeline update.
   */
  async generatePatientId(
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

    const maxStandaloneRetries = session ? 1 : 3;
    let attempt = 0;

    while (attempt < maxStandaloneRetries) {
      attempt++;
      try {
        const doc = await this.counterModel.findOneAndUpdate(
          { clinicId, sequenceName: 'patient' },
          updatePipeline,
          {
            upsert: true,
            returnDocument: 'after',
            ...(session ? { session } : {}),
          },
        );

        if (!doc || typeof doc.seq !== 'number') {
          throw new Error('Failed to generate sequence number for patient');
        }

        return `P-${String(doc.seq).padStart(5, '0')}`;
      } catch (err: any) {
        if (!session && isCounterInitializationRace(err) && attempt < maxStandaloneRetries) {
          const jitter = Math.floor(Math.random() * 25);
          await new Promise((resolve) => setTimeout(resolve, 50 + jitter));
          continue;
        }
        // In session or retries exhausted, bubble up to transaction helper
        throw err;
      }
    }

    throw new Error('Retries exhausted while generating patient sequence');
  }

  /**
   * Registers a new patient in the specified clinic.
   * Atomic transaction: Sequence increment + Patient document + Audit log.
   */
  async createPatient(
    clinicId: Types.ObjectId,
    dto: CreatePatientDto,
    actorDoctorId: Types.ObjectId,
  ): Promise<PatientDocument> {
    const normalizedPhone = normalizePhoneNumber(dto.phone);
    const initials = computeInitials(dto.name);
    const allergies = Array.isArray(dto.allergies)
      ? Array.from(new Set(dto.allergies.map((s) => s.trim()).filter(Boolean)))
      : [];
    const conditions = Array.isArray(dto.conditions)
      ? Array.from(new Set(dto.conditions.map((s) => s.trim()).filter(Boolean)))
      : [];

    return executeInTransaction(
      this.connection,
      async (session) => {
        const patientId = await this.generatePatientId(clinicId, session);

        const [patient] = await this.patientModel.create(
          [
            {
              clinicId,
              patientId,
              name: dto.name.trim(),
              initials,
              age: dto.age,
              gender: dto.gender,
              phone: dto.phone.trim(),
              normalizedPhone,
              dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : null,
              alternatePhone: dto.alternatePhone?.trim() || null,
              address: dto.address?.trim() || null,
              allergies,
              conditions,
              status: PatientStatus.ACTIVE,
              createdBy: actorDoctorId,
              updatedBy: actorDoctorId,
              version: 1,
            },
          ],
          { session },
        );

        await this.auditLogModel.create(
          [
            {
              clinicId,
              actorDoctorId,
              action: ClinicAuditAction.PATIENT_CREATED,
              metadata: {
                patientId: patient.patientId,
                patientObjectId: patient._id.toString(),
                name: patient.name,
                phone: patient.phone,
                allergiesCount: allergies.length,
                conditionsCount: conditions.length,
              },
            },
          ],
          { session },
        );

        this.logger.log(
          `Registered patient ${patient.patientId} for clinic ${clinicId.toString()}`,
        );

        return patient;
      },
      { isRetryableError: isCounterInitializationRace },
    );
  }

  /**
   * Search and list patients within a clinic with filtering, sorting, and pagination.
   */
  async searchPatients(
    clinicId: Types.ObjectId,
    queryDto: QueryPatientsDto,
  ): Promise<{
    patients: Array<PatientDocument & { hasAllergyWarning: boolean }>;
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const filter: Record<string, any> = {
      clinicId,
      status: PatientStatus.ACTIVE,
    };

    if (queryDto.gender) {
      filter.gender = queryDto.gender;
    }

    if (queryDto.query && queryDto.query.trim()) {
      const q = queryDto.query.trim();
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const searchRegex = new RegExp(escaped, 'i');

      const orConditions: any[] = [
        { name: searchRegex },
        { patientId: searchRegex },
      ];

      // Check if query could be partial phone number
      const digits = q.replace(/\D/g, '');
      if (digits.length >= 3) {
        orConditions.push({ normalizedPhone: new RegExp(digits) });
      }

      filter.$or = orConditions;
    }

    let sortCriteria: Record<string, 1 | -1> = { updatedAt: -1 };
    if (queryDto.sort === PatientSortOption.NAME_ASC) {
      sortCriteria = { name: 1 };
    } else if (queryDto.sort === PatientSortOption.NEWEST) {
      sortCriteria = { createdAt: -1 };
    } else {
      sortCriteria = { lastVisitAt: -1, updatedAt: -1 };
    }

    const page = queryDto.page && queryDto.page > 0 ? queryDto.page : 1;
    const limit =
      queryDto.limit && queryDto.limit > 0 && queryDto.limit <= 100
        ? queryDto.limit
        : 20;
    const skip = (page - 1) * limit;

    const [patients, total] = await Promise.all([
      this.patientModel
        .find(filter)
        .sort(sortCriteria)
        .skip(skip)
        .limit(limit)
        .exec(),
      this.patientModel.countDocuments(filter).exec(),
    ]);

    const enriched = patients.map((p) => {
      const obj = p.toObject();
      return Object.assign({}, obj, {
        hasAllergyWarning:
          Array.isArray(obj.allergies) && obj.allergies.length > 0,
      }) as PatientDocument & { hasAllergyWarning: boolean };
    });

    return {
      patients: enriched,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    };
  }

  /**
   * Retrieves single patient by patientId (e.g. 'P-00101') or Mongo ObjectId.
   * Enforces clinic isolation.
   */
  async getPatientById(
    clinicId: Types.ObjectId,
    patientIdentifier: string,
  ): Promise<any> {
    const isObjectId = Types.ObjectId.isValid(patientIdentifier);
    const filter: Record<string, any> = {
      clinicId,
      status: PatientStatus.ACTIVE,
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

    const patientObj = patient.toObject();
    return Object.assign({}, patientObj, {
      hasAllergyWarning:
        Array.isArray(patientObj.allergies) && patientObj.allergies.length > 0,
    });
  }

  /**
   * Updates patient details inside a transaction with audit logging.
   */
  async updatePatient(
    clinicId: Types.ObjectId,
    patientIdentifier: string,
    dto: UpdatePatientDto,
    actorDoctorId: Types.ObjectId,
  ): Promise<PatientDocument> {
    const isObjectId = Types.ObjectId.isValid(patientIdentifier);
    const filter: Record<string, any> = {
      clinicId,
      status: PatientStatus.ACTIVE,
      ...(isObjectId
        ? {
            $or: [
              { _id: new Types.ObjectId(patientIdentifier) },
              { patientId: patientIdentifier },
            ],
          }
        : { patientId: patientIdentifier }),
    };

    return executeInTransaction(this.connection, async (session) => {
      const existing = await this.patientModel.findOne(filter).session(session);
      if (!existing) {
        throw new NotFoundException('Patient not found in this clinic');
      }

      const updates: Record<string, any> = {
        updatedBy: actorDoctorId,
      };

      if (dto.name !== undefined) {
        updates.name = dto.name.trim();
        updates.initials = computeInitials(dto.name);
      }
      if (dto.age !== undefined) updates.age = dto.age;
      if (dto.gender !== undefined) updates.gender = dto.gender;
      if (dto.phone !== undefined) {
        updates.phone = dto.phone.trim();
        updates.normalizedPhone = normalizePhoneNumber(dto.phone);
      }
      if (dto.dateOfBirth !== undefined) {
        updates.dateOfBirth = dto.dateOfBirth ? new Date(dto.dateOfBirth) : null;
      }
      if (dto.alternatePhone !== undefined) {
        updates.alternatePhone = dto.alternatePhone?.trim() || null;
      }
      if (dto.address !== undefined) {
        updates.address = dto.address?.trim() || null;
      }
      if (dto.allergies !== undefined) {
        updates.allergies = Array.from(
          new Set(dto.allergies.map((s) => s.trim()).filter(Boolean)),
        );
      }
      if (dto.conditions !== undefined) {
        updates.conditions = Array.from(
          new Set(dto.conditions.map((s) => s.trim()).filter(Boolean)),
        );
      }

      const updated = await this.patientModel.findOneAndUpdate(
        { _id: existing._id, clinicId },
        {
          $set: updates,
          $inc: { version: 1 },
        },
        { new: true, session },
      );

      if (!updated) {
        throw new NotFoundException('Patient not found during update');
      }

      await this.auditLogModel.create(
        [
          {
            clinicId,
            actorDoctorId,
            action: ClinicAuditAction.PATIENT_UPDATED,
            metadata: {
              patientId: updated.patientId,
              patientObjectId: updated._id.toString(),
              updatedFields: Object.keys(updates),
            },
          },
        ],
        { session },
      );

      return updated;
    });
  }

  /**
   * Soft-archives a patient. Hard deletions are blocked to protect audit integrity.
   */
  async archivePatient(
    clinicId: Types.ObjectId,
    patientIdentifier: string,
    actorDoctorId: Types.ObjectId,
  ): Promise<{ success: boolean; message: string }> {
    const isObjectId = Types.ObjectId.isValid(patientIdentifier);
    const filter: Record<string, any> = {
      clinicId,
      status: PatientStatus.ACTIVE,
      ...(isObjectId
        ? {
            $or: [
              { _id: new Types.ObjectId(patientIdentifier) },
              { patientId: patientIdentifier },
            ],
          }
        : { patientId: patientIdentifier }),
    };

    return executeInTransaction(this.connection, async (session) => {
      const existing = await this.patientModel.findOne(filter).session(session);
      if (!existing) {
        throw new NotFoundException('Patient not found in this clinic');
      }

      existing.status = PatientStatus.ARCHIVED;
      existing.updatedBy = actorDoctorId;
      await existing.save({ session });

      await this.auditLogModel.create(
        [
          {
            clinicId,
            actorDoctorId,
            action: ClinicAuditAction.PATIENT_ARCHIVED,
            metadata: {
              patientId: existing.patientId,
              patientObjectId: existing._id.toString(),
            },
          },
        ],
        { session },
      );

      return {
        success: true,
        message: `Patient ${existing.patientId} archived successfully`,
      };
    });
  }

  /**
   * Checks whether a phone number is already registered to an active patient in the clinic.
   * Used by UI to display warning banner before registration.
   */
  async checkDuplicatePhone(
    clinicId: Types.ObjectId,
    rawPhone: string,
  ): Promise<{
    exists: boolean;
    matches: Array<{
      patientId: string;
      name: string;
      phone: string;
      age: number;
      gender: PatientGender;
    }>;
  }> {
    try {
      const normalizedPhone = normalizePhoneNumber(rawPhone);
      const matches = await this.patientModel
        .find({
          clinicId,
          normalizedPhone,
          status: PatientStatus.ACTIVE,
        })
        .select('patientId name phone age gender')
        .lean()
        .exec();

      return {
        exists: matches.length > 0,
        matches: matches.map((m) => ({
          patientId: m.patientId,
          name: m.name,
          phone: m.phone,
          age: m.age,
          gender: m.gender,
        })),
      };
    } catch {
      return { exists: false, matches: [] };
    }
  }
}
