import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { Types } from 'mongoose';
import type { Model, Connection } from 'mongoose';
import { SyncService } from './sync.service.js';
import { SyncPushDto } from './dto/sync-push.dto.js';
import { SyncActionType, SyncEntityType } from './schemas/sync-change-feed.schema.js';
import { PatientGender } from '../patient/schemas/patient.schema.js';
import type { PatientDocument } from '../patient/schemas/patient.schema.js';
import type { SyncChangeFeedDocument } from './schemas/sync-change-feed.schema.js';
import type { ClinicSyncCounterDocument } from './schemas/clinic-sync-counter.schema.js';
import type { SyncConflictDocument } from './schemas/sync-conflict.schema.js';
import type { IdempotencyRecordDocument } from '../common/schemas/idempotency-record.schema.js';
import type { ConsultationDocument } from '../consultation/schemas/consultation.schema.js';
import type { PrescriptionDocument } from '../prescription/schemas/prescription.schema.js';
import type { PrescriptionRevisionDocument } from '../prescription/schemas/prescription-revision.schema.js';
import type { ClinicSequenceCounterDocument } from '../patient/schemas/clinic-sequence-counter.schema.js';
import type { InvoiceDocument } from '../billing/schemas/invoice.schema.js';

interface MockPatientDocument {
  _id: Types.ObjectId;
  clinicId?: Types.ObjectId;
  patientId?: string;
  name?: string;
  gender?: PatientGender;
  age?: number;
  phone?: string;
  normalizedPhone?: string;
  version?: number;
  save: Mock<() => Promise<unknown>>;
  toObject: () => Record<string, unknown>;
  [key: string]: unknown;
}

interface MockPatientModel {
  (doc?: Record<string, unknown>): MockPatientDocument;
  new (doc?: Record<string, unknown>): MockPatientDocument;
  create: Mock<(docs: Record<string, unknown>[], options?: unknown) => Promise<MockPatientDocument[]>>;
  findOne: Mock<(filter: { _id?: Types.ObjectId; clinicId?: Types.ObjectId; patientId?: string }, projection?: unknown, options?: unknown) => Promise<MockPatientDocument | null>>;
}

describe('SyncService Patient Gender Normalization & Sync Boundary', () => {
  let service: SyncService;

  let mockConnection: unknown;
  let mockChangeFeedModel: unknown;
  let mockCounterModel: unknown;
  let mockConflictModel: unknown;
  let mockIdempotencyModel: unknown;
  let mockPatientModel: MockPatientModel;
  let mockConsultationModel: unknown;
  let mockPrescriptionModel: unknown;
  let mockRevisionModel: unknown;
  let mockSeqCounterModel: unknown;
  let mockInvoiceModel: unknown;

  const clinicId = new Types.ObjectId('672bb0000000000000000001');
  const doctorId = new Types.ObjectId('672aa0000000000000000001');
  const patientId = new Types.ObjectId('672cc0000000000000000001');

  beforeEach(() => {
    const mockSession = {
      withTransaction: vi.fn(async (cb: () => Promise<void>) => {
        await cb();
      }),
      endSession: vi.fn(),
    };

    mockConnection = {
      startSession: vi.fn().mockResolvedValue(mockSession),
    };

    mockChangeFeedModel = {
      create: vi.fn().mockResolvedValue([{}]),
      find: vi.fn(),
    };

    mockCounterModel = {
      findOneAndUpdate: vi.fn().mockResolvedValue({ lastSeq: 10 }),
      findOne: vi.fn().mockResolvedValue({ lastSeq: 10 }),
    };

    mockConflictModel = {
      create: vi.fn().mockResolvedValue([{}]),
    };

    mockIdempotencyModel = {
      findOne: vi.fn().mockResolvedValue(null),
      findOneAndUpdate: vi.fn().mockResolvedValue({}),
      updateOne: vi.fn().mockResolvedValue({}),
    };

    const mockModelFn = vi.fn().mockImplementation(function (
      this: Partial<MockPatientDocument>,
      doc?: Record<string, unknown>,
    ) {
      if (doc) {
        Object.assign(this, doc);
      }
      this._id = (doc?._id as Types.ObjectId) ?? new Types.ObjectId();
      this.version = (doc?.version as number) ?? 1;
      this.save = vi.fn().mockResolvedValue(this);
      this.toObject = () => ({ ...this });
    });

    const MockPatientModel: MockPatientModel = Object.assign(mockModelFn, {
      create: vi.fn(),
      findOne: vi.fn(),
    });

    MockPatientModel.create = vi.fn().mockImplementation((docs: Record<string, unknown>[]) => {
      return Promise.resolve(
        docs.map((d) => {
          const instance: MockPatientDocument = {
            ...d,
            _id: (d._id as Types.ObjectId) ?? new Types.ObjectId(),
            version: (d.version as number) ?? 1,
            save: vi.fn().mockResolvedValue(d),
            toObject: () => ({ ...d, _id: instance._id }),
          };
          return instance;
        }),
      );
    });

    MockPatientModel.findOne = vi.fn().mockImplementation((filter: { _id?: Types.ObjectId }) => {
      if (filter._id && filter._id.equals(patientId)) {
        const instance: MockPatientDocument = {
          _id: patientId,
          clinicId,
          patientId: 'P-1048',
          name: 'Ananya Iyer',
          gender: PatientGender.FEMALE,
          age: 34,
          phone: '+919876543210',
          normalizedPhone: '919876543210',
          version: 1,
          save: vi.fn().mockResolvedValue(true),
          toObject: () => ({
            _id: patientId,
            clinicId,
            patientId: 'P-1048',
            name: 'Ananya Iyer',
            gender: PatientGender.FEMALE,
            age: 34,
            phone: '+919876543210',
          }),
        };
        return Promise.resolve(instance);
      }
      return Promise.resolve(null);
    });

    mockPatientModel = MockPatientModel;

    mockConsultationModel = { findOne: vi.fn().mockResolvedValue(null) };
    mockPrescriptionModel = { findOne: vi.fn().mockResolvedValue(null) };
    mockRevisionModel = { findOne: vi.fn().mockResolvedValue(null) };
    mockInvoiceModel = { findOne: vi.fn().mockResolvedValue(null) };
    mockSeqCounterModel = {
      findOneAndUpdate: vi.fn().mockResolvedValue({ seq: 1049 }),
    };

    service = new SyncService(
      mockConnection as unknown as Connection,
      mockChangeFeedModel as unknown as Model<SyncChangeFeedDocument>,
      mockCounterModel as unknown as Model<ClinicSyncCounterDocument>,
      mockConflictModel as unknown as Model<SyncConflictDocument>,
      mockIdempotencyModel as unknown as Model<IdempotencyRecordDocument>,
      mockPatientModel as unknown as Model<PatientDocument>,
      mockConsultationModel as unknown as Model<ConsultationDocument>,
      mockPrescriptionModel as unknown as Model<PrescriptionDocument>,
      mockRevisionModel as unknown as Model<PrescriptionRevisionDocument>,
      mockSeqCounterModel as unknown as Model<ClinicSequenceCounterDocument>,
      mockInvoiceModel as unknown as Model<InvoiceDocument>,
    );
  });

  describe('normalizePatientGender unit method tests', () => {
    it('accepts canonical uppercase PatientGender enum values', () => {
      expect(service.normalizePatientGender('MALE')).toEqual({ gender: PatientGender.MALE });
      expect(service.normalizePatientGender('FEMALE')).toEqual({ gender: PatientGender.FEMALE });
      expect(service.normalizePatientGender('OTHER')).toEqual({ gender: PatientGender.OTHER });
    });

    it('normalizes legacy TitleCase values used by frontend and SQLite', () => {
      expect(service.normalizePatientGender('Male')).toEqual({ gender: PatientGender.MALE });
      expect(service.normalizePatientGender('Female')).toEqual({ gender: PatientGender.FEMALE });
      expect(service.normalizePatientGender('Other')).toEqual({ gender: PatientGender.OTHER });
    });

    it('normalizes lowercase and whitespace-padded variants', () => {
      expect(service.normalizePatientGender('  male  ')).toEqual({ gender: PatientGender.MALE });
      expect(service.normalizePatientGender('female')).toEqual({ gender: PatientGender.FEMALE });
      expect(service.normalizePatientGender('other')).toEqual({ gender: PatientGender.OTHER });
    });

    it('normalizes single-letter abbreviations (M, F, O)', () => {
      expect(service.normalizePatientGender('M')).toEqual({ gender: PatientGender.MALE });
      expect(service.normalizePatientGender('m')).toEqual({ gender: PatientGender.MALE });
      expect(service.normalizePatientGender('F')).toEqual({ gender: PatientGender.FEMALE });
      expect(service.normalizePatientGender('f')).toEqual({ gender: PatientGender.FEMALE });
      expect(service.normalizePatientGender('O')).toEqual({ gender: PatientGender.OTHER });
      expect(service.normalizePatientGender('o')).toEqual({ gender: PatientGender.OTHER });
    });

    it('normalizes frontend non-binary and prefer-not-to-say options to canonical OTHER', () => {
      expect(service.normalizePatientGender('Non-binary')).toEqual({ gender: PatientGender.OTHER });
      expect(service.normalizePatientGender('nonbinary')).toEqual({ gender: PatientGender.OTHER });
      expect(service.normalizePatientGender('Prefer not to say')).toEqual({ gender: PatientGender.OTHER });
    });

    it('safely rejects unknown or invalid string values with a clear validation error', () => {
      const res = service.normalizePatientGender('Alien');
      expect(res.gender).toBeNull();
      expect(res.error).toContain("Patient validation failed: gender: Alien is not a valid enum value");

      const res2 = service.normalizePatientGender('Unknown');
      expect(res2.gender).toBeNull();
      expect(res2.error).toContain('is not a valid enum value');
    });

    it('safely rejects non-string inputs and empty strings with validation errors', () => {
      expect(service.normalizePatientGender('')).toEqual({
        gender: null,
        error: 'Patient validation failed: gender: value is required and cannot be empty.',
      });
      expect(service.normalizePatientGender(null)).toEqual({
        gender: null,
        error: 'Patient validation failed: gender: value is required and cannot be empty.',
      });
      expect(service.normalizePatientGender(undefined)).toEqual({
        gender: null,
        error: 'Patient validation failed: gender: value is required and cannot be empty.',
      });
      expect(service.normalizePatientGender(123)).toEqual({
        gender: null,
        error: 'Patient validation failed: gender: number is not a valid gender string.',
      });
    });
  });

  describe('Sync Push Patient Mutation Integration', () => {
    it('successfully syncs patient created with TitleCase "Male" (Render bug reproduction)', async () => {
      const dto: SyncPushDto = {
        mutations: [
          {
            outboxId: 'outbox-patient-001',
            entityType: SyncEntityType.PATIENT,
            action: SyncActionType.CREATE,
            idempotencyKey: 'idem-patient-001',
            entityId: 'client-pt-001',
            clientVersion: 1,
            payload: {
              patientCode: 'PC-1049',
              name: 'Vikram Mehta',
              gender: 'Male', // Exact TitleCase from SQLite/UI that broke in production
              age: 52,
              phone: '+919820411882',
            },
          },
        ],
      };

      const result = await service.push(clinicId, doctorId, dto);

      expect(result.results).toHaveLength(1);
      expect(result.results[0].status).toBe('APPLIED');
      expect(result.results[0].outboxId).toBe('outbox-patient-001');

      // Verify that Mongoose model received canonical 'MALE'
      expect(mockPatientModel.create).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            name: 'Vikram Mehta',
            gender: PatientGender.MALE,
            patientId: 'PC-1049',
          }),
        ],
        expect.anything(),
      );
    });

    it('successfully syncs patient created with TitleCase "Female"', async () => {
      const dto: SyncPushDto = {
        mutations: [
          {
            outboxId: 'outbox-patient-002',
            entityType: SyncEntityType.PATIENT,
            action: SyncActionType.CREATE,
            idempotencyKey: 'idem-patient-002',
            entityId: 'client-pt-002',
            clientVersion: 1,
            payload: {
              patientCode: 'PC-1050',
              name: 'Sana Kapoor',
              gender: 'Female',
              age: 28,
              phone: '+919987622109',
            },
          },
        ],
      };

      const result = await service.push(clinicId, doctorId, dto);

      expect(result.results[0].status).toBe('APPLIED');
      expect(mockPatientModel.create).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            name: 'Sana Kapoor',
            gender: PatientGender.FEMALE,
          }),
        ],
        expect.anything(),
      );
    });

    it('rejects patient creation when gender is an invalid unrecognized string', async () => {
      const dto: SyncPushDto = {
        mutations: [
          {
            outboxId: 'outbox-patient-bad',
            entityType: SyncEntityType.PATIENT,
            action: SyncActionType.CREATE,
            idempotencyKey: 'idem-patient-bad',
            entityId: 'client-pt-bad',
            clientVersion: 1,
            payload: {
              patientCode: 'PC-9999',
              name: 'Invalid Test',
              gender: 'InvalidAlienGender',
              age: 25,
              phone: '+919999999999',
            },
          },
        ],
      };

      const result = await service.push(clinicId, doctorId, dto);

      expect(result.results[0].status).toBe('REJECTED');
      expect(result.results[0].error).toContain('is not a valid enum value');
      expect(mockPatientModel.create).not.toHaveBeenCalled();
    });

    it('rejects patient creation when gender is omitted or empty', async () => {
      const dto: SyncPushDto = {
        mutations: [
          {
            outboxId: 'outbox-patient-empty',
            entityType: SyncEntityType.PATIENT,
            action: SyncActionType.CREATE,
            idempotencyKey: 'idem-patient-empty',
            entityId: 'client-pt-empty',
            clientVersion: 1,
            payload: {
              patientCode: 'PC-9998',
              name: 'No Gender Test',
              gender: '',
              age: 30,
              phone: '+919999999998',
            },
          },
        ],
      };

      const result = await service.push(clinicId, doctorId, dto);

      expect(result.results[0].status).toBe('REJECTED');
      expect(result.results[0].error).toContain('value is required and cannot be empty');
      expect(mockPatientModel.create).not.toHaveBeenCalled();
    });

    it('handles patient UPDATE with normalized gender', async () => {
      const dto: SyncPushDto = {
        mutations: [
          {
            outboxId: 'outbox-patient-upd',
            entityType: SyncEntityType.PATIENT,
            action: SyncActionType.UPDATE,
            idempotencyKey: 'idem-patient-upd',
            entityId: patientId.toString(),
            serverId: patientId.toString(),
            clientVersion: 1,
            payload: {
              gender: 'Other', // TitleCase update
            },
          },
        ],
      };

      const result = await service.push(clinicId, doctorId, dto);

      expect(result.results[0].status).toBe('APPLIED');
      expect(result.results[0].serverVersion).toBe(2);
    });

    it('rejects patient UPDATE with invalid gender value', async () => {
      const dto: SyncPushDto = {
        mutations: [
          {
            outboxId: 'outbox-patient-upd-bad',
            entityType: SyncEntityType.PATIENT,
            action: SyncActionType.UPDATE,
            idempotencyKey: 'idem-patient-upd-bad',
            entityId: patientId.toString(),
            serverId: patientId.toString(),
            clientVersion: 1,
            payload: {
              gender: 'NotAGender',
            },
          },
        ],
      };

      const result = await service.push(clinicId, doctorId, dto);

      expect(result.results[0].status).toBe('REJECTED');
      expect(result.results[0].error).toContain('is not a valid enum value');
    });

    it('allows successful sync retry when a rejected mutation is retried with valid gender payload', async () => {
      // Step 1: Failed mutation with invalid gender
      const failedDto: SyncPushDto = {
        mutations: [
          {
            outboxId: 'outbox-retry-001',
            entityType: SyncEntityType.PATIENT,
            action: SyncActionType.CREATE,
            idempotencyKey: 'idem-retry-001',
            entityId: 'client-pt-retry-001',
            clientVersion: 1,
            payload: {
              patientCode: 'PC-1051',
              name: 'Retry Patient',
              gender: 'WrongValue',
              age: 40,
              phone: '+919876500000',
            },
          },
        ],
      };

      const failResult = await service.push(clinicId, doctorId, failedDto);
      expect(failResult.results[0].status).toBe('REJECTED');

      // Step 2: Retry with corrected TitleCase gender 'Male'
      const retryDto: SyncPushDto = {
        mutations: [
          {
            outboxId: 'outbox-retry-001',
            entityType: SyncEntityType.PATIENT,
            action: SyncActionType.CREATE,
            idempotencyKey: 'idem-retry-002', // fresh idempotency key for corrected payload
            entityId: 'client-pt-retry-001',
            clientVersion: 1,
            payload: {
              patientCode: 'PC-1051',
              name: 'Retry Patient',
              gender: 'Male',
              age: 40,
              phone: '+919876500000',
            },
          },
        ],
      };

      const successResult = await service.push(clinicId, doctorId, retryDto);
      expect(successResult.results[0].status).toBe('APPLIED');
      expect(mockPatientModel.create).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            name: 'Retry Patient',
            gender: PatientGender.MALE,
            patientId: 'PC-1051',
          }),
        ],
        expect.anything(),
      );
    });
  });
});
