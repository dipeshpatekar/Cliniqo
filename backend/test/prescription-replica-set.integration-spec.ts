import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Connection, Model } from 'mongoose';
import mongoose, { Types } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  ConflictException,
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  PrescriptionService,
  isCounterInitializationRace,
} from '../src/prescription/prescription.service.js';
import {
  Prescription,
  PrescriptionSchema,
  PrescriptionStatus,
  PrescriptionDocument,
} from '../src/prescription/schemas/prescription.schema.js';
import {
  PrescriptionRevision,
  PrescriptionRevisionSchema,
  PrescriptionRevisionDocument,
} from '../src/prescription/schemas/prescription-revision.schema.js';
import {
  Consultation,
  ConsultationSchema,
  ConsultationStatus,
  ConsultationDocument,
} from '../src/consultation/schemas/consultation.schema.js';
import {
  Patient,
  PatientSchema,
  PatientStatus,
  PatientDocument,
  PatientGender,
} from '../src/patient/schemas/patient.schema.js';
import {
  ClinicSequenceCounter,
  ClinicSequenceCounterSchema,
  ClinicSequenceCounterDocument,
} from '../src/patient/schemas/clinic-sequence-counter.schema.js';
import {
  ClinicAuditLog,
  ClinicAuditLogSchema,
  ClinicAuditAction,
  ClinicAuditLogDocument,
} from '../src/clinic/schemas/clinic-audit-log.schema.js';
import {
  IdempotencyRecord,
  IdempotencyRecordSchema,
  IdempotencyRecordDocument,
} from '../src/common/schemas/idempotency-record.schema.js';
import { ClinicRole } from '../src/clinic/schemas/clinic-membership.schema.js';
import {
  MedicineFormulation,
  MedicineRoute,
  TimingType,
  FrequencyCode,
  FoodInstruction,
  DoseUnit,
} from '../src/prescription/schemas/prescription-item.schema.js';
import { PrescriptionItemDto } from '../src/prescription/dto/prescription-item.dto.js';
import { executeInTransaction } from '../src/database/transaction.helper.js';

/**
 * Security assertion: strictly forbids connecting to any remote host or production Atlas database.
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

describe('Real MongoDB Replica Set Integration: Prescription Domain (WiredTiger Multi-Doc Transactions)', () => {
  let replSet: MongoMemoryReplSet;
  let connection: Connection;
  let service: PrescriptionService;

  let prescriptionModel: Model<PrescriptionDocument>;
  let revisionModel: Model<PrescriptionRevisionDocument>;
  let consultationModel: Model<ConsultationDocument>;
  let patientModel: Model<PatientDocument>;
  let counterModel: Model<ClinicSequenceCounterDocument>;
  let auditLogModel: Model<ClinicAuditLogDocument>;
  let idempotencyModel: Model<IdempotencyRecordDocument>;

  const clinicId = new Types.ObjectId('672bb0000000000000000001');
  const doctorId = new Types.ObjectId('672aa0000000000000000002');
  const otherDoctorId = new Types.ObjectId('672aa0000000000000000099');
  const ownerId = new Types.ObjectId('672aa0000000000000000003');
  const patientId = new Types.ObjectId('672cc0000000000000000001');

  beforeAll(async () => {
    // 1. Start ephemeral single-node replica set with WiredTiger storage engine
    replSet = await MongoMemoryReplSet.create({
      replSet: {
        count: 1,
        storageEngine: 'wiredTiger',
      },
    });

    const replSetUri = replSet.getUri('cliniqo_rx_integration_test');
    assertSafeLocalUri(replSetUri);

    // 2. Connect Mongoose directly to the real replica set (no mocks!)
    const mongooseInstance = await mongoose.connect(replSetUri, {
      dbName: 'cliniqo_rx_integration_test',
    });
    connection = mongooseInstance.connection;

    // 3. Compile real Mongoose models
    prescriptionModel = connection.model(
      Prescription.name,
      PrescriptionSchema,
    ) as unknown as Model<PrescriptionDocument>;
    revisionModel = connection.model(
      PrescriptionRevision.name,
      PrescriptionRevisionSchema,
    ) as unknown as Model<PrescriptionRevisionDocument>;
    consultationModel = connection.model(
      Consultation.name,
      ConsultationSchema,
    ) as unknown as Model<ConsultationDocument>;
    patientModel = connection.model(
      Patient.name,
      PatientSchema,
    ) as unknown as Model<PatientDocument>;
    counterModel = connection.model(
      ClinicSequenceCounter.name,
      ClinicSequenceCounterSchema,
    ) as unknown as Model<ClinicSequenceCounterDocument>;
    auditLogModel = connection.model(
      ClinicAuditLog.name,
      ClinicAuditLogSchema,
    ) as unknown as Model<ClinicAuditLogDocument>;
    idempotencyModel = connection.model(
      IdempotencyRecord.name,
      IdempotencyRecordSchema,
    ) as unknown as Model<IdempotencyRecordDocument>;

    // 4. Deploy and sync real indexes
    await Promise.all([
      prescriptionModel.syncIndexes(),
      revisionModel.syncIndexes(),
      consultationModel.syncIndexes(),
      patientModel.syncIndexes(),
      counterModel.syncIndexes(),
      auditLogModel.syncIndexes(),
      idempotencyModel.syncIndexes(),
    ]);

    // 5. Instantiate PrescriptionService with real models and real connection
    service = new PrescriptionService(
      prescriptionModel,
      revisionModel,
      consultationModel,
      patientModel,
      counterModel,
      auditLogModel,
      idempotencyModel,
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
      prescriptionModel.deleteMany({}),
      connection.collection('prescription_revisions').deleteMany({}),
      consultationModel.deleteMany({}),
      patientModel.deleteMany({}),
      counterModel.deleteMany({}),
      connection.collection('clinic_audit_logs').deleteMany({}),
      idempotencyModel.deleteMany({}),
    ]);

    // Seed test patient
    await patientModel.create({
      _id: patientId,
      clinicId,
      patientId: 'P-00101',
      name: 'Rajesh Kumar',
      initials: 'RK',
      age: 38,
      gender: PatientGender.MALE,
      dateOfBirth: new Date('1988-03-21T00:00:00.000Z'),
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

  const validAugmentinItem = {
    name: 'Augmentin 625 Duo',
    genericName: 'Amoxicillin and Potassium Clavulanate',
    formulation: MedicineFormulation.TABLET,
    strength: {
      components: [
        { ingredientName: 'Amoxicillin Trihydrate', amount: 500, unit: 'mg' },
        { ingredientName: 'Potassium Clavulanate', amount: 125, unit: 'mg' },
      ],
      perDenominator: 'tablet',
      display: 'Amoxicillin 500 mg + Clavulanic Acid 125 mg / tablet',
    },
    administeredDose: {
      magnitude: 1,
      unit: DoseUnit.TABLET,
    },
    route: MedicineRoute.ORAL,
    frequency: {
      timingType: TimingType.STANDARD,
      frequencyCode: FrequencyCode.BD,
      scheduleLabel: '1-0-1',
    },
    duration: { value: 5, unit: 'DAYS' as const },
    dispenseQuantity: { count: 10, packageDescription: '10 Tablets' },
    foodInstruction: FoodInstruction.WITH_MEALS,
    instructions: 'Complete full 5-day course',
  } satisfies PrescriptionItemDto;

  const createFinalizedConsultation = async (): Promise<Types.ObjectId> => {
    const consultId = new Types.ObjectId();
    await consultationModel.create({
      _id: consultId,
      clinicId,
      patientId,
      patientCode: 'P-00101',
      doctorId,
      consultationDate: new Date('2026-10-25T00:00:00.000Z'),
      chiefComplaint: 'Severe pharyngitis and fever',
      diagnosis: 'Acute bacterial tonsillitis',
      vitals: { systolic: 120, diastolic: 80, heartRate: 78, temperature: 99.2 },
      provisionalMedicines: [],
      status: ConsultationStatus.FINALIZED,
      hasPrescription: false,
      prescriptionId: null,
      version: 1,
      createdBy: doctorId,
      updatedBy: doctorId,
    });
    return consultId;
  };

  describe('1. Multi-Document Transaction Commit & Rollback Atomicity', () => {
    it('commits prescription, revision 1, consultation bridge link, and audit log atomically', async () => {
      const consultId = await createFinalizedConsultation();

      const rx = await service.createPrescription(
        clinicId,
        consultId.toString(),
        {
          items: [validAugmentinItem],
          generalAdvice: 'Drink plenty of water',
        },
        doctorId,
      );

      expect(rx.prescriptionNumber).toBe('RX-00101');
      expect(rx.status).toBe(PrescriptionStatus.ACTIVE);
      expect(rx.currentRevisionNumber).toBe(1);

      // Verify real database collections
      const savedParent = await prescriptionModel.findOne({ _id: rx._id });
      expect(savedParent).toBeDefined();
      expect(savedParent?.prescriptionNumber).toBe('RX-00101');

      const savedRev = await revisionModel.findOne({ prescriptionId: rx._id, revisionNumber: 1 });
      expect(savedRev).toBeDefined();
      expect(savedRev?.clinicalSnapshot.diagnosis).toBe('Acute bacterial tonsillitis');
      expect(savedRev?.clinicalSnapshot.chiefComplaint).toBe('Severe pharyngitis and fever');

      const updatedConsult = await consultationModel.findOne({ _id: consultId });
      expect(updatedConsult?.hasPrescription).toBe(true);
      expect(updatedConsult?.prescriptionId?.toString()).toBe(rx._id.toString());
      expect(updatedConsult?.version).toBe(2);

      const auditLog = await auditLogModel.findOne({
        clinicId,
        action: ClinicAuditAction.PRESCRIPTION_ISSUED,
      });
      expect(auditLog).toBeDefined();
      expect(auditLog?.actorDoctorId.toString()).toBe(doctorId.toString());
    });

    it('rolls back completely if an error occurs within the transaction', async () => {
      const consultId = await createFinalizedConsultation();

      // Corrupt consultation status inside an independent session right before linkage
      await expect(
        executeInTransaction(connection, async (session) => {
          // Pre-allocate prescription in session
          const num = await service.generatePrescriptionNumber(clinicId, session);
          const rxId = new Types.ObjectId();

          await revisionModel.create(
            [
              {
                clinicId,
                prescriptionId: rxId,
                consultationId: consultId,
                patientId,
                prescribedBy: doctorId,
                revisionNumber: 1,
                reasonForRevision: 'Initial issuance',
                items: [validAugmentinItem],
                clinicalSnapshot: {
                  consultationId: consultId,
                  patientId,
                  patientCode: 'P-00101',
                  doctorId,
                  consultationDate: new Date(),
                  chiefComplaint: 'Cough',
                  diagnosis: 'Bronchitis',
                  vitals: {},
                  provisionalMedicines: [],
                },
              },
            ],
            { session },
          );

          await prescriptionModel.create(
            [
              {
                _id: rxId,
                clinicId,
                patientId,
                patientCode: 'P-00101',
                consultationId: consultId,
                prescriptionNumber: num,
                status: PrescriptionStatus.ACTIVE,
                currentRevisionNumber: 1,
                latestRevisionId: new Types.ObjectId(),
                prescribedBy: doctorId,
                version: 1,
              },
            ],
            { session },
          );

          // Force failure
          throw new Error('Simulated network failure right before commit');
        }),
      ).rejects.toThrow(/database error occurred/);

      // Verify rollback across collections
      const countRx = await prescriptionModel.countDocuments();
      const countRevs = await revisionModel.countDocuments();
      expect(countRx).toBe(0);
      expect(countRevs).toBe(0);

      const consult = await consultationModel.findOne({ _id: consultId });
      expect(consult?.hasPrescription).toBe(false);
      expect(consult?.prescriptionId).toBeNull();
    });
  });

  describe('2. Concurrency-Safe Counter Initialization & Allocation', () => {
    it('allocates sequential prescription numbers concurrently without duplicates, starting at RX-00101', async () => {
      // Execute 10 concurrent allocations against empty counter
      const promises = Array.from({ length: 10 }, () =>
        executeInTransaction(
          connection,
          (session) => service.generatePrescriptionNumber(clinicId, session),
          { isRetryableError: isCounterInitializationRace, maxRetries: 5, baseDelayMs: 25 },
        ),
      );

      const results = await Promise.all(promises);

      // Verify all 10 got distinct sequential numbers
      const uniqueNumbers = new Set(results);
      expect(uniqueNumbers.size).toBe(10);

      // Verify sequence starts at RX-00101 and ends at RX-00110
      const sorted = [...results].sort();
      expect(sorted[0]).toBe('RX-00101');
      expect(sorted[9]).toBe('RX-00110');

      // Verify only 1 counter document exists for this clinic
      const counters = await counterModel.find({ clinicId, sequenceName: 'prescription' });
      expect(counters).toHaveLength(1);
      expect(counters[0].seq).toBe(110);
    });
  });

  describe('3. Atomic Replacement Workflow & Race Condition Prevention', () => {
    it('successfully replaces a discontinued prescription, establishing bidirectional links', async () => {
      const consultId = await createFinalizedConsultation();

      // 1. Initial prescription
      const rx1 = await service.createPrescription(
        clinicId,
        consultId.toString(),
        { items: [validAugmentinItem] },
        doctorId,
      );

      // 2. Discontinue rx1
      await service.discontinuePrescription(
        clinicId,
        rx1._id.toString(),
        {
          expectedVersion: 1,
          discontinuationReason: 'Adverse gastrointestinal reaction',
        },
        doctorId,
      );

      // 3. Replace rx1 with rx2
      const rx2 = await service.createPrescription(
        clinicId,
        consultId.toString(),
        {
          replacesPrescriptionId: rx1._id.toString(),
          items: [validAugmentinItem],
          generalAdvice: 'Take with food',
        },
        doctorId,
      );

      expect(rx2.prescriptionNumber).toBe('RX-00102');
      expect(rx2.replacesPrescriptionId.toString()).toBe(rx1._id.toString());

      // Verify old prescription has replacedByPrescriptionId set
      const updatedRx1 = await prescriptionModel.findOne({ _id: rx1._id });
      expect(updatedRx1?.replacedByPrescriptionId?.toString()).toBe(rx2._id.toString());
      expect(updatedRx1?.version).toBe(3);

      // Verify consultation points to rx2
      const consult = await consultationModel.findOne({ _id: consultId });
      expect(consult?.prescriptionId?.toString()).toBe(rx2._id.toString());
    });

    it('prevents concurrent replacement race: exactly one request replaces, the second gets 409 Conflict', async () => {
      const consultId = await createFinalizedConsultation();

      const rx1 = await service.createPrescription(
        clinicId,
        consultId.toString(),
        { items: [validAugmentinItem] },
        doctorId,
      );

      await service.discontinuePrescription(
        clinicId,
        rx1._id.toString(),
        {
          expectedVersion: 1,
          discontinuationReason: 'Switching therapy',
        },
        doctorId,
      );

      // Fire 2 concurrent replacements for rx1
      const p1 = service.createPrescription(
        clinicId,
        consultId.toString(),
        {
          replacesPrescriptionId: rx1._id.toString(),
          items: [validAugmentinItem],
        },
        doctorId,
      );

      const p2 = service.createPrescription(
        clinicId,
        consultId.toString(),
        {
          replacesPrescriptionId: rx1._id.toString(),
          items: [validAugmentinItem],
        },
        doctorId,
      );

      const outcomes = await Promise.allSettled([p1, p2]);

      const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
      const rejected = outcomes.filter((o) => o.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
    });
  });

  describe('4. Optimistic Revision Locking & Concurrency Protection', () => {
    it('appends Revision 2 with reason and locks against concurrent conflicting revisions', async () => {
      const consultId = await createFinalizedConsultation();

      const rx1 = await service.createPrescription(
        clinicId,
        consultId.toString(),
        { items: [validAugmentinItem] },
        doctorId,
      );

      const revisedItem = {
        ...validAugmentinItem,
        duration: { value: 7, unit: 'DAYS' as const },
      };

      // Two concurrent revision requests racing on Revision 1 / Version 1
      const revReq1 = service.revisePrescription(
        clinicId,
        rx1._id.toString(),
        {
          expectedRevisionNumber: 1,
          expectedVersion: 1,
          reasonForRevision: 'Course adjusted to 7 days',
          items: [revisedItem],
        },
        doctorId,
      );

      const revReq2 = service.revisePrescription(
        clinicId,
        rx1._id.toString(),
        {
          expectedRevisionNumber: 1,
          expectedVersion: 1,
          reasonForRevision: 'Alternate dose change',
          items: [revisedItem],
        },
        doctorId,
      );

      const outcomes = await Promise.allSettled([revReq1, revReq2]);
      const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
      const rejected = outcomes.filter((o) => o.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);

      // Verify exactly Revision 1 and Revision 2 exist in the database
      const revisions = await revisionModel
        .find({ prescriptionId: rx1._id })
        .sort({ revisionNumber: 1 });
      expect(revisions).toHaveLength(2);
      expect(revisions[0].revisionNumber).toBe(1);
      expect(revisions[1].revisionNumber).toBe(2);
    });
  });

  describe('5. Mongoose Pre-Hook Immutability Defense', () => {
    it('blocks direct revision modification via updateOne with immutable error', async () => {
      const consultId = await createFinalizedConsultation();
      const rx = await service.createPrescription(
        clinicId,
        consultId.toString(),
        { items: [validAugmentinItem] },
        doctorId,
      );

      await expect(
        revisionModel.updateOne(
          { prescriptionId: rx._id, revisionNumber: 1 },
          { $set: { generalAdvice: 'Hacked instructions' } },
        ),
      ).rejects.toThrow(/strictly immutable/);
    });

    it('blocks direct revision modification via findOneAndUpdate with immutable error', async () => {
      const consultId = await createFinalizedConsultation();
      const rx = await service.createPrescription(
        clinicId,
        consultId.toString(),
        { items: [validAugmentinItem] },
        doctorId,
      );

      await expect(
        revisionModel.findOneAndUpdate(
          { prescriptionId: rx._id, revisionNumber: 1 },
          { $set: { generalAdvice: 'Hacked instructions' } },
        ),
      ).rejects.toThrow(/strictly immutable/);
    });
  });

  describe('6. Cancellation Authorization Ordering & Attribution', () => {
    it('authorizes prescribing doctor to cancel their prescription', async () => {
      const consultId = await createFinalizedConsultation();
      const rx = await service.createPrescription(
        clinicId,
        consultId.toString(),
        { items: [validAugmentinItem] },
        doctorId,
      );

      const res = await service.cancelPrescription(
        clinicId,
        rx._id.toString(),
        doctorId,
        ClinicRole.DOCTOR,
        { cancellationReason: 'Adverse event' },
      );

      expect(res.message).toBe('Prescription successfully cancelled.');

      const updated = await prescriptionModel.findById(rx._id);
      expect(updated?.status).toBe(PrescriptionStatus.CANCELLED);
      expect(updated?.cancelledBy?.toString()).toBe(doctorId.toString());
    });

    it('allows clinic OWNER to cancel prescription issued by another doctor with attribution in audit log', async () => {
      const consultId = await createFinalizedConsultation();
      const rx = await service.createPrescription(
        clinicId,
        consultId.toString(),
        { items: [validAugmentinItem] },
        doctorId, // Prescribed by doctorId
      );

      const res = await service.cancelPrescription(
        clinicId,
        rx._id.toString(),
        ownerId, // Cancelled by ownerId
        ClinicRole.OWNER,
        { cancellationReason: 'Owner administrative override' },
      );

      expect(res.message).toBe('Prescription successfully cancelled.');

      const audit = await auditLogModel.findOne({
        clinicId,
        action: ClinicAuditAction.PRESCRIPTION_CANCELLED,
      });
      expect(audit).toBeDefined();
      expect(audit?.actorDoctorId.toString()).toBe(ownerId.toString());
      expect(audit?.targetDoctorId?.toString()).toBe(doctorId.toString());
      expect(audit?.role).toBe(ClinicRole.OWNER);
    });

    it('rejects unauthorized clinician with 403 Forbidden even if targeting already-cancelled prescription', async () => {
      const consultId = await createFinalizedConsultation();
      const rx = await service.createPrescription(
        clinicId,
        consultId.toString(),
        { items: [validAugmentinItem] },
        doctorId,
      );

      // Cancel first by owner
      await service.cancelPrescription(
        clinicId,
        rx._id.toString(),
        ownerId,
        ClinicRole.OWNER,
        { cancellationReason: 'Owner cancel' },
      );

      // Now unauthorized clinician tries to cancel already-cancelled prescription
      await expect(
        service.cancelPrescription(
          clinicId,
          rx._id.toString(),
          otherDoctorId, // Neither prescribing doctor nor owner!
          ClinicRole.DOCTOR,
          { cancellationReason: 'Sneaky cancel' },
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('7. Dynamic Demographics Resolution', () => {
    it('dynamically resolves updated patient demographics from Patient domain', async () => {
      const consultId = await createFinalizedConsultation();
      const rx = await service.createPrescription(
        clinicId,
        consultId.toString(),
        { items: [validAugmentinItem] },
        doctorId,
      );

      // First fetch
      const res1 = await service.getPrescriptionById(clinicId, rx._id.toString());
      expect(res1.patient.patientName).toBe('Rajesh Kumar');

      // Update patient name directly in Patient collection
      await patientModel.updateOne(
        { _id: patientId },
        { $set: { name: 'Rajesh Sharma-Kumar', phone: '9998887776' } },
      );

      // Second fetch: should reflect dynamic demographics
      const res2 = await service.getPrescriptionById(clinicId, rx._id.toString());
      expect(res2.patient.patientName).toBe('Rajesh Sharma-Kumar');
      expect(res2.patient.contactNumber).toBe('9998887776');
    });
  });

  describe('8. Idempotency Lease Fencing & Replay', () => {
    it('returns exact replayed response on repeated calls with identical Idempotency-Key', async () => {
      const consultId = await createFinalizedConsultation();
      const key = 'repl-idem-test-01';

      const res1 = await service.createPrescription(
        clinicId,
        consultId.toString(),
        { items: [validAugmentinItem] },
        doctorId,
        key,
      );

      expect(res1.prescriptionNumber).toBe('RX-00101');

      // Replay request with same key
      const res2 = await service.createPrescription(
        clinicId,
        consultId.toString(),
        { items: [validAugmentinItem] },
        doctorId,
        key,
      );

      expect(res2.prescriptionNumber).toBe('RX-00101');
      expect(res2._id.toString()).toBe(res1._id.toString());

      // Only 1 prescription exists
      const count = await prescriptionModel.countDocuments();
      expect(count).toBe(1);
    });

    it('rejects duplicate Idempotency-Key with different payload with 422 Unprocessable Entity', async () => {
      const consultId = await createFinalizedConsultation();
      const key = 'repl-idem-test-02';

      await service.createPrescription(
        clinicId,
        consultId.toString(),
        { items: [validAugmentinItem] },
        doctorId,
        key,
      );

      const alteredItem = {
        ...validAugmentinItem,
        instructions: 'Take with warm milk',
      } satisfies PrescriptionItemDto;

      await expect(
        service.createPrescription(
          clinicId,
          consultId.toString(),
          { items: [alteredItem] },
          doctorId,
          key,
        ),
      ).rejects.toThrow(UnprocessableEntityException);
    });
  });
});
