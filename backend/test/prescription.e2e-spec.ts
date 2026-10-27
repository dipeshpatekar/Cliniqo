import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe, Global, Module } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import request from 'supertest';
import { Types } from 'mongoose';
import { AppModule } from '../src/app.module.js';
import { DatabaseModule } from '../src/database/database.module.js';
import { TokenService } from '../src/auth/token.service.js';
import { MailService } from '../src/auth/mail.service.js';
import { Doctor } from '../src/auth/schemas/doctor.schema.js';
import { DoctorStatus } from '../src/auth/auth.constants.js';
import { Clinic, ClinicStatus } from '../src/clinic/schemas/clinic.schema.js';
import {
  ClinicMembership,
  ClinicRole,
  ClinicMembershipStatus,
} from '../src/clinic/schemas/clinic-membership.schema.js';
import { ClinicInvitation } from '../src/clinic/schemas/clinic-invitation.schema.js';
import { InvitationOutbox } from '../src/clinic/schemas/invitation-outbox.schema.js';
import {
  ClinicAuditLog,
  ClinicAuditAction,
} from '../src/clinic/schemas/clinic-audit-log.schema.js';
import { RefreshSession } from '../src/auth/schemas/refresh-session.schema.js';
import { PasswordResetToken } from '../src/auth/schemas/password-reset.schema.js';
import { RateLimit } from '../src/auth/schemas/rate-limit.schema.js';
import { Patient, PatientStatus } from '../src/patient/schemas/patient.schema.js';
import { ClinicSequenceCounter } from '../src/patient/schemas/clinic-sequence-counter.schema.js';
import {
  Consultation,
  ConsultationStatus,
} from '../src/consultation/schemas/consultation.schema.js';
import { ConsultationAddendum } from '../src/consultation/schemas/consultation-addendum.schema.js';
import {
  Prescription,
  PrescriptionStatus,
} from '../src/prescription/schemas/prescription.schema.js';
import { PrescriptionRevision } from '../src/prescription/schemas/prescription-revision.schema.js';
import { IdempotencyRecord } from '../src/common/schemas/idempotency-record.schema.js';
import {
  MedicineFormulation,
  MedicineRoute,
  TimingType,
  FrequencyCode,
  FoodInstruction,
  DoseUnit,
} from '../src/prescription/schemas/prescription-item.schema.js';

describe('Prescription Domain: Revisions, Replacement, Cancellation & Tenancy (e2e)', () => {
  const originalEnv = { ...process.env };

  beforeAll(() => {
    process.env.JWT_ACCESS_SECRET =
      'test-jwt-access-secret-32-chars-long-minimum!';
    process.env.JWT_REFRESH_SECRET =
      'test-jwt-refresh-secret-32-chars-long-minimum!';
    process.env.JWT_ISSUER = 'cliniqo-api-test';
    process.env.JWT_AUDIENCE = 'cliniqo-client-test';
    process.env.OUTBOX_ENCRYPTION_KEY =
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  let app: INestApplication;
  let tokenService: TokenService;

  // In-memory stores
  const doctorsDb = new Map<string, any>();
  const clinicsDb = new Map<string, any>();
  const membershipsDb = new Map<string, any>();
  const patientsDb = new Map<string, any>();
  const consultationsDb = new Map<string, any>();
  const prescriptionsDb = new Map<string, any>();
  const revisionsDb = new Map<string, any>();
  const countersDb = new Map<string, number>();
  const idempotencyDb = new Map<string, any>();
  const auditLogsDb: any[] = [];

  // Doctors
  const doctorOwnerId = new Types.ObjectId('672aa0000000000000000001');
  const doctorClinicianAId = new Types.ObjectId('672aa0000000000000000002');
  const doctorClinicianBId = new Types.ObjectId('672aa0000000000000000003');
  const doctorStaffId = new Types.ObjectId('672aa0000000000000000004');
  const doctorOutsiderId = new Types.ObjectId('672aa0000000000000000005');

  let ownerToken: string;
  let clinicianAToken: string;
  let clinicianBToken: string;
  let staffToken: string;
  let outsiderToken: string;

  // Clinics
  const clinicAId = new Types.ObjectId('672bb0000000000000000001');
  const clinicBId = new Types.ObjectId('672bb0000000000000000002');
  const clinicAIdStr = clinicAId.toString();
  const clinicBIdStr = clinicBId.toString();

  // Patient in Clinic A
  const patientAId = new Types.ObjectId('672cc0000000000000000001');
  const patientAIdStr = patientAId.toString();

  // Consultation in Clinic A
  const finalizedConsultationId = new Types.ObjectId('672dd0000000000000000001');
  const draftConsultationId = new Types.ObjectId('672dd0000000000000000002');

  const createQueryMock = (result: any) => {
    const promise = Promise.resolve(result);
    return Object.assign(promise, {
      session: vi.fn().mockReturnThis(),
      exec: vi.fn().mockImplementation(() => promise),
      sort: vi.fn().mockReturnThis(),
      skip: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      populate: vi.fn().mockReturnThis(),
      lean: vi.fn().mockImplementation(() => promise),
    });
  };

  const mockDoctorModel = {
    findById: vi.fn().mockImplementation((id) =>
      createQueryMock(doctorsDb.get(id?.toString()) || null),
    ),
    findOne: vi.fn().mockImplementation((query) => {
      for (const doc of doctorsDb.values()) {
        if (query.email && doc.email === query.email.toLowerCase()) {
          return createQueryMock(doc);
        }
      }
      return createQueryMock(null);
    }),
  };

  const mockClinicModel = {
    findById: vi.fn().mockImplementation((id) =>
      createQueryMock(clinicsDb.get(id?.toString()) || null),
    ),
    findOne: vi.fn().mockImplementation((query) => {
      if (query._id) {
        return createQueryMock(clinicsDb.get(query._id.toString()) || null);
      }
      return createQueryMock(null);
    }),
  };

  const mockMembershipModel = {
    findOne: vi.fn().mockImplementation((query) => {
      for (const m of membershipsDb.values()) {
        const clinicMatch =
          !query.clinicId || m.clinicId.toString() === query.clinicId.toString();
        const doctorMatch =
          !query.doctorId || m.doctorId.toString() === query.doctorId.toString();
        const statusMatch = !query.status || m.status === query.status;

        if (clinicMatch && doctorMatch && statusMatch) {
          return createQueryMock(m);
        }
      }
      return createQueryMock(null);
    }),
  };

  const mockPatientModel = {
    findOne: vi.fn().mockImplementation((filter) => {
      for (const p of patientsDb.values()) {
        const clinicMatch =
          !filter.clinicId || p.clinicId.toString() === filter.clinicId.toString();
        const idMatch =
          !filter._id || p._id.toString() === filter._id.toString();
        if (clinicMatch && idMatch) {
          return createQueryMock({
            ...p,
            toObject: () => ({ ...p }),
          });
        }
      }
      return createQueryMock(null);
    }),
  };

  const mockConsultationModel = {
    findOne: vi.fn().mockImplementation((filter) => {
      for (const c of consultationsDb.values()) {
        const clinicMatch =
          !filter.clinicId || c.clinicId.toString() === filter.clinicId.toString();
        const idMatch =
          !filter._id || c._id.toString() === filter._id.toString();
        const statusMatch = !filter.status || c.status === filter.status;

        if (clinicMatch && idMatch && statusMatch) {
          return createQueryMock({
            ...c,
            toObject: () => ({ ...c }),
          });
        }
      }
      return createQueryMock(null);
    }),
    updateOne: vi.fn().mockImplementation((filter, update) => {
      for (const c of consultationsDb.values()) {
        const clinicMatch =
          !filter.clinicId || c.clinicId.toString() === filter.clinicId.toString();
        const idMatch =
          !filter._id || c._id.toString() === filter._id.toString();
        const statusMatch = !filter.status || c.status === filter.status;

        if (clinicMatch && idMatch && statusMatch) {
          if (update.$set) Object.assign(c, update.$set);
          if (update.$inc) {
            for (const [k, v] of Object.entries(update.$inc)) {
              c[k] = (c[k] || 0) + (v as number);
            }
          }
          consultationsDb.set(c._id.toString(), { ...c });
          return Promise.resolve({ matchedCount: 1, modifiedCount: 1 });
        }
      }
      return Promise.resolve({ matchedCount: 0, modifiedCount: 0 });
    }),
  };

  const mockCounterModel = {
    findOneAndUpdate: vi.fn().mockImplementation((filter, _update) => {
      const key = `${filter.clinicId.toString()}_${filter.sequenceName}`;
      let current = countersDb.get(key) || 100;
      current += 1;
      countersDb.set(key, current);
      return Promise.resolve({ seq: current });
    }),
  };

  const mockPrescriptionModel = {
    create: vi.fn().mockImplementation((docs) => {
      const created = docs.map((d: any) => {
        const doc = {
          _id: d._id || new Types.ObjectId(),
          ...d,
          createdAt: new Date(),
          updatedAt: new Date(),
          toObject: function () {
            const { toObject: _, ...rest } = this;
            return rest;
          },
        };
        prescriptionsDb.set(doc._id.toString(), doc);
        return doc;
      });
      return Promise.resolve(created);
    }),
    findOne: vi.fn().mockImplementation((filter) => {
      for (const p of prescriptionsDb.values()) {
        const clinicMatch =
          !filter.clinicId || p.clinicId.toString() === filter.clinicId.toString();
        const idMatch =
          !filter._id || p._id.toString() === filter._id.toString();
        const statusMatch = !filter.status || p.status === filter.status;
        const consultMatch =
          !filter.consultationId ||
          p.consultationId.toString() === filter.consultationId.toString();

        if (clinicMatch && idMatch && statusMatch && consultMatch) {
          return createQueryMock({
            ...p,
            toObject: () => ({ ...p }),
          });
        }
      }
      return createQueryMock(null);
    }),
    find: vi.fn().mockImplementation((filter) => {
      const results: any[] = [];
      for (const p of prescriptionsDb.values()) {
        const clinicMatch =
          !filter.clinicId || p.clinicId.toString() === filter.clinicId.toString();
        const patientMatch =
          !filter.patientId || p.patientId.toString() === filter.patientId.toString();
        const consultMatch =
          !filter.consultationId ||
          p.consultationId.toString() === filter.consultationId.toString();
        const statusMatch = !filter.status || p.status === filter.status;

        if (clinicMatch && patientMatch && consultMatch && statusMatch) {
          results.push({
            ...p,
            toObject: () => ({ ...p }),
          });
        }
      }
      return createQueryMock(results);
    }),
    countDocuments: vi.fn().mockImplementation((filter) => {
      let count = 0;
      for (const p of prescriptionsDb.values()) {
        const clinicMatch =
          !filter.clinicId || p.clinicId.toString() === filter.clinicId.toString();
        const patientMatch =
          !filter.patientId || p.patientId.toString() === filter.patientId.toString();
        const consultMatch =
          !filter.consultationId ||
          p.consultationId.toString() === filter.consultationId.toString();
        const statusMatch = !filter.status || p.status === filter.status;

        if (clinicMatch && patientMatch && consultMatch && statusMatch) {
          count++;
        }
      }
      return createQueryMock(count);
    }),
    findOneAndUpdate: vi.fn().mockImplementation((filter, update) => {
      for (const p of prescriptionsDb.values()) {
        const clinicMatch =
          !filter.clinicId || p.clinicId.toString() === filter.clinicId.toString();
        const idMatch =
          !filter._id || p._id.toString() === filter._id.toString();
        let statusMatch = true;
        if (filter.status) {
          if (filter.status.$in) {
            statusMatch = filter.status.$in.includes(p.status);
          } else {
            statusMatch = p.status === filter.status;
          }
        }
        const revMatch =
          filter.currentRevisionNumber === undefined ||
          p.currentRevisionNumber === filter.currentRevisionNumber;
        const verMatch =
          filter.version === undefined || p.version === filter.version;
        const replacedByMatch =
          filter.replacedByPrescriptionId === undefined ||
          p.replacedByPrescriptionId === filter.replacedByPrescriptionId;

        if (
          clinicMatch &&
          idMatch &&
          statusMatch &&
          revMatch &&
          verMatch &&
          replacedByMatch
        ) {
          if (update.$set) Object.assign(p, update.$set);
          if (update.$inc) {
            for (const [k, v] of Object.entries(update.$inc)) {
              p[k] = (p[k] || 0) + (v as number);
            }
          }
          p.updatedAt = new Date();
          prescriptionsDb.set(p._id.toString(), { ...p });
          return Promise.resolve({
            ...p,
            toObject: () => ({ ...p }),
          });
        }
      }
      return Promise.resolve(null);
    }),
  };

  const mockRevisionModel = {
    create: vi.fn().mockImplementation((docs) => {
      const created = docs.map((d: any) => {
        const doc = {
          _id: d._id || new Types.ObjectId(),
          ...d,
          createdAt: new Date(),
          toObject: function () {
            const { toObject: _, ...rest } = this;
            return rest;
          },
        };
        revisionsDb.set(doc._id.toString(), doc);
        return doc;
      });
      return Promise.resolve(created);
    }),
    findOne: vi.fn().mockImplementation((filter) => {
      for (const r of revisionsDb.values()) {
        const clinicMatch =
          !filter.clinicId || r.clinicId.toString() === filter.clinicId.toString();
        const rxMatch =
          !filter.prescriptionId ||
          r.prescriptionId.toString() === filter.prescriptionId.toString();
        const revNumMatch =
          filter.revisionNumber === undefined ||
          r.revisionNumber === filter.revisionNumber;

        if (clinicMatch && rxMatch && revNumMatch) {
          return createQueryMock({
            ...r,
            toObject: () => ({ ...r }),
          });
        }
      }
      return createQueryMock(null);
    }),
    find: vi.fn().mockImplementation((filter) => {
      const results: any[] = [];
      for (const r of revisionsDb.values()) {
        const clinicMatch =
          !filter.clinicId || r.clinicId.toString() === filter.clinicId.toString();
        const rxMatch =
          !filter.prescriptionId ||
          r.prescriptionId.toString() === filter.prescriptionId.toString();

        if (clinicMatch && rxMatch) {
          results.push({
            ...r,
            toObject: () => ({ ...r }),
          });
        }
      }
      results.sort((a, b) => a.revisionNumber - b.revisionNumber);
      return createQueryMock(results);
    }),
  };

  const mockIdempotencyModel = {
    create: vi.fn().mockImplementation((doc) => {
      const key = `${doc.clinicId.toString()}_${doc.key}`;
      if (idempotencyDb.has(key)) {
        const err: any = new Error('E11000 duplicate key');
        err.code = 11000;
        throw err;
      }
      const record = { ...doc, _id: new Types.ObjectId() };
      idempotencyDb.set(key, record);
      return Promise.resolve(record);
    }),
    findOne: vi.fn().mockImplementation((filter) => {
      const key = `${filter.clinicId.toString()}_${filter.key}`;
      const rec = idempotencyDb.get(key) || null;
      return Promise.resolve(rec);
    }),
    findOneAndUpdate: vi.fn().mockImplementation((filter, update) => {
      const key = `${filter.clinicId.toString()}_${filter.key}`;
      const existing = idempotencyDb.get(key);
      if (!existing) return Promise.resolve(null);

      if (update.$set) Object.assign(existing, update.$set);
      idempotencyDb.set(key, existing);
      return Promise.resolve(existing);
    }),
    updateOne: vi.fn().mockImplementation((filter, update) => {
      const key = `${filter.clinicId.toString()}_${filter.key}`;
      const existing = idempotencyDb.get(key);
      if (existing) {
        if (update.$set) Object.assign(existing, update.$set);
        idempotencyDb.set(key, existing);
      }
      return Promise.resolve({ modifiedCount: existing ? 1 : 0 });
    }),
  };

  const mockAuditLogModel = {
    create: vi.fn().mockImplementation((docs) => {
      const created = docs.map((d: any) => {
        const doc = {
          _id: new Types.ObjectId(),
          ...d,
          timestamp: new Date(),
        };
        auditLogsDb.push(doc);
        return doc;
      });
      return Promise.resolve(created);
    }),
  };

  const mockModels: Record<string, any> = {
    [Doctor.name]: mockDoctorModel,
    [Clinic.name]: mockClinicModel,
    [ClinicMembership.name]: mockMembershipModel,
    [Patient.name]: mockPatientModel,
    [ClinicSequenceCounter.name]: mockCounterModel,
    [Consultation.name]: mockConsultationModel,
    [ConsultationAddendum.name]: { find: vi.fn() },
    [Prescription.name]: mockPrescriptionModel,
    [PrescriptionRevision.name]: mockRevisionModel,
    [IdempotencyRecord.name]: mockIdempotencyModel,
    [ClinicAuditLog.name]: mockAuditLogModel,
    [ClinicInvitation.name]: { find: vi.fn() },
    [InvitationOutbox.name]: { create: vi.fn() },
    [RefreshSession.name]: { findOne: vi.fn() },
    [PasswordResetToken.name]: { findOne: vi.fn() },
    [RateLimit.name]: { findOne: vi.fn() },
  };

  const mockSession: any = {
    startTransaction: vi.fn(),
    commitTransaction: vi.fn(),
    abortTransaction: vi.fn(),
    endSession: vi.fn().mockResolvedValue(undefined),
    inTransaction: vi.fn().mockReturnValue(true),
  };

  const mockConnection: any = {
    readyState: 1,
    models: mockModels,
    model: (name: string) => mockModels[name] || {},
    startSession: vi.fn().mockResolvedValue(mockSession),
    getClient: () => ({
      topology: { description: { type: 'ReplicaSetWithPrimary' } },
    }),
    on: () => {},
    close: async () => {},
  };

  @Global()
  @Module({
    providers: [
      { provide: getConnectionToken(), useValue: mockConnection },
      { provide: getModelToken(Doctor.name), useValue: mockDoctorModel },
      { provide: getModelToken(Clinic.name), useValue: mockClinicModel },
      { provide: getModelToken(ClinicMembership.name), useValue: mockMembershipModel },
      { provide: getModelToken(ClinicInvitation.name), useValue: { find: vi.fn() } },
      { provide: getModelToken(InvitationOutbox.name), useValue: { create: vi.fn() } },
      { provide: getModelToken(ClinicAuditLog.name), useValue: mockAuditLogModel },
      { provide: getModelToken(RefreshSession.name), useValue: { findOne: vi.fn() } },
      { provide: getModelToken(PasswordResetToken.name), useValue: { findOne: vi.fn() } },
      { provide: getModelToken(RateLimit.name), useValue: { findOne: vi.fn() } },
      { provide: getModelToken(Patient.name), useValue: mockPatientModel },
      { provide: getModelToken(ClinicSequenceCounter.name), useValue: mockCounterModel },
      { provide: getModelToken(Consultation.name), useValue: mockConsultationModel },
      { provide: getModelToken(ConsultationAddendum.name), useValue: { find: vi.fn() } },
      { provide: getModelToken(Prescription.name), useValue: mockPrescriptionModel },
      { provide: getModelToken(PrescriptionRevision.name), useValue: mockRevisionModel },
      { provide: getModelToken(IdempotencyRecord.name), useValue: mockIdempotencyModel },
    ],
    exports: [
      getConnectionToken(),
      getModelToken(Doctor.name),
      getModelToken(Clinic.name),
      getModelToken(ClinicMembership.name),
      getModelToken(ClinicInvitation.name),
      getModelToken(InvitationOutbox.name),
      getModelToken(ClinicAuditLog.name),
      getModelToken(RefreshSession.name),
      getModelToken(PasswordResetToken.name),
      getModelToken(RateLimit.name),
      getModelToken(Patient.name),
      getModelToken(ClinicSequenceCounter.name),
      getModelToken(Consultation.name),
      getModelToken(ConsultationAddendum.name),
      getModelToken(Prescription.name),
      getModelToken(PrescriptionRevision.name),
      getModelToken(IdempotencyRecord.name),
    ],
  })
  class MockDatabaseModule {}

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideModule(DatabaseModule)
      .useModule(MockDatabaseModule)
      .overrideProvider(MailService)
      .useValue({ sendPasswordResetEmail: vi.fn().mockResolvedValue(true) })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    tokenService = app.get<TokenService>(TokenService);

    // Seed test doctors
    doctorsDb.set(doctorOwnerId.toString(), {
      _id: doctorOwnerId,
      email: 'owner@clinic-a.com',
      status: DoctorStatus.ACTIVE,
      isEmailVerified: true,
      firstName: 'Owner',
      lastName: 'Doctor',
    });
    doctorsDb.set(doctorClinicianAId.toString(), {
      _id: doctorClinicianAId,
      email: 'clinician-a@clinic-a.com',
      status: DoctorStatus.ACTIVE,
      isEmailVerified: true,
      firstName: 'Clinician',
      lastName: 'A',
    });
    doctorsDb.set(doctorClinicianBId.toString(), {
      _id: doctorClinicianBId,
      email: 'clinician-b@clinic-a.com',
      status: DoctorStatus.ACTIVE,
      isEmailVerified: true,
      firstName: 'Clinician',
      lastName: 'B',
    });
    doctorsDb.set(doctorStaffId.toString(), {
      _id: doctorStaffId,
      email: 'staff@clinic-a.com',
      status: DoctorStatus.ACTIVE,
      isEmailVerified: true,
      firstName: 'Staff',
      lastName: 'Member',
    });
    doctorsDb.set(doctorOutsiderId.toString(), {
      _id: doctorOutsiderId,
      email: 'outsider@other.com',
      status: DoctorStatus.ACTIVE,
      isEmailVerified: true,
      firstName: 'Outsider',
      lastName: 'Doc',
    });

    // Seed test clinics
    clinicsDb.set(clinicAIdStr, {
      _id: clinicAId,
      name: 'Cliniqo Dental & Medical A',
      status: ClinicStatus.ACTIVE,
    });
    clinicsDb.set(clinicBIdStr, {
      _id: clinicBId,
      name: 'Cliniqo Polyclinic B',
      status: ClinicStatus.ACTIVE,
    });

    // Seed memberships
    membershipsDb.set('owner_a', {
      _id: new Types.ObjectId(),
      clinicId: clinicAId,
      doctorId: doctorOwnerId,
      role: ClinicRole.OWNER,
      status: ClinicMembershipStatus.ACTIVE,
    });
    membershipsDb.set('clinician_a', {
      _id: new Types.ObjectId(),
      clinicId: clinicAId,
      doctorId: doctorClinicianAId,
      role: ClinicRole.DOCTOR,
      status: ClinicMembershipStatus.ACTIVE,
    });
    membershipsDb.set('clinician_b', {
      _id: new Types.ObjectId(),
      clinicId: clinicAId,
      doctorId: doctorClinicianBId,
      role: ClinicRole.DOCTOR,
      status: ClinicMembershipStatus.ACTIVE,
    });
    membershipsDb.set('staff_a', {
      _id: new Types.ObjectId(),
      clinicId: clinicAId,
      doctorId: doctorStaffId,
      role: ClinicRole.STAFF,
      status: ClinicMembershipStatus.ACTIVE,
    });
    membershipsDb.set('outsider_b', {
      _id: new Types.ObjectId(),
      clinicId: clinicBId,
      doctorId: doctorOutsiderId,
      role: ClinicRole.DOCTOR,
      status: ClinicMembershipStatus.ACTIVE,
    });

    // Mint auth tokens
    ownerToken = `Bearer ${await tokenService.generateAccessToken({
      _id: doctorOwnerId,
      email: 'owner@clinic-a.com',
      fullName: 'Owner Doctor',
      status: DoctorStatus.ACTIVE,
    })}`;
    clinicianAToken = `Bearer ${await tokenService.generateAccessToken({
      _id: doctorClinicianAId,
      email: 'clinician-a@clinic-a.com',
      fullName: 'Clinician A',
      status: DoctorStatus.ACTIVE,
    })}`;
    clinicianBToken = `Bearer ${await tokenService.generateAccessToken({
      _id: doctorClinicianBId,
      email: 'clinician-b@clinic-a.com',
      fullName: 'Clinician B',
      status: DoctorStatus.ACTIVE,
    })}`;
    staffToken = `Bearer ${await tokenService.generateAccessToken({
      _id: doctorStaffId,
      email: 'staff@clinic-a.com',
      fullName: 'Staff Member',
      status: DoctorStatus.ACTIVE,
    })}`;
    outsiderToken = `Bearer ${await tokenService.generateAccessToken({
      _id: doctorOutsiderId,
      email: 'outsider@other.com',
      fullName: 'Outsider Doc',
      status: DoctorStatus.ACTIVE,
    })}`;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    prescriptionsDb.clear();
    revisionsDb.clear();
    countersDb.clear();
    idempotencyDb.clear();
    auditLogsDb.length = 0;

    // Reset seed patient
    patientsDb.set(patientAIdStr, {
      _id: patientAId,
      clinicId: clinicAId,
      patientId: 'P-00101',
      name: 'Ramesh Sharma',
      dateOfBirth: new Date('1990-06-15T00:00:00.000Z'),
      gender: 'MALE',
      contactNumber: '9876543210',
      status: PatientStatus.ACTIVE,
    });

    // Reset consultations
    consultationsDb.set(finalizedConsultationId.toString(), {
      _id: finalizedConsultationId,
      clinicId: clinicAId,
      patientId: patientAId,
      patientCode: 'P-00101',
      doctorId: doctorClinicianAId,
      consultationDate: new Date('2026-10-25T00:00:00.000Z'),
      chiefComplaint: 'Severe pharyngitis and fever',
      diagnosis: 'Acute bacterial pharyngitis',
      vitals: { bpSystolic: 120, bpDiastolic: 80, pulse: 76, temperature: 98.6 },
      provisionalMedicines: ['Amoxicillin 500mg'],
      status: ConsultationStatus.FINALIZED,
      hasPrescription: false,
      prescriptionId: null,
      version: 1,
    });

    consultationsDb.set(draftConsultationId.toString(), {
      _id: draftConsultationId,
      clinicId: clinicAId,
      patientId: patientAId,
      patientCode: 'P-00101',
      doctorId: doctorClinicianAId,
      consultationDate: new Date('2026-10-25T00:00:00.000Z'),
      chiefComplaint: 'Mild headache',
      status: ConsultationStatus.DRAFT,
      hasPrescription: false,
      prescriptionId: null,
      version: 1,
    });
  });

  const validAugmentinItem: any = {
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
    duration: { value: 5, unit: 'DAYS' },
    dispenseQuantity: { count: 10, packageDescription: '10 Tablets' },
    foodInstruction: FoodInstruction.WITH_MEALS,
    instructions: 'Complete full 5-day course',
  };

  describe('1. Prescription Issuance & Consultation Lifecycle Integration', () => {
    it('rejects prescription issuance against DRAFT consultation with 409 Conflict', async () => {
      const res = await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/consultations/${draftConsultationId.toString()}/prescriptions`)
        .set('Authorization', clinicianAToken)
        .send({ items: [validAugmentinItem] });

      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/only be issued for finalized consultations/);
    });

    it('successfully issues prescription against FINALIZED consultation, generating sequential RX-00101, Revision 1, and bridging consultation', async () => {
      const res = await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/consultations/${finalizedConsultationId.toString()}/prescriptions`)
        .set('Authorization', clinicianAToken)
        .send({
          items: [validAugmentinItem],
          generalAdvice: 'Drink plenty of warm fluids',
        });

      expect(res.status).toBe(201);
      expect(res.body.prescriptionNumber).toBe('RX-00101');
      expect(res.body.status).toBe(PrescriptionStatus.ACTIVE);
      expect(res.body.currentRevisionNumber).toBe(1);
      expect(res.body.latestRevision).toBeDefined();
      expect(res.body.latestRevision.revisionNumber).toBe(1);
      expect(res.body.latestRevision.items).toHaveLength(1);
      expect(res.body.latestRevision.clinicalSnapshot.diagnosis).toBe('Acute bacterial pharyngitis');

      // Verify consultation document was updated
      const consultDoc = consultationsDb.get(finalizedConsultationId.toString());
      expect(consultDoc.hasPrescription).toBe(true);
      expect(consultDoc.prescriptionId.toString()).toBe(res.body._id);

      // Verify audit log
      const audit = auditLogsDb.find(
        (a) => a.action === ClinicAuditAction.PRESCRIPTION_ISSUED,
      );
      expect(audit).toBeDefined();
      expect(audit.actorDoctorId.toString()).toBe(doctorClinicianAId.toString());
    });

    it('rejects duplicate active prescription on the same consultation with 409 Conflict', async () => {
      // First issuance
      await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/consultations/${finalizedConsultationId.toString()}/prescriptions`)
        .set('Authorization', clinicianAToken)
        .send({ items: [validAugmentinItem] });

      // Second issuance attempt
      const res2 = await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/consultations/${finalizedConsultationId.toString()}/prescriptions`)
        .set('Authorization', clinicianAToken)
        .send({ items: [validAugmentinItem] });

      expect(res2.status).toBe(409);
      expect(res2.body.message).toMatch(/active prescription already exists/);
    });
  });

  describe('2. Demographics Resolution & Snapshot Integrity', () => {
    it('GET /clinics/:clinicId/prescriptions/:id dynamically resolves patient demographics and includes snapshot', async () => {
      const createRes = await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/consultations/${finalizedConsultationId.toString()}/prescriptions`)
        .set('Authorization', clinicianAToken)
        .send({ items: [validAugmentinItem] });

      const rxId = createRes.body._id;

      const getRes = await request(app.getHttpServer())
        .get(`/clinics/${clinicAIdStr}/prescriptions/${rxId}`)
        .set('Authorization', clinicianAToken);

      expect(getRes.status).toBe(200);
      expect(getRes.body.prescriptionNumber).toBe('RX-00101');
      expect(getRes.body.patient).toBeDefined();
      expect(getRes.body.patient.patientName).toBe('Ramesh Sharma');
      expect(getRes.body.patient.patientCode).toBe('P-00101');
      expect(getRes.body.patient.age).toBeDefined();
      expect(typeof getRes.body.patient.age).toBe('number');
      expect(getRes.body.patient.gender).toBe('MALE');
      expect(getRes.body.latestRevision.clinicalSnapshot.consultationId.toString()).toBe(
        finalizedConsultationId.toString(),
      );
    });
  });

  describe('3. Immutable Revision Engine & Optimistic Concurrency', () => {
    it('appends Revision 2 with optimistic versioning and allows querying all revisions', async () => {
      const createRes = await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/consultations/${finalizedConsultationId.toString()}/prescriptions`)
        .set('Authorization', clinicianAToken)
        .send({ items: [validAugmentinItem] });

      const rxId = createRes.body._id;

      const revisedItem = {
        ...validAugmentinItem,
        duration: { value: 7, unit: 'DAYS' },
      };

      const reviseRes = await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/prescriptions/${rxId}/revisions`)
        .set('Authorization', clinicianAToken)
        .send({
          expectedRevisionNumber: 1,
          expectedVersion: 1,
          reasonForRevision: 'Extended course due to persistent symptoms',
          items: [revisedItem],
        });

      expect(reviseRes.status).toBe(201);
      expect(reviseRes.body.currentRevisionNumber).toBe(2);
      expect(reviseRes.body.latestRevision.revisionNumber).toBe(2);

      // Verify revision listing returns both revisions in order
      const listRevsRes = await request(app.getHttpServer())
        .get(`/clinics/${clinicAIdStr}/prescriptions/${rxId}/revisions`)
        .set('Authorization', clinicianAToken);

      expect(listRevsRes.status).toBe(200);
      expect(listRevsRes.body).toHaveLength(2);
      expect(listRevsRes.body[0].revisionNumber).toBe(1);
      expect(listRevsRes.body[1].revisionNumber).toBe(2);
      expect(listRevsRes.body[1].reasonForRevision).toBe(
        'Extended course due to persistent symptoms',
      );

      // Verify stale revision fails with 409
      const staleRes = await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/prescriptions/${rxId}/revisions`)
        .set('Authorization', clinicianAToken)
        .send({
          expectedRevisionNumber: 1, // Stale! Current is 2
          expectedVersion: 2,
          reasonForRevision: 'Another revision',
          items: [revisedItem],
        });

      expect(staleRes.status).toBe(409);
      expect(staleRes.body.message).toMatch(/revision sequence was modified/);
    });
  });

  describe('4. Discontinuation & Replacement Workflows', () => {
    it('discontinues prescription and allows replacement with RX-00102 and bidirectional links', async () => {
      // 1. Initial prescription (RX-00101)
      const rx1Res = await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/consultations/${finalizedConsultationId.toString()}/prescriptions`)
        .set('Authorization', clinicianAToken)
        .send({ items: [validAugmentinItem] });

      const rx1Id = rx1Res.body._id;

      // 2. Discontinue RX-00101
      const discRes = await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/prescriptions/${rx1Id}/discontinue`)
        .set('Authorization', clinicianAToken)
        .send({
          expectedVersion: 1,
          discontinuationReason: 'Patient developed mild gastrointestinal upset',
        });

      expect(discRes.status).toBe(200);
      expect(discRes.body.status).toBe(PrescriptionStatus.DISCONTINUED);

      // 3. Replace RX-00101 with Azithromycin prescription (RX-00102)
      const azithroItem: any = {
        name: 'Azithral 500mg Tablet',
        formulation: MedicineFormulation.TABLET,
        strength: {
          components: [{ ingredientName: 'Azithromycin', amount: 500, unit: 'mg' }],
          display: '500 mg',
        },
        administeredDose: { magnitude: 1, unit: DoseUnit.TABLET },
        route: MedicineRoute.ORAL,
        frequency: {
          timingType: TimingType.STANDARD,
          frequencyCode: FrequencyCode.OD,
        },
        duration: { value: 3, unit: 'DAYS' },
        dispenseQuantity: { count: 3, packageDescription: '3 Tablets' },
        foodInstruction: FoodInstruction.BEFORE_MEALS,
      };

      const rx2Res = await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/consultations/${finalizedConsultationId.toString()}/prescriptions`)
        .set('Authorization', clinicianAToken)
        .send({
          replacesPrescriptionId: rx1Id,
          items: [azithroItem],
          generalAdvice: 'Complete full 3-day course',
        });

      expect(rx2Res.status).toBe(201);
      expect(rx2Res.body.prescriptionNumber).toBe('RX-00102');
      expect(rx2Res.body.currentRevisionNumber).toBe(1);
      expect(rx2Res.body.replacesPrescriptionId.toString()).toBe(rx1Id);

      // Verify old prescription has replacedByPrescriptionId set
      const oldDoc = prescriptionsDb.get(rx1Id);
      expect(oldDoc.replacedByPrescriptionId.toString()).toBe(rx2Res.body._id);

      // Verify consultation links to the replacement
      const consultDoc = consultationsDb.get(finalizedConsultationId.toString());
      expect(consultDoc.prescriptionId.toString()).toBe(rx2Res.body._id);
    });
  });

  describe('5. Cancellation Authorization Order & OWNER Override', () => {
    let rxId: string;

    beforeEach(async () => {
      const res = await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/consultations/${finalizedConsultationId.toString()}/prescriptions`)
        .set('Authorization', clinicianAToken)
        .send({ items: [validAugmentinItem] });
      rxId = res.body._id;
    });

    it('denies cancellation by unauthorized clinician with 403 Forbidden', async () => {
      const res = await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/prescriptions/${rxId}/cancel`)
        .set('Authorization', clinicianBToken) // Different clinician!
        .send({ cancellationReason: 'Wrong patient' });

      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/not authorized to cancel a prescription issued by another doctor/);
    });

    it('allows prescribing doctor to cancel their prescription', async () => {
      const res = await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/prescriptions/${rxId}/cancel`)
        .set('Authorization', clinicianAToken) // Prescribing doctor
        .send({ cancellationReason: 'Entered against incorrect consultation date' });

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Prescription successfully cancelled.');

      // Repeating cancellation by authorized doctor is idempotent
      const res2 = await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/prescriptions/${rxId}/cancel`)
        .set('Authorization', clinicianAToken)
        .send({ cancellationReason: 'Repeated cancel' });

      expect(res2.status).toBe(200);
      expect(res2.body.message).toBe('Prescription is already cancelled.');

      // But unauthorized doctor still gets 403 even though it is already cancelled
      const res3 = await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/prescriptions/${rxId}/cancel`)
        .set('Authorization', clinicianBToken)
        .send({ cancellationReason: 'Unauthorized cancel attempt' });

      expect(res3.status).toBe(403);
    });

    it('allows clinic OWNER to cancel prescription issued by another doctor with accurate audit attribution', async () => {
      const res = await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/prescriptions/${rxId}/cancel`)
        .set('Authorization', ownerToken) // Clinic OWNER!
        .send({ cancellationReason: 'Owner administrative cancellation' });

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Prescription successfully cancelled.');

      const cancelAudit = auditLogsDb.find(
        (a) => a.action === ClinicAuditAction.PRESCRIPTION_CANCELLED,
      );
      expect(cancelAudit).toBeDefined();
      expect(cancelAudit.actorDoctorId.toString()).toBe(doctorOwnerId.toString());
      expect(cancelAudit.targetDoctorId.toString()).toBe(doctorClinicianAId.toString());
      expect(cancelAudit.role).toBe(ClinicRole.OWNER);
    });
  });

  describe('6. Role-Based Access Control (RBAC) & Tenancy Isolation', () => {
    let rxId: string;

    beforeEach(async () => {
      const res = await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/consultations/${finalizedConsultationId.toString()}/prescriptions`)
        .set('Authorization', clinicianAToken)
        .send({ items: [validAugmentinItem] });
      rxId = res.body._id;
    });

    it('STAFF member can read prescription but is forbidden from modifying or cancelling', async () => {
      // Read -> 200 OK
      const getRes = await request(app.getHttpServer())
        .get(`/clinics/${clinicAIdStr}/prescriptions/${rxId}`)
        .set('Authorization', staffToken);
      expect(getRes.status).toBe(200);

      // Create -> 403 Forbidden
      const createRes = await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/consultations/${finalizedConsultationId.toString()}/prescriptions`)
        .set('Authorization', staffToken)
        .send({ items: [validAugmentinItem] });
      expect(createRes.status).toBe(403);

      // Revise -> 403 Forbidden
      const reviseRes = await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/prescriptions/${rxId}/revisions`)
        .set('Authorization', staffToken)
        .send({
          expectedRevisionNumber: 1,
          expectedVersion: 1,
          reasonForRevision: 'Staff edit',
          items: [validAugmentinItem],
        });
      expect(reviseRes.status).toBe(403);

      // Cancel -> 403 Forbidden
      const cancelRes = await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/prescriptions/${rxId}/cancel`)
        .set('Authorization', staffToken)
        .send({ cancellationReason: 'Staff cancel' });
      expect(cancelRes.status).toBe(403);
    });

    it('enforces tenancy isolation: token from Clinic B cannot read Clinic A prescription', async () => {
      const res = await request(app.getHttpServer())
        .get(`/clinics/${clinicAIdStr}/prescriptions/${rxId}`)
        .set('Authorization', outsiderToken); // Member of Clinic B only!

      expect(res.status).toBe(403);
    });
  });

  describe('7. Formulation & Dosage Cross-Field Validation', () => {
    it('rejects incompatible formulation and route (e.g. TABLET via INTRAVENOUS) with 400 Bad Request', async () => {
      const invalidItem = {
        ...validAugmentinItem,
        route: MedicineRoute.INTRAVENOUS, // Incompatible with TABLET!
      };

      const res = await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/consultations/${finalizedConsultationId.toString()}/prescriptions`)
        .set('Authorization', clinicianAToken)
        .send({ items: [invalidItem] });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/is incompatible with route/);
    });

    it('rejects negative ingredient amount with 400 Bad Request', async () => {
      const invalidItem = {
        ...validAugmentinItem,
        strength: {
          components: [
            { ingredientName: 'Amoxicillin', amount: -500, unit: 'mg' },
          ],
          display: '-500 mg',
        },
      };

      const res = await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/consultations/${finalizedConsultationId.toString()}/prescriptions`)
        .set('Authorization', clinicianAToken)
        .send({ items: [invalidItem] });

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/strictly greater than 0/);
    });
  });

  describe('8. Idempotency Key Handling & Payload Protection', () => {
    it('returns identical cached response on duplicate request with same Idempotency-Key', async () => {
      const key = 'idem-key-test-001';

      const res1 = await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/consultations/${finalizedConsultationId.toString()}/prescriptions`)
        .set('Authorization', clinicianAToken)
        .set('Idempotency-Key', key)
        .send({ items: [validAugmentinItem] });

      expect(res1.status).toBe(201);
      const originalRxNumber = res1.body.prescriptionNumber;

      // Replay request with same key
      const res2 = await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/consultations/${finalizedConsultationId.toString()}/prescriptions`)
        .set('Authorization', clinicianAToken)
        .set('Idempotency-Key', key)
        .send({ items: [validAugmentinItem] });

      expect(res2.status).toBe(201);
      expect(res2.body.prescriptionNumber).toBe(originalRxNumber);
    });

    it('rejects duplicate Idempotency-Key with different payload with 422 Unprocessable Entity', async () => {
      const key = 'idem-key-test-002';

      await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/consultations/${finalizedConsultationId.toString()}/prescriptions`)
        .set('Authorization', clinicianAToken)
        .set('Idempotency-Key', key)
        .send({ items: [validAugmentinItem] });

      // Changed payload with same key
      const alteredPayload = {
        items: [
          {
            ...validAugmentinItem,
            instructions: 'Different instructions',
          },
        ],
      };

      const res2 = await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/consultations/${finalizedConsultationId.toString()}/prescriptions`)
        .set('Authorization', clinicianAToken)
        .set('Idempotency-Key', key)
        .send(alteredPayload);

      expect(res2.status).toBe(422);
      expect(res2.body.message).toMatch(/previously used with a different/);
    });
  });
});
