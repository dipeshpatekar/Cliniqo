import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Types, Model, Connection } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '../src/config/config.service.js';
import { TokenService } from '../src/auth/token.service.js';
import { Doctor, DoctorSchema, DoctorDocument } from '../src/auth/schemas/doctor.schema.js';
import { RefreshSession, RefreshSessionSchema, RefreshSessionDocument } from '../src/auth/schemas/refresh-session.schema.js';
import { SyncService } from '../src/sync/sync.service.js';
import { SyncChangeFeed, SyncChangeFeedSchema, SyncChangeFeedDocument, SyncEntityType, SyncActionType } from '../src/sync/schemas/sync-change-feed.schema.js';
import { ClinicSyncCounter, ClinicSyncCounterSchema, ClinicSyncCounterDocument } from '../src/sync/schemas/clinic-sync-counter.schema.js';
import { SyncConflict, SyncConflictSchema, SyncConflictDocument, SyncConflictStatus } from '../src/sync/schemas/sync-conflict.schema.js';
import { IdempotencyRecord, IdempotencyRecordSchema, IdempotencyRecordDocument } from '../src/common/schemas/idempotency-record.schema.js';
import { Patient, PatientSchema, PatientDocument, PatientGender, PatientStatus } from '../src/patient/schemas/patient.schema.js';
import { Consultation, ConsultationSchema, ConsultationDocument, ConsultationStatus } from '../src/consultation/schemas/consultation.schema.js';
import { Prescription, PrescriptionSchema, PrescriptionDocument } from '../src/prescription/schemas/prescription.schema.js';
import { PrescriptionRevision, PrescriptionRevisionSchema, PrescriptionRevisionDocument } from '../src/prescription/schemas/prescription-revision.schema.js';
import { ClinicSequenceCounter, ClinicSequenceCounterSchema, ClinicSequenceCounterDocument } from '../src/patient/schemas/clinic-sequence-counter.schema.js';
import { DoctorStatus } from '../src/auth/auth.constants.js';
import {
  MedicineFormulation,
  DoseUnit,
  MedicineRoute,
  TimingType,
  FrequencyCode,
  FoodInstruction,
} from '../src/prescription/schemas/prescription-item.schema.js';

describe('Phase 5A Real MongoDB Replica Set Integration: Sync Engine & Asymmetric Auth', () => {
  let replSet: MongoMemoryReplSet;
  let connection: Connection;
  let syncService: SyncService;
  let tokenService: TokenService;
  let configService: ConfigService;
  let jwtService: JwtService;

  let doctorModel: Model<DoctorDocument>;
  let sessionModel: Model<RefreshSessionDocument>;
  let changeFeedModel: Model<SyncChangeFeedDocument>;
  let counterModel: Model<ClinicSyncCounterDocument>;
  let conflictModel: Model<SyncConflictDocument>;
  let idempotencyModel: Model<IdempotencyRecordDocument>;
  let patientModel: Model<PatientDocument>;
  let consultationModel: Model<ConsultationDocument>;
  let prescriptionModel: Model<PrescriptionDocument>;
  let revisionModel: Model<PrescriptionRevisionDocument>;
  let seqCounterModel: Model<ClinicSequenceCounterDocument>;

  const clinicId = new Types.ObjectId('672bb0000000000000000001');
  const otherClinicId = new Types.ObjectId('672bb0000000000000000002');
  const doctorId = new Types.ObjectId('672aa0000000000000000001');

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({
      replSet: {
        count: 1,
        storageEngine: 'wiredTiger',
      },
    });

    const replSetUri = replSet.getUri('cliniqo_sync_integration_test');
    const mongooseInstance = await mongoose.connect(replSetUri, {
      dbName: 'cliniqo_sync_integration_test',
    });
    connection = mongooseInstance.connection;

    // Compile Mongoose models
    doctorModel = connection.model(Doctor.name, DoctorSchema) as unknown as Model<DoctorDocument>;
    sessionModel = connection.model(RefreshSession.name, RefreshSessionSchema) as unknown as Model<RefreshSessionDocument>;
    changeFeedModel = connection.model(SyncChangeFeed.name, SyncChangeFeedSchema) as unknown as Model<SyncChangeFeedDocument>;
    counterModel = connection.model(ClinicSyncCounter.name, ClinicSyncCounterSchema) as unknown as Model<ClinicSyncCounterDocument>;
    conflictModel = connection.model(SyncConflict.name, SyncConflictSchema) as unknown as Model<SyncConflictDocument>;
    idempotencyModel = connection.model(IdempotencyRecord.name, IdempotencyRecordSchema) as unknown as Model<IdempotencyRecordDocument>;
    patientModel = connection.model(Patient.name, PatientSchema) as unknown as Model<PatientDocument>;
    consultationModel = connection.model(Consultation.name, ConsultationSchema) as unknown as Model<ConsultationDocument>;
    prescriptionModel = connection.model(Prescription.name, PrescriptionSchema) as unknown as Model<PrescriptionDocument>;
    revisionModel = connection.model(PrescriptionRevision.name, PrescriptionRevisionSchema) as unknown as Model<PrescriptionRevisionDocument>;
    seqCounterModel = connection.model(ClinicSequenceCounter.name, ClinicSequenceCounterSchema) as unknown as Model<ClinicSequenceCounterDocument>;

    // Sync indexes
    await Promise.all([
      changeFeedModel.syncIndexes(),
      counterModel.syncIndexes(),
      conflictModel.syncIndexes(),
      idempotencyModel.syncIndexes(),
      patientModel.syncIndexes(),
      consultationModel.syncIndexes(),
      prescriptionModel.syncIndexes(),
      revisionModel.syncIndexes(),
      seqCounterModel.syncIndexes(),
    ]);

    // Instantiate services
    configService = new ConfigService({
      NODE_ENV: 'test',
      JWT_ACCESS_SECRET: 'test_access_secret_min_32_characters_long_12345',
      JWT_REFRESH_SECRET: 'test_refresh_secret_min_32_characters_long_12345',
      JWT_ISSUER: 'cliniqo-backend',
      JWT_AUDIENCE: 'cliniqo-client',
    });

    jwtService = new JwtService({});
    tokenService = new TokenService(jwtService, configService, sessionModel, doctorModel);

    syncService = new SyncService(
      connection,
      changeFeedModel,
      counterModel,
      conflictModel,
      idempotencyModel,
      patientModel,
      consultationModel,
      prescriptionModel,
      revisionModel,
      seqCounterModel,
    );
  }, 60000);

  afterAll(async () => {
    if (connection) await connection.close();
    if (replSet) await replSet.stop();
  });

  beforeEach(async () => {
    await Promise.all([
      changeFeedModel.deleteMany({}),
      counterModel.deleteMany({}),
      conflictModel.deleteMany({}),
      idempotencyModel.deleteMany({}),
      patientModel.deleteMany({}),
      consultationModel.deleteMany({}),
      prescriptionModel.deleteMany({}),
      connection.collection('prescription_revisions').deleteMany({}),
      seqCounterModel.deleteMany({}),
    ]);
  });

  // -------------------------------------------------------------------------
  // 1. ASYMMETRIC RS256 AUTHENTICATION & PUBLIC KEY VERIFICATION
  // -------------------------------------------------------------------------
  describe('Asymmetric RS256 Token Signing & Public Key Verification', () => {
    it('should generate an RS256 token and verify it against the backend public key info', async () => {
      const mockDoctor = {
        _id: doctorId,
        email: 'dr.deshmukh@cliniqo.app',
        fullName: 'Dr. Suresh Deshmukh',
        status: DoctorStatus.ACTIVE,
      };

      const token = await tokenService.generateAccessToken(mockDoctor);
      expect(token).toBeDefined();

      // Verify token header is RS256
      const parts = token.split('.');
      const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      expect(header.alg).toBe('RS256');

      // Verify token payload using TokenService
      const payload = await tokenService.verifyAccessToken(token);
      expect(payload.sub).toBe(doctorId.toString());
      expect(payload.email).toBe(mockDoctor.email);

      // Verify public key is exposed
      const keyInfo = tokenService.getPublicKeyInfo();
      expect(keyInfo.algorithm).toBe('RS256');
      expect(keyInfo.publicKey).toContain('BEGIN PUBLIC KEY');

      // External client verification using ONLY the public key
      const verifiedExternally = await jwtService.verifyAsync(token, {
        publicKey: keyInfo.publicKey,
        algorithms: ['RS256'],
        issuer: 'cliniqo-backend',
        audience: 'cliniqo-client',
      });
      expect(verifiedExternally.sub).toBe(doctorId.toString());
    });

    it('should reject tampered or forged RS256 tokens', async () => {
      const mockDoctor = {
        _id: doctorId,
        email: 'dr.deshmukh@cliniqo.app',
        fullName: 'Dr. Suresh Deshmukh',
        status: DoctorStatus.ACTIVE,
      };

      const token = await tokenService.generateAccessToken(mockDoctor);
      const parts = token.split('.');
      const tamperedToken = `${parts[0]}.${parts[1]}.invalidsignature123`;

      await expect(tokenService.verifyAccessToken(tamperedToken)).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // 2. IDEMPOTENCY & DUPLICATE PUSH REPLAY
  // -------------------------------------------------------------------------
  describe('Transactional Idempotency & Safe Retries', () => {
    it('should apply initial mutation and return cached result on duplicate push without creating duplicates', async () => {
      const mutation = {
        outboxId: 'outbox-pat-01',
        entityType: SyncEntityType.PATIENT,
        action: SyncActionType.CREATE,
        idempotencyKey: 'idemp-pat-001',
        entityId: 'client-pat-01',
        clientVersion: 0,
        payload: {
          name: 'Sunita Patil',
          phone: '+919876543210',
          gender: PatientGender.FEMALE,
          age: 42,
          allergies: ['Penicillin'],
        },
      };

      // 1. Initial Push
      const res1 = await syncService.push(clinicId, doctorId, { mutations: [mutation] });
      expect(res1.results).toHaveLength(1);
      expect(res1.results[0].status).toBe('APPLIED');
      const serverId = res1.results[0].serverId;
      expect(serverId).toBeDefined();

      const patientCount = await patientModel.countDocuments({ clinicId });
      expect(patientCount).toBe(1);

      // 2. Duplicate Push with identical payload and idempotency key
      const res2 = await syncService.push(clinicId, doctorId, { mutations: [mutation] });
      expect(res2.results).toHaveLength(1);
      expect(res2.results[0].status).toBe('APPLIED');
      expect(res2.results[0].serverId).toBe(serverId);

      // Verify no duplicate patient was created
      const patientCountAfter = await patientModel.countDocuments({ clinicId });
      expect(patientCountAfter).toBe(1);
    });

    it('should reject push if an idempotency key is reused with a different request payload', async () => {
      const mutationA = {
        outboxId: 'outbox-pat-02A',
        entityType: SyncEntityType.PATIENT,
        action: SyncActionType.CREATE,
        idempotencyKey: 'idemp-pat-reused-key',
        entityId: 'client-pat-02',
        clientVersion: 0,
        payload: {
          name: 'Patient A',
          phone: '+919876500001',
          gender: PatientGender.MALE,
          age: 30,
        },
      };

      const mutationB = {
        outboxId: 'outbox-pat-02B',
        entityType: SyncEntityType.PATIENT,
        action: SyncActionType.CREATE,
        idempotencyKey: 'idemp-pat-reused-key', // Reused key!
        entityId: 'client-pat-02',
        clientVersion: 0,
        payload: {
          name: 'Patient B with completely different parameters',
          phone: '+919876500002',
          gender: PatientGender.FEMALE,
          age: 65,
        },
      };

      const res1 = await syncService.push(clinicId, doctorId, { mutations: [mutationA] });
      expect(res1.results[0].status).toBe('APPLIED');

      const res2 = await syncService.push(clinicId, doctorId, { mutations: [mutationB] });
      expect(res2.results[0].status).toBe('REJECTED');
      expect(res2.results[0].error).toContain('different request payload');
    });
  });

  // -------------------------------------------------------------------------
  // 3. MONOTONIC CURSOR CHANGE FEED & GAPLESS PAGINATION
  // -------------------------------------------------------------------------
  describe('Durable Append-Only Change Feed & Monotonic Cursor Pull', () => {
    it('should stream committed changes strictly by monotonic sequence without skipping records', async () => {
      // Create 5 patient mutations sequentially
      const mutations = Array.from({ length: 5 }, (_, i) => ({
        outboxId: `outbox-seq-${i + 1}`,
        entityType: SyncEntityType.PATIENT,
        action: SyncActionType.CREATE,
        idempotencyKey: `idemp-seq-${i + 1}`,
        entityId: `client-seq-${i + 1}`,
        clientVersion: 0,
        payload: {
          name: `Batch Patient ${i + 1}`,
          phone: `+91987654321${i}`,
          gender: PatientGender.OTHER,
          age: 20 + i,
        },
      }));

      await syncService.push(clinicId, doctorId, { mutations });

      // Page 1: sinceSeq = 0, limit = 2
      const pullPage1 = await syncService.pull(clinicId, { sinceSeq: 0, limit: 2 });
      expect(pullPage1.changes).toHaveLength(2);
      expect(pullPage1.changes[0].seq).toBe(1);
      expect(pullPage1.changes[1].seq).toBe(2);
      expect(pullPage1.hasMore).toBe(true);
      expect(pullPage1.currentSeq).toBe(5);

      // Page 2: sinceSeq = 2, limit = 2
      const pullPage2 = await syncService.pull(clinicId, { sinceSeq: 2, limit: 2 });
      expect(pullPage2.changes).toHaveLength(2);
      expect(pullPage2.changes[0].seq).toBe(3);
      expect(pullPage2.changes[1].seq).toBe(4);
      expect(pullPage2.hasMore).toBe(true);

      // Page 3: sinceSeq = 4, limit = 2
      const pullPage3 = await syncService.pull(clinicId, { sinceSeq: 4, limit: 2 });
      expect(pullPage3.changes).toHaveLength(1);
      expect(pullPage3.changes[0].seq).toBe(5);
      expect(pullPage3.hasMore).toBe(false);

      // Verify no records skipped across all pages
      const allSeqs = [
        ...pullPage1.changes.map((c) => c.seq),
        ...pullPage2.changes.map((c) => c.seq),
        ...pullPage3.changes.map((c) => c.seq),
      ];
      expect(allSeqs).toEqual([1, 2, 3, 4, 5]);
    });
  });

  // -------------------------------------------------------------------------
  // 4. CLINICAL DATA CONFLICTS: NO AUTOMATIC UNION OF ALLERGIES
  // -------------------------------------------------------------------------
  describe('Clinical Data Conflict Resolution (Allergies & Conditions)', () => {
    it('should detect divergent allergies on concurrent update and flag CONFLICT without auto-unioning', async () => {
      // 1. Seed existing patient on server (version 1)
      const patient = await patientModel.create({
        clinicId,
        patientId: 'P-00101',
        name: 'Ramesh Patel',
        initials: 'RP',
        age: 50,
        gender: PatientGender.MALE,
        phone: '+919988776655',
        normalizedPhone: '9988776655',
        allergies: ['Penicillin'],
        conditions: ['Hypertension'],
        status: PatientStatus.ACTIVE,
        version: 2, // Server has progressed to version 2
        createdBy: doctorId,
        updatedBy: doctorId,
      });

      // 2. Offline client arrives based on outdated version 1 with different allergy
      const updateMutation = {
        outboxId: 'outbox-pat-conflict-01',
        entityType: SyncEntityType.PATIENT,
        action: SyncActionType.UPDATE,
        idempotencyKey: 'idemp-pat-conflict-01',
        entityId: patient._id.toString(),
        clientVersion: 1, // Outdated version!
        payload: {
          allergies: ['Penicillin', 'Sulfa Drugs'],
        },
      };

      const res = await syncService.push(clinicId, doctorId, { mutations: [updateMutation] });
      expect(res.results).toHaveLength(1);
      expect(res.results[0].status).toBe('CONFLICT');
      expect(res.results[0].conflictDetails?.conflictReason).toBe('DIVERGENT_CLINICAL_DATA');
      expect(res.results[0].conflictDetails?.conflictFields).toContain('allergies');

      // Assert server patient was NOT silently overwritten or auto-unioned
      const freshPatient = await patientModel.findById(patient._id);
      expect(freshPatient?.allergies).toEqual(['Penicillin']);
      expect(freshPatient?.version).toBe(2);

      // Assert conflict was durably recorded for doctor review
      const loggedConflict = await conflictModel.findOne({
        clinicId,
        outboxId: 'outbox-pat-conflict-01',
      });
      expect(loggedConflict).toBeDefined();
      expect(loggedConflict?.status).toBe(SyncConflictStatus.OPEN);
      expect(loggedConflict?.conflictFields).toContain('allergies');
    });
  });

  // -------------------------------------------------------------------------
  // 5. CONSULTATION ACTIVE DRAFT COLLISION
  // -------------------------------------------------------------------------
  describe('Consultation Draft Concurrency Protection', () => {
    it('should prevent collision when two drafts are created concurrently for the same patient', async () => {
      const patient = await patientModel.create({
        clinicId,
        patientId: 'P-00102',
        name: 'Meena Kumari',
        initials: 'MK',
        age: 34,
        gender: PatientGender.FEMALE,
        phone: '+919988776611',
        normalizedPhone: '9988776611',
        status: PatientStatus.ACTIVE,
        version: 1,
        createdBy: doctorId,
        updatedBy: doctorId,
      });

      // Draft 1 created
      const draft1Mutation = {
        outboxId: 'outbox-con-draft-1',
        entityType: SyncEntityType.CONSULTATION,
        action: SyncActionType.CREATE,
        idempotencyKey: 'idemp-con-draft-1',
        entityId: 'client-con-01',
        clientVersion: 0,
        payload: {
          patientId: patient._id.toString(),
          chiefComplaint: 'Acute headache',
          diagnosis: 'Migraine',
        },
      };

      const res1 = await syncService.push(clinicId, doctorId, { mutations: [draft1Mutation] });
      expect(res1.results[0].status).toBe('APPLIED');

      // Draft 2 created concurrently for same patient
      const draft2Mutation = {
        outboxId: 'outbox-con-draft-2',
        entityType: SyncEntityType.CONSULTATION,
        action: SyncActionType.CREATE,
        idempotencyKey: 'idemp-con-draft-2',
        entityId: 'client-con-02',
        clientVersion: 0,
        payload: {
          patientId: patient._id.toString(),
          chiefComplaint: 'Fever and chills',
          diagnosis: 'Viral fever',
        },
      };

      const res2 = await syncService.push(clinicId, doctorId, { mutations: [draft2Mutation] });
      expect(res2.results[0].status).toBe('CONFLICT');
      expect(res2.results[0].conflictDetails?.conflictReason).toBe('CONCURRENT_DRAFT_COLLISION');

      // Verify only 1 draft exists on server
      const drafts = await consultationModel.find({
        clinicId,
        patientId: patient._id,
        status: ConsultationStatus.DRAFT,
      });
      expect(drafts).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // 6. PRESCRIPTION REVISION IMMUTABILITY & CONCURRENT REVISIONS
  // -------------------------------------------------------------------------
  describe('Prescription Revision Immutability & Concurrency', () => {
    it('should create initial Revision 1 transactionally, and reject concurrent conflicting revisions', async () => {
      // 1. Create Patient & Consultation
      const patient = await patientModel.create({
        clinicId,
        patientId: 'P-00103',
        name: 'Amit Verma',
        initials: 'AV',
        age: 40,
        gender: PatientGender.MALE,
        phone: '+919988776622',
        normalizedPhone: '9988776622',
        status: PatientStatus.ACTIVE,
        version: 1,
        createdBy: doctorId,
        updatedBy: doctorId,
      });

      const consultation = await consultationModel.create({
        clinicId,
        patientId: patient._id,
        patientCode: patient.patientId,
        doctorId,
        status: ConsultationStatus.FINALIZED,
        chiefComplaint: 'Chest tightness',
        diagnosis: 'Bronchitis',
        version: 1,
        createdBy: doctorId,
        updatedBy: doctorId,
      });

      // 2. Create Initial Prescription (Revision 1)
      const validItem = {
        name: 'Amoxicillin 500mg',
        genericName: 'Amoxicillin',
        formulation: MedicineFormulation.TABLET,
        strength: {
          components: [{ ingredientName: 'Amoxicillin', amount: 500, unit: 'mg' }],
          perDenominator: 'tablet',
          display: '500 mg',
        },
        administeredDose: {
          magnitude: 1,
          unit: DoseUnit.TABLET,
        },
        route: MedicineRoute.ORAL,
        frequency: {
          timingType: TimingType.STANDARD,
          frequencyCode: FrequencyCode.TID,
          scheduleLabel: '1-1-1',
        },
        duration: { value: 5, unit: 'DAYS' },
        dispenseQuantity: { count: 15, packageDescription: '15 Tablets' },
        foodInstruction: FoodInstruction.AFTER_MEALS,
      };

      const rxMutation = {
        outboxId: 'outbox-rx-01',
        entityType: SyncEntityType.PRESCRIPTION,
        action: SyncActionType.CREATE,
        idempotencyKey: 'idemp-rx-001',
        entityId: 'client-rx-01',
        clientVersion: 0,
        payload: {
          consultationId: consultation._id.toString(),
          items: [validItem],
        },
      };

      const resRx = await syncService.push(clinicId, doctorId, { mutations: [rxMutation] });
      expect(resRx.results[0].status).toBe('APPLIED');
      const rxServerId = resRx.results[0].serverId!;

      const rx = await prescriptionModel.findById(rxServerId);
      expect(rx?.prescriptionNumber).toMatch(/^RX-\d{5}$/);
      expect(rx?.currentRevisionNumber).toBe(1);

      const rev1 = await revisionModel.findOne({ prescriptionId: rx?._id, revisionNumber: 1 });
      expect(rev1).toBeDefined();

      // 3. Server creates Revision 2
      rx!.currentRevisionNumber = 2;
      rx!.version = 2;
      await rx!.save();
      await revisionModel.create({
        clinicId,
        prescriptionId: rx!._id,
        consultationId: consultation._id,
        patientId: patient._id,
        prescribedBy: doctorId,
        revisionNumber: 2,
        reasonForRevision: 'Dosage adjustment',
        items: [{
          ...validItem,
          name: 'Amoxicillin 250mg',
          strength: {
            components: [{ ingredientName: 'Amoxicillin', amount: 250, unit: 'mg' }],
            perDenominator: 'tablet',
            display: '250 mg',
          },
        }],
        clinicalSnapshot: {
          consultationId: consultation._id,
          patientId: patient._id,
          patientCode: patient.patientId,
          doctorId,
          consultationDate: new Date(),
          chiefComplaint: 'Review',
          diagnosis: 'Bronchitis',
          vitals: {},
          provisionalMedicines: [],
        },
      });

      // 4. Offline client arrives attempting to revise based on Revision 1 (expectedRevisionNumber: 1)
      const concurrentRevisionMutation = {
        outboxId: 'outbox-rx-rev-conflict',
        entityType: SyncEntityType.PRESCRIPTION_REVISION,
        action: SyncActionType.REVISE,
        idempotencyKey: 'idemp-rx-rev-conflict',
        entityId: rxServerId,
        clientVersion: 1, // Based on outdated version 1!
        payload: {
          expectedRevisionNumber: 1,
          reasonForRevision: 'Concurrent edit from offline laptop',
          items: [{
            ...validItem,
            name: 'Azithromycin 500mg',
          }],
        },
      };

      const resConflict = await syncService.push(clinicId, doctorId, {
        mutations: [concurrentRevisionMutation],
      });

      expect(resConflict.results[0].status).toBe('CONFLICT');
      expect(resConflict.results[0].conflictDetails?.conflictReason).toBe(
        'CONCURRENT_REVISION_COLLISION',
      );

      // Verify Revision 1 and Revision 2 are completely unmodified (immutability preserved)
      const allRevisions = await revisionModel.find({ prescriptionId: rx!._id }).sort({ revisionNumber: 1 });
      expect(allRevisions).toHaveLength(2);
      expect(allRevisions[0].revisionNumber).toBe(1);
      expect(allRevisions[1].revisionNumber).toBe(2);
      expect(allRevisions[1].items[0].name).toBe('Amoxicillin 250mg'); // Not overwritten!
    });
  });

  // -------------------------------------------------------------------------
  // 7. CROSS-CLINIC TENANCY ISOLATION
  // -------------------------------------------------------------------------
  describe('Cross-Clinic Tenancy Isolation', () => {
    it('should strictly isolate change feeds, counters, and queries between different clinics', async () => {
      // Create patient in Clinic A
      const mutationA = {
        outboxId: 'outbox-clinic-a',
        entityType: SyncEntityType.PATIENT,
        action: SyncActionType.CREATE,
        idempotencyKey: 'idemp-clinic-a',
        entityId: 'client-pat-a',
        clientVersion: 0,
        payload: {
          name: 'Clinic A Patient',
          phone: '+919876543201',
          gender: PatientGender.MALE,
          age: 28,
        },
      };

      // Create patient in Clinic B (otherClinicId)
      const mutationB = {
        outboxId: 'outbox-clinic-b',
        entityType: SyncEntityType.PATIENT,
        action: SyncActionType.CREATE,
        idempotencyKey: 'idemp-clinic-b',
        entityId: 'client-pat-b',
        clientVersion: 0,
        payload: {
          name: 'Clinic B Patient',
          phone: '+919876543202',
          gender: PatientGender.FEMALE,
          age: 32,
        },
      };

      await syncService.push(clinicId, doctorId, { mutations: [mutationA] });
      await syncService.push(otherClinicId, doctorId, { mutations: [mutationB] });

      // Pull for Clinic A
      const pullA = await syncService.pull(clinicId, { sinceSeq: 0 });
      expect(pullA.changes).toHaveLength(1);
      expect(pullA.changes[0].payload.name).toBe('Clinic A Patient');

      // Pull for Clinic B
      const pullB = await syncService.pull(otherClinicId, { sinceSeq: 0 });
      expect(pullB.changes).toHaveLength(1);
      expect(pullB.changes[0].payload.name).toBe('Clinic B Patient');

      // Ensure Clinic A sequence does not bleed into Clinic B
      expect(pullA.changes[0].seq).toBe(1);
      expect(pullB.changes[0].seq).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // 8. TRANSACTION ROLLBACK ON FAILURE
  // -------------------------------------------------------------------------
  describe('Transaction Rollback on Mutation Failure', () => {
    it('should rollback transaction completely if a mutation fails validation mid-flight', async () => {
      const invalidMutation = {
        outboxId: 'outbox-invalid-rx',
        entityType: SyncEntityType.PRESCRIPTION,
        action: SyncActionType.CREATE,
        idempotencyKey: 'idemp-invalid-rx',
        entityId: 'client-rx-bad',
        clientVersion: 0,
        payload: {
          consultationId: new Types.ObjectId().toString(), // Non-existent consultation
          items: [], // Invalid: zero items
        },
      };

      const res = await syncService.push(clinicId, doctorId, { mutations: [invalidMutation] });
      expect(res.results[0].status).toBe('REJECTED');

      // Verify no orphaned prescription or change feed records were written
      const rxCount = await prescriptionModel.countDocuments({ clinicId });
      expect(rxCount).toBe(0);
      const feedCount = await changeFeedModel.countDocuments({ clinicId });
      expect(feedCount).toBe(0);
    });
  });
});
