import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Types, Model, Connection } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { ConflictException } from '@nestjs/common';
import {
  ConsultationService,
  computeRequestFingerprint,
} from '../src/consultation/consultation.service.js';
import {
  Consultation,
  ConsultationSchema,
  ConsultationStatus,
  ConsultationDocument,
} from '../src/consultation/schemas/consultation.schema.js';
import {
  ConsultationAddendum,
  ConsultationAddendumSchema,
  ConsultationAddendumDocument,
} from '../src/consultation/schemas/consultation-addendum.schema.js';
import {
  IdempotencyRecord,
  IdempotencyRecordSchema,
  IdempotencyRecordDocument,
} from '../src/common/schemas/idempotency-record.schema.js';
import {
  Patient,
  PatientSchema,
  PatientStatus,
  PatientDocument,
  PatientGender,
} from '../src/patient/schemas/patient.schema.js';
import {
  ClinicAuditLog,
  ClinicAuditLogSchema,
  ClinicAuditAction,
  ClinicAuditLogDocument,
} from '../src/clinic/schemas/clinic-audit-log.schema.js';
import { executeInTransaction } from '../src/database/transaction.helper.js';

/**
 * Strict security assertion: strictly forbids connecting to any remote host or production Atlas database.
 */
function assertSafeLocalUri(uri: string): void {
  const url = new URL(uri);
  const hostname = url.hostname;
  const isLoopback =
    hostname === '127.0.0.1' ||
    hostname === 'localhost' ||
    hostname === '::1';

  if (!isLoopback) {
    throw new Error(
      `SECURITY VIOLATION: Integration tests must strictly run against a local loopback replica set. Refusing connection to non-local host: ${hostname}`,
    );
  }

  if (
    uri.includes('mongodb.net') ||
    uri.includes('mongodb+srv') ||
    uri.includes('cliniqo-dev')
  ) {
    throw new Error(
      'SECURITY VIOLATION: Remote MongoDB cluster URI detected. Aborting test execution immediately.',
    );
  }
}

describe('Real MongoDB Replica Set Integration: Consultations Domain (WiredTiger Multi-Doc Transactions)', () => {
  let replSet: MongoMemoryReplSet;
  let connection: Connection;
  let service: ConsultationService;

  let consultationModel: Model<ConsultationDocument>;
  let addendumModel: Model<ConsultationAddendumDocument>;
  let idempotencyModel: Model<IdempotencyRecordDocument>;
  let patientModel: Model<PatientDocument>;
  let auditLogModel: Model<ClinicAuditLogDocument>;

  const clinicId = new Types.ObjectId('672bb0000000000000000001');
  const doctorId = new Types.ObjectId('672aa0000000000000000002');
  const patientId = new Types.ObjectId('672cc0000000000000000001');

  beforeAll(async () => {
    // 1. Start ephemeral single-node replica set with WiredTiger storage engine
    replSet = await MongoMemoryReplSet.create({
      replSet: {
        count: 1,
        storageEngine: 'wiredTiger',
      },
    });

    const replSetUri = replSet.getUri('cliniqo_integration_test');
    assertSafeLocalUri(replSetUri);

    // 2. Connect Mongoose directly to the real replica set (no mocks!)
    const mongooseInstance = await mongoose.connect(replSetUri, {
      dbName: 'cliniqo_integration_test',
    });
    connection = mongooseInstance.connection;

    // 3. Compile real Mongoose models
    consultationModel = connection.model(
      Consultation.name,
      ConsultationSchema,
    ) as unknown as Model<ConsultationDocument>;
    addendumModel = connection.model(
      ConsultationAddendum.name,
      ConsultationAddendumSchema,
    ) as unknown as Model<ConsultationAddendumDocument>;
    idempotencyModel = connection.model(
      IdempotencyRecord.name,
      IdempotencyRecordSchema,
    ) as unknown as Model<IdempotencyRecordDocument>;
    patientModel = connection.model(
      Patient.name,
      PatientSchema,
    ) as unknown as Model<PatientDocument>;
    auditLogModel = connection.model(
      ClinicAuditLog.name,
      ClinicAuditLogSchema,
    ) as unknown as Model<ClinicAuditLogDocument>;

    // 4. Deploy and sync real indexes (including partial unique index on DRAFT consultations)
    await Promise.all([
      consultationModel.syncIndexes(),
      addendumModel.syncIndexes(),
      idempotencyModel.syncIndexes(),
      patientModel.syncIndexes(),
      auditLogModel.syncIndexes(),
    ]);

    // 5. Instantiate ConsultationService with real models and real connection
    service = new ConsultationService(
      consultationModel,
      addendumModel,
      idempotencyModel,
      patientModel,
      auditLogModel,
      connection,
    );
  }, 60000);

  afterAll(async () => {
    if (connection && connection.readyState !== 0) {
      await connection.close();
    }
    if (replSet) {
      await replSet.stop();
    }
  });

  beforeEach(async () => {
    // Clean all collections before each test
    await Promise.all([
      consultationModel.deleteMany({}),
      connection.collection('consultation_addenda').deleteMany({}),
      idempotencyModel.deleteMany({}),
      patientModel.deleteMany({}),
      connection.collection('clinic_audit_logs').deleteMany({}),
    ]);

    // Seed test patient
    await patientModel.create({
      _id: patientId,
      clinicId,
      patientId: 'P-00101',
      name: 'Ananya Iyer',
      initials: 'AI',
      age: 32,
      gender: PatientGender.FEMALE,
      phone: '9876543210',
      normalizedPhone: '9876543210',
      status: PatientStatus.ACTIVE,
      allergies: [],
      conditions: [],
      createdBy: doctorId,
      updatedBy: doctorId,
      version: 1,
    });
  });

  describe('Multi-Document Transaction Commit & Rollback Atomicity', () => {
    it('commits consultation creation, audit log, and version atomically in real MongoDB transaction', async () => {
      const result = await service.createConsultation(
        clinicId,
        patientId.toString(),
        {
          chiefComplaint: 'Acute pharyngitis',
          consultationDate: new Date().toISOString(),
          vitals: { systolic: 120, diastolic: 80 },
        },
        doctorId,
      );

      expect(result).toBeDefined();
      expect(result.chiefComplaint).toBe('Acute pharyngitis');

      // Verify physical document in consultations collection
      const savedDoc = await consultationModel.findById(result._id).exec();
      expect(savedDoc).toBeDefined();
      expect(savedDoc?.status).toBe(ConsultationStatus.DRAFT);
      expect(savedDoc?.version).toBe(1);

      // Verify physical audit log in clinic_audit_logs collection
      const auditLog = await auditLogModel
        .findOne({
          clinicId,
          action: ClinicAuditAction.CONSULTATION_CREATED,
        })
        .exec();
      expect(auditLog).toBeDefined();
      expect(auditLog?.metadata?.consultationId).toBe(result._id.toString());
      expect(auditLog?.actorDoctorId.toString()).toBe(doctorId.toString());
    });

    it('rolls back completely when transaction helper encounters an error with zero surviving documents', async () => {
      // Execute a transactional operation that fails after writing to consultations
      const attempt = executeInTransaction(connection, async (session) => {
        await consultationModel.create(
          [
            {
              clinicId,
              patientId,
              patientCode: 'P-00101',
              doctorId,
              status: ConsultationStatus.DRAFT,
              consultationDate: new Date(),
              chiefComplaint: 'This draft must be rolled back',
              version: 1,
              createdBy: doctorId,
              updatedBy: doctorId,
            },
          ],
          { session },
        );

        // Force intentional transaction abort
        throw new Error('Simulated abort inside transaction');
      });

      await expect(attempt).rejects.toThrow('A database error occurred while processing the request');

      // Assert physical collections have zero surviving documents
      const consultationsCount = await consultationModel.countDocuments();
      expect(consultationsCount).toBe(0);

      const auditCount = await auditLogModel.countDocuments();
      expect(auditCount).toBe(0);
    });
  });

  describe('Real Partial Unique Index: Duplicate Active-Draft Prevention Under Concurrent Requests', () => {
    it('enforces single active draft per patient under concurrent executions via real E11000 index violation', async () => {
      // Launch two concurrent draft creation requests for the exact same patient
      const promise1 = service.createConsultation(
        clinicId,
        patientId.toString(),
        { chiefComplaint: 'Concurrent request 1' },
        doctorId,
      );
      const promise2 = service.createConsultation(
        clinicId,
        patientId.toString(),
        { chiefComplaint: 'Concurrent request 2' },
        doctorId,
      );

      const results = await Promise.allSettled([promise1, promise2]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
      const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

      // Exactly ONE request must succeed
      expect(fulfilled).toHaveLength(1);
      // Exactly ONE request must fail with 409 Conflict
      expect(rejected).toHaveLength(1);

      const conflictError = rejected[0].reason;
      expect(conflictError).toBeInstanceOf(ConflictException);
      expect(conflictError.getResponse().message).toContain(
        'An active consultation draft already exists for this patient',
      );
      expect(conflictError.getResponse().existingConsultationId).toBe(
        fulfilled[0].value._id.toString(),
      );

      // Verify physical MongoDB collection contains strictly ONE consultation draft
      const activeDrafts = await consultationModel.find({
        clinicId,
        patientId,
        status: ConsultationStatus.DRAFT,
      });
      expect(activeDrafts).toHaveLength(1);

      // Verify physical audit log contains strictly ONE consultation creation event
      const auditLogs = await auditLogModel.find({
        clinicId,
        action: ClinicAuditAction.CONSULTATION_CREATED,
      });
      expect(auditLogs).toHaveLength(1);
    });
  });

  describe('Real Idempotency Claim-Token Fencing & Recovery Under Multi-Doc Transactions', () => {
    it('fences out stale worker when lease expires during transaction and aborts transaction with zero writes', async () => {
      const key = 'idem-real-fencing-key';

      // 1. Manually pre-seed an expired idempotency record (simulating expired worker lease)
      await idempotencyModel.create({
        clinicId,
        key,
        httpMethod: 'POST',
        normalizedRoute: `/clinics/${clinicId.toString()}/patients/${patientId.toString()}/consultations`,
        requestFingerprint: 'dummy-fp',
        status: 'PROCESSING',
        claimToken: 'stale-worker-token-xyz',
        lockedUntil: new Date(Date.now() - 5000), // Expired in past
        expiresAt: new Date(Date.now() + 86400000),
      });

      // 2. Worker attempts to execute transaction with the stale token but expired lease
      await expect(
        executeInTransaction(connection, async (session) => {
          await consultationModel.create(
            [
              {
                clinicId,
                patientId,
                patientCode: 'P-00101',
                doctorId,
                status: ConsultationStatus.DRAFT,
                consultationDate: new Date(),
                chiefComplaint: 'Stale worker write attempt',
                version: 1,
                createdBy: doctorId,
                updatedBy: doctorId,
              },
            ],
            { session },
          );

          // Atomic fenced update
          const fenced = await idempotencyModel.findOneAndUpdate(
            {
              clinicId,
              key,
              claimToken: 'stale-worker-token-xyz',
              status: 'PROCESSING',
              lockedUntil: { $gt: new Date() },
            },
            {
              $set: {
                status: 'COMPLETED',
                responseCode: 201,
                responseBody: {},
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
        }),
      ).rejects.toThrow(ConflictException);

      // Assert physical rollback in real MongoDB: zero consultations created
      const count = await consultationModel.countDocuments();
      expect(count).toBe(0);
    });

    it('transitions to FAILED on aborted transaction and allows successful retry recovery on real MongoDB', async () => {
      const key = 'idem-real-retry-key';
      const dto = { chiefComplaint: 'Fever with severe cough' };

      // Step 1: Pre-set a FAILED record in real MongoDB
      await idempotencyModel.create({
        clinicId,
        key,
        httpMethod: 'POST',
        normalizedRoute: `/clinics/${clinicId.toString()}/patients/${patientId.toString()}/consultations`,
        requestFingerprint: computeRequestFingerprint(
          'POST',
          `/clinics/${clinicId.toString()}/patients/${patientId.toString()}/consultations`,
          dto,
        ),
        status: 'FAILED',
        claimToken: 'failed-attempt-token',
        lockedUntil: null,
        expiresAt: new Date(Date.now() + 86400000),
      });

      // Step 2: Retry with identical payload and key
      const result = await service.createConsultation(
        clinicId,
        patientId.toString(),
        dto,
        doctorId,
        key,
      );

      expect(result).toBeDefined();
      expect(result.chiefComplaint).toBe('Fever with severe cough');

      // Verify physical MongoDB document committed
      const savedDoc = await consultationModel.findById(result._id).exec();
      expect(savedDoc).toBeDefined();

      // Verify idempotency record in physical MongoDB transitioned to COMPLETED
      const record = await idempotencyModel.findOne({ clinicId, key }).exec();
      expect(record).toBeDefined();
      expect(record?.status).toBe('COMPLETED');
      expect(record?.lockedUntil).toBeNull();
      expect(record?.responseCode).toBe(201);
      expect(record?.recoveryAttempts).toBe(1);
    });
  });

  describe('Real Optimistic Concurrency Locking', () => {
    it('detects concurrent draft updates and prevents lost updates via version conflict', async () => {
      const created = await service.createConsultation(
        clinicId,
        patientId.toString(),
        { chiefComplaint: 'Initial complaint' },
        doctorId,
      );

      const consultationId = created._id.toString();

      // Concurrent update 1 with expectedVersion: 1
      const update1 = service.updateConsultation(
        clinicId,
        consultationId,
        { expectedVersion: 1, chiefComplaint: 'Update from terminal 1' },
        doctorId,
      );

      // Concurrent update 2 with expectedVersion: 1
      const update2 = service.updateConsultation(
        clinicId,
        consultationId,
        { expectedVersion: 1, chiefComplaint: 'Update from terminal 2' },
        doctorId,
      );

      const results = await Promise.allSettled([update1, update2]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

      // Exactly ONE succeeds
      expect(fulfilled).toHaveLength(1);
      // Exactly ONE encounters 409 Conflict
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(ConflictException);
      expect(rejected[0].reason.getResponse().message).toContain(
        'Optimistic lock conflict: Consultation was modified',
      );

      // Verify physical version in MongoDB is 2
      const current = await consultationModel.findById(created._id).exec();
      expect(current?.version).toBe(2);
    });

    it('rejects stale version on finalization with 409 Conflict', async () => {
      const created = await service.createConsultation(
        clinicId,
        patientId.toString(),
        { chiefComplaint: 'Initial complaint' },
        doctorId,
      );

      // Update once -> version becomes 2
      await service.updateConsultation(
        clinicId,
        created._id.toString(),
        { expectedVersion: 1, clinicalNotes: 'Doctor examination notes' },
        doctorId,
      );

      // Attempt to finalize with stale expectedVersion: 1
      await expect(
        service.finalizeConsultation(
          clinicId,
          created._id.toString(),
          {
            expectedVersion: 1, // Stale! Current version is 2
            chiefComplaint: 'Final complaint',
            diagnosis: 'Viral bronchitis',
          },
          doctorId,
        ),
      ).rejects.toThrow(ConflictException);

      // Successfully finalize with correct expectedVersion: 2
      const finalized = await service.finalizeConsultation(
        clinicId,
        created._id.toString(),
        {
          expectedVersion: 2,
          chiefComplaint: 'Final complaint',
          diagnosis: 'Viral bronchitis',
        },
        doctorId,
      );

      expect(finalized.status).toBe(ConsultationStatus.FINALIZED);
      expect(finalized.version).toBe(3);
    });
  });

  describe('Real Addendum Sequence Uniqueness & Immutability Under Concurrency', () => {
    it('allocates strictly gapless sequence numbers for concurrent addenda and rejects updates', async () => {
      // 1. Create and finalize a visit
      const created = await service.createConsultation(
        clinicId,
        patientId.toString(),
        { chiefComplaint: 'Initial complaint' },
        doctorId,
      );

      const finalized = await service.finalizeConsultation(
        clinicId,
        created._id.toString(),
        {
          expectedVersion: 1,
          chiefComplaint: 'Chest congestion',
          diagnosis: 'Acute bronchitis',
        },
        doctorId,
      );

      const consultationId = finalized._id.toString();

      // 2. Fire 3 concurrent addendum creation requests
      const p1 = service.addAddendum(
        clinicId,
        consultationId,
        { note: 'Addendum note A', reasonForAddendum: 'Follow-up lab A' },
        doctorId,
      );
      const p2 = service.addAddendum(
        clinicId,
        consultationId,
        { note: 'Addendum note B', reasonForAddendum: 'Follow-up lab B' },
        doctorId,
      );
      const p3 = service.addAddendum(
        clinicId,
        consultationId,
        { note: 'Addendum note C', reasonForAddendum: 'Follow-up lab C' },
        doctorId,
      );

      const results = await Promise.all([p1, p2, p3]);

      // All 3 succeed
      expect(results).toHaveLength(3);

      // Verify sequence numbers allocated in physical collection
      const sequenceNumbers = results.map((r) => r.sequenceNumber).sort((a, b) => a - b);
      expect(sequenceNumbers).toEqual([1, 2, 3]);

      // Verify parent consultation document has addendumCount: 3, hasAddenda: true
      const parent = await consultationModel.findById(finalized._id).exec();
      expect(parent?.addendumCount).toBe(3);
      expect(parent?.hasAddenda).toBe(true);

      // Verify append-only pre-hook throws on attempt to update an addendum
      const firstAddendumId = results[0]._id;
      await expect(
        addendumModel.updateOne(
          { _id: firstAddendumId },
          { $set: { note: 'Tampered note' } },
        ),
      ).rejects.toThrow('ConsultationAddendum records are append-only and strictly immutable.');
    });
  });

  describe('Patient lastVisitAt $max Invariant on Real MongoDB', () => {
    it('leaves Patient.lastVisitAt untouched when a retroactive consultation is finalized on real database', async () => {
      // Step 1: Finalize recent visit on Oct 24
      const recentVisit = await service.createConsultation(
        clinicId,
        patientId.toString(),
        {
          consultationDate: '2026-10-24T12:00:00.000Z',
          chiefComplaint: 'Recent visit',
        },
        doctorId,
      );

      await service.finalizeConsultation(
        clinicId,
        recentVisit._id.toString(),
        {
          expectedVersion: 1,
          chiefComplaint: 'Recent visit',
          diagnosis: 'Migraine',
        },
        doctorId,
      );

      const patientAfterRecent = await patientModel.findById(patientId).exec();
      expect(patientAfterRecent?.lastVisitAt).toEqual(new Date('2026-10-24T12:00:00.000Z'));

      // Step 2: Finalize retroactive visit from Oct 10
      const oldVisit = await service.createConsultation(
        clinicId,
        patientId.toString(),
        {
          consultationDate: '2026-10-10T09:00:00.000Z',
          chiefComplaint: 'Old historical visit',
        },
        doctorId,
      );

      await service.finalizeConsultation(
        clinicId,
        oldVisit._id.toString(),
        {
          expectedVersion: 1,
          chiefComplaint: 'Old historical visit',
          diagnosis: 'Common cold',
        },
        doctorId,
      );

      // Verify Patient.lastVisitAt is still Oct 24 (never moved backward!)
      const patientAfterRetroactive = await patientModel.findById(patientId).exec();
      expect(patientAfterRetroactive?.lastVisitAt).toEqual(new Date('2026-10-24T12:00:00.000Z'));
    });
  });
});
