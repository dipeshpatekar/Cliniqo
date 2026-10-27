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
import { IdempotencyRecord } from '../src/common/schemas/idempotency-record.schema.js';

describe('Consultation Domain: Clinical Notes, Idempotency, Immutability & Tenancy (e2e)', () => {
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

  // In-memory database stores
  const doctorsDb = new Map<string, any>();
  const clinicsDb = new Map<string, any>();
  const membershipsDb = new Map<string, any>();
  const patientsDb = new Map<string, any>();
  const consultationsDb = new Map<string, any>();
  const addendaDb = new Map<string, any>();
  const idempotencyDb = new Map<string, any>();
  const auditLogsDb: any[] = [];

  // Test Doctors
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

  // Test Clinics
  const clinicAId = new Types.ObjectId('672bb0000000000000000001');
  const clinicBId = new Types.ObjectId('672bb0000000000000000002');
  const clinicAIdStr = clinicAId.toString();
  const clinicBIdStr = clinicBId.toString();

  // Test Patient in Clinic A
  const patientAId = new Types.ObjectId('672cc0000000000000000001');
  const patientAIdStr = patientAId.toString();

  // Test Patient in Clinic B
  const patientBId = new Types.ObjectId('672cc0000000000000000002');
  const patientBIdStr = patientBId.toString();

  let sessionSnapshot: any = null;

  const mockSession: any = {
    startTransaction: vi.fn().mockImplementation(() => {
      sessionSnapshot = {
        patients: new Map(Array.from(patientsDb.entries()).map(([k, v]) => [k, { ...v }])),
        consultations: new Map(Array.from(consultationsDb.entries()).map(([k, v]) => [k, { ...v }])),
        addenda: new Map(Array.from(addendaDb.entries()).map(([k, v]) => [k, { ...v }])),
        idempotency: new Map(Array.from(idempotencyDb.entries()).map(([k, v]) => [k, { ...v }])),
        auditLogs: auditLogsDb.map((l) => ({ ...l })),
      };
    }),
    commitTransaction: vi.fn().mockImplementation(() => {
      sessionSnapshot = null;
    }),
    abortTransaction: vi.fn().mockImplementation(() => {
      if (sessionSnapshot) {
        patientsDb.clear();
        for (const [k, v] of sessionSnapshot.patients.entries()) patientsDb.set(k, v);
        consultationsDb.clear();
        for (const [k, v] of sessionSnapshot.consultations.entries()) consultationsDb.set(k, v);
        addendaDb.clear();
        for (const [k, v] of sessionSnapshot.addenda.entries()) addendaDb.set(k, v);
        idempotencyDb.clear();
        for (const [k, v] of sessionSnapshot.idempotency.entries()) idempotencyDb.set(k, v);
        auditLogsDb.length = 0;
        auditLogsDb.push(...sessionSnapshot.auditLogs);
        sessionSnapshot = null;
      }
    }),
    endSession: vi.fn().mockResolvedValue(undefined),
    inTransaction: vi.fn().mockReturnValue(true),
  };

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
        let idMatch = true;
        if (filter.$or) {
          idMatch = filter.$or.some(
            (c: any) =>
              (c._id && c._id.toString() === p._id.toString()) ||
              (c.patientId && c.patientId === p.patientId),
          );
        } else if (filter.patientId) {
          idMatch = p.patientId === filter.patientId;
        } else if (filter._id) {
          idMatch = p._id.toString() === filter._id.toString();
        }

        if (clinicMatch && idMatch) {
          const doc = {
            ...p,
            toObject: function () {
              return { ...this };
            },
          };
          return createQueryMock(doc);
        }
      }
      return createQueryMock(null);
    }),
    findOneAndUpdate: vi.fn().mockImplementation((filter, update, _opts) => {
      for (const p of patientsDb.values()) {
        if (
          (!filter.clinicId || p.clinicId.toString() === filter.clinicId.toString()) &&
          (!filter._id || p._id.toString() === filter._id.toString())
        ) {
          if (update.$max && update.$max.lastVisitAt) {
            const newDate = new Date(update.$max.lastVisitAt);
            if (!p.lastVisitAt || newDate.getTime() > new Date(p.lastVisitAt).getTime()) {
              p.lastVisitAt = newDate;
            }
          }
          if (update.$set) Object.assign(p, update.$set);
          patientsDb.set(p._id.toString(), { ...p });
          return createQueryMock({ ...p });
        }
      }
      return createQueryMock(null);
    }),
  };

  const mockConsultationModel = {
    create: vi.fn().mockImplementation((docs) => {
      const created = docs.map((d: any) => {
        // Enforce active draft uniqueness per patient
        if (d.status === ConsultationStatus.DRAFT) {
          for (const c of consultationsDb.values()) {
            if (
              c.clinicId.toString() === d.clinicId.toString() &&
              c.patientId.toString() === d.patientId.toString() &&
              c.status === ConsultationStatus.DRAFT
            ) {
              const err: any = new Error(
                'E11000 duplicate key error: uniq_active_consultation_draft_per_patient',
              );
              err.code = 11000;
              throw err;
            }
          }
        }
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
        consultationsDb.set(doc._id.toString(), doc);
        return doc;
      });
      return Promise.resolve(created);
    }),
    find: vi.fn().mockImplementation((filter) => {
      const results: any[] = [];
      for (const c of consultationsDb.values()) {
        const clinicMatch =
          !filter.clinicId || c.clinicId.toString() === filter.clinicId.toString();
        const patientMatch =
          !filter.patientId || c.patientId.toString() === filter.patientId.toString();
        const statusMatch = !filter.status || c.status === filter.status;

        if (clinicMatch && patientMatch && statusMatch) {
          results.push({
            ...c,
            doctorId: doctorsDb.get(c.doctorId.toString()) || { firstName: 'Dr', lastName: 'A' },
            patientId: patientsDb.get(c.patientId.toString()) || { name: 'Patient' },
          });
        }
      }
      return createQueryMock(results);
    }),
    findOne: vi.fn().mockImplementation((filter) => {
      for (const c of consultationsDb.values()) {
        const clinicMatch =
          !filter.clinicId || c.clinicId.toString() === filter.clinicId.toString();
        const idMatch = !filter._id || c._id.toString() === filter._id.toString();
        const patientMatch =
          !filter.patientId || c.patientId.toString() === filter.patientId.toString();
        const statusMatch = !filter.status || c.status === filter.status;

        if (clinicMatch && idMatch && patientMatch && statusMatch) {
          const doc = {
            ...c,
            doctorId: doctorsDb.get(c.doctorId.toString()) || { firstName: 'Dr', lastName: 'A' },
            patientId: patientsDb.get(c.patientId.toString()) || { name: 'Patient' },
            toObject: function () {
              const { toObject: _, ...rest } = this;
              return rest;
            },
          };
          return createQueryMock(doc);
        }
      }
      return createQueryMock(null);
    }),
    findOneAndUpdate: vi.fn().mockImplementation((filter, update, _opts) => {
      for (const c of consultationsDb.values()) {
        const clinicMatch =
          !filter.clinicId || c.clinicId.toString() === filter.clinicId.toString();
        const idMatch = !filter._id || c._id.toString() === filter._id.toString();
        const statusMatch = !filter.status || c.status === filter.status;
        const versionMatch =
          filter.version === undefined || c.version === filter.version;

        if (clinicMatch && idMatch && statusMatch && versionMatch) {
          if (update.$set) Object.assign(c, update.$set);
          if (update.$inc) {
            for (const [k, v] of Object.entries(update.$inc)) {
              c[k] = (c[k] || 0) + (v as number);
            }
          }
          c.updatedAt = new Date();
          consultationsDb.set(c._id.toString(), { ...c });
          const doc = {
            ...c,
            toObject: function () {
              const { toObject: _, ...rest } = this;
              return rest;
            },
          };
          return createQueryMock(doc);
        }
      }
      return createQueryMock(null);
    }),
    countDocuments: vi.fn().mockImplementation((filter) => {
      let count = 0;
      for (const c of consultationsDb.values()) {
        if (
          (!filter.clinicId || c.clinicId.toString() === filter.clinicId.toString()) &&
          (!filter.patientId || c.patientId.toString() === filter.patientId.toString())
        ) {
          count++;
        }
      }
      return Promise.resolve(count);
    }),
  };

  const mockAddendumModel = {
    create: vi.fn().mockImplementation((docs) => {
      const created = docs.map((d: any) => {
        const doc = {
          _id: d._id || new Types.ObjectId(),
          ...d,
          createdAt: new Date(),
          toObject: function () {
            return { ...this };
          },
        };
        addendaDb.set(doc._id.toString(), doc);
        return doc;
      });
      return Promise.resolve(created);
    }),
    find: vi.fn().mockImplementation((filter) => {
      const results: any[] = [];
      for (const a of addendaDb.values()) {
        if (
          (!filter.clinicId || a.clinicId.toString() === filter.clinicId.toString()) &&
          (!filter.consultationId || a.consultationId.toString() === filter.consultationId.toString())
        ) {
          results.push(a);
        }
      }
      return createQueryMock(results);
    }),
  };

  const mockIdempotencyModel = {
    create: vi.fn().mockImplementation((doc) => {
      const key = `${doc.clinicId.toString()}_${doc.key}`;
      if (idempotencyDb.has(key)) {
        const err: any = new Error('E11000 duplicate key error');
        err.code = 11000;
        throw err;
      }
      const record = {
        _id: new Types.ObjectId(),
        ...doc,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      idempotencyDb.set(key, record);
      return Promise.resolve(record);
    }),
    findOne: vi.fn().mockImplementation((query) => {
      const key = `${query.clinicId.toString()}_${query.key}`;
      return Promise.resolve(idempotencyDb.get(key) || null);
    }),
    findOneAndUpdate: vi.fn().mockImplementation((filter, update, _opts) => {
      const key = `${filter.clinicId.toString()}_${filter.key}`;
      const existing = idempotencyDb.get(key);
      if (!existing) return Promise.resolve(null);

      // Check claimToken if present in filter
      if (filter.claimToken && existing.claimToken !== filter.claimToken) {
        return Promise.resolve(null);
      }
      // Check status if present in filter
      if (filter.status && existing.status !== filter.status) {
        return Promise.resolve(null);
      }
      // Check lockedUntil $gt if present in filter (lease fencing)
      if (filter.lockedUntil?.$gt) {
        if (!existing.lockedUntil || new Date(existing.lockedUntil) <= new Date(filter.lockedUntil.$gt)) {
          return Promise.resolve(null);
        }
      }
      // Check $or if present in filter (lease recovery)
      if (filter.$or && Array.isArray(filter.$or)) {
        const matchesOr = filter.$or.some((clause: any) => {
          let match = true;
          if (clause.status && existing.status !== clause.status) match = false;
          if (clause.lockedUntil?.$lte) {
            if (!existing.lockedUntil || new Date(existing.lockedUntil) > new Date(clause.lockedUntil.$lte)) {
              match = false;
            }
          }
          return match;
        });
        if (!matchesOr) return Promise.resolve(null);
      }

      if (update.$set) Object.assign(existing, update.$set);
      if (update.$inc) {
        for (const [k, v] of Object.entries(update.$inc)) {
          existing[k] = (existing[k] || 0) + (v as number);
        }
      }
      existing.updatedAt = new Date();
      idempotencyDb.set(key, existing);
      return Promise.resolve(existing);
    }),
    updateOne: vi.fn().mockImplementation((filter, update) => {
      const key = `${filter.clinicId.toString()}_${filter.key}`;
      const existing = idempotencyDb.get(key);
      if (existing) {
        if (filter.claimToken && existing.claimToken !== filter.claimToken) {
          return Promise.resolve({ modifiedCount: 0 });
        }
        if (filter.status && existing.status !== filter.status) {
          return Promise.resolve({ modifiedCount: 0 });
        }
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
    [ClinicSequenceCounter.name]: { findOneAndUpdate: vi.fn() },
    [ClinicAuditLog.name]: mockAuditLogModel,
    [Consultation.name]: mockConsultationModel,
    [ConsultationAddendum.name]: mockAddendumModel,
    [IdempotencyRecord.name]: mockIdempotencyModel,
    [ClinicInvitation.name]: { find: vi.fn() },
    [InvitationOutbox.name]: { create: vi.fn() },
    [RefreshSession.name]: { findOne: vi.fn() },
    [PasswordResetToken.name]: { findOne: vi.fn() },
    [RateLimit.name]: { findOne: vi.fn() },
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
      {
        provide: getConnectionToken(),
        useValue: mockConnection,
      },
      { provide: getModelToken(Doctor.name), useValue: mockDoctorModel },
      { provide: getModelToken(Clinic.name), useValue: mockClinicModel },
      {
        provide: getModelToken(ClinicMembership.name),
        useValue: mockMembershipModel,
      },
      {
        provide: getModelToken(ClinicInvitation.name),
        useValue: { find: vi.fn() },
      },
      {
        provide: getModelToken(InvitationOutbox.name),
        useValue: { create: vi.fn() },
      },
      {
        provide: getModelToken(ClinicAuditLog.name),
        useValue: mockAuditLogModel,
      },
      {
        provide: getModelToken(RefreshSession.name),
        useValue: { findOne: vi.fn() },
      },
      {
        provide: getModelToken(PasswordResetToken.name),
        useValue: { findOne: vi.fn() },
      },
      { provide: getModelToken(RateLimit.name), useValue: { findOne: vi.fn() } },
      { provide: getModelToken(Patient.name), useValue: mockPatientModel },
      {
        provide: getModelToken(ClinicSequenceCounter.name),
        useValue: { findOneAndUpdate: vi.fn() },
      },
      {
        provide: getModelToken(Consultation.name),
        useValue: mockConsultationModel,
      },
      {
        provide: getModelToken(ConsultationAddendum.name),
        useValue: mockAddendumModel,
      },
      {
        provide: getModelToken(IdempotencyRecord.name),
        useValue: mockIdempotencyModel,
      },
      {
        provide: MailService,
        useValue: { sendPasswordResetOtpEmail: vi.fn() },
      },
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
      getModelToken(IdempotencyRecord.name),
      MailService,
    ],
  })
  class TestDatabaseModule {}

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideModule(DatabaseModule)
      .useModule(TestDatabaseModule)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();

    tokenService = moduleFixture.get<TokenService>(TokenService);

    // Seed Doctors
    doctorsDb.set(doctorOwnerId.toString(), {
      _id: doctorOwnerId,
      email: 'owner@cliniqo.test',
      firstName: 'Owner',
      lastName: 'Doctor',
      status: DoctorStatus.ACTIVE,
    });
    doctorsDb.set(doctorClinicianAId.toString(), {
      _id: doctorClinicianAId,
      email: 'clinician.a@cliniqo.test',
      firstName: 'Nikhil',
      lastName: 'Kanade',
      status: DoctorStatus.ACTIVE,
    });
    doctorsDb.set(doctorClinicianBId.toString(), {
      _id: doctorClinicianBId,
      email: 'clinician.b@cliniqo.test',
      firstName: 'Sneha',
      lastName: 'Sharma',
      status: DoctorStatus.ACTIVE,
    });
    doctorsDb.set(doctorStaffId.toString(), {
      _id: doctorStaffId,
      email: 'staff@cliniqo.test',
      firstName: 'Frontdesk',
      lastName: 'Staff',
      status: DoctorStatus.ACTIVE,
    });
    doctorsDb.set(doctorOutsiderId.toString(), {
      _id: doctorOutsiderId,
      email: 'outsider@cliniqo.test',
      firstName: 'Outsider',
      lastName: 'Doctor',
      status: DoctorStatus.ACTIVE,
    });

    // Seed Clinics
    clinicsDb.set(clinicAIdStr, {
      _id: clinicAId,
      name: 'Alpha Wellness Clinic',
      status: ClinicStatus.ACTIVE,
      ownerDoctorId: doctorOwnerId,
    });
    clinicsDb.set(clinicBIdStr, {
      _id: clinicBId,
      name: 'Beta Diagnostic Center',
      status: ClinicStatus.ACTIVE,
      ownerDoctorId: doctorOutsiderId,
    });

    // Seed Memberships
    membershipsDb.set(`${clinicAIdStr}_${doctorOwnerId.toString()}`, {
      _id: new Types.ObjectId(),
      clinicId: clinicAId,
      doctorId: doctorOwnerId,
      role: ClinicRole.OWNER,
      status: ClinicMembershipStatus.ACTIVE,
    });
    membershipsDb.set(`${clinicAIdStr}_${doctorClinicianAId.toString()}`, {
      _id: new Types.ObjectId(),
      clinicId: clinicAId,
      doctorId: doctorClinicianAId,
      role: ClinicRole.DOCTOR,
      status: ClinicMembershipStatus.ACTIVE,
    });
    membershipsDb.set(`${clinicAIdStr}_${doctorClinicianBId.toString()}`, {
      _id: new Types.ObjectId(),
      clinicId: clinicAId,
      doctorId: doctorClinicianBId,
      role: ClinicRole.DOCTOR,
      status: ClinicMembershipStatus.ACTIVE,
    });
    membershipsDb.set(`${clinicAIdStr}_${doctorStaffId.toString()}`, {
      _id: new Types.ObjectId(),
      clinicId: clinicAId,
      doctorId: doctorStaffId,
      role: ClinicRole.STAFF,
      status: ClinicMembershipStatus.ACTIVE,
    });
    membershipsDb.set(`${clinicBIdStr}_${doctorOutsiderId.toString()}`, {
      _id: new Types.ObjectId(),
      clinicId: clinicBId,
      doctorId: doctorOutsiderId,
      role: ClinicRole.OWNER,
      status: ClinicMembershipStatus.ACTIVE,
    });

    // Issue JWT access tokens
    ownerToken = await tokenService.generateAccessToken({
      _id: doctorOwnerId,
      email: 'owner@cliniqo.test',
      fullName: 'Owner Doctor',
      status: DoctorStatus.ACTIVE,
    });
    clinicianAToken = await tokenService.generateAccessToken({
      _id: doctorClinicianAId,
      email: 'clinician.a@cliniqo.test',
      fullName: 'Nikhil Kanade',
      status: DoctorStatus.ACTIVE,
    });
    clinicianBToken = await tokenService.generateAccessToken({
      _id: doctorClinicianBId,
      email: 'clinician.b@cliniqo.test',
      fullName: 'Sneha Sharma',
      status: DoctorStatus.ACTIVE,
    });
    staffToken = await tokenService.generateAccessToken({
      _id: doctorStaffId,
      email: 'staff@cliniqo.test',
      fullName: 'Frontdesk Staff',
      status: DoctorStatus.ACTIVE,
    });
    outsiderToken = await tokenService.generateAccessToken({
      _id: doctorOutsiderId,
      email: 'outsider@cliniqo.test',
      fullName: 'Outsider Doctor',
      status: DoctorStatus.ACTIVE,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    consultationsDb.clear();
    addendaDb.clear();
    idempotencyDb.clear();
    auditLogsDb.length = 0;

    // Seed patients
    patientsDb.set(patientAIdStr, {
      _id: patientAId,
      clinicId: clinicAId,
      patientId: 'P-00101',
      name: 'Ananya Iyer',
      initials: 'AI',
      age: 34,
      gender: 'FEMALE',
      phone: '9876543210',
      normalizedPhone: '9876543210',
      status: PatientStatus.ACTIVE,
      lastVisitAt: null,
    });

    patientsDb.set(patientBIdStr, {
      _id: patientBId,
      clinicId: clinicBId,
      patientId: 'P-00102',
      name: 'Vikram Mehta',
      initials: 'VM',
      age: 52,
      gender: 'MALE',
      phone: '9820411882',
      normalizedPhone: '9820411882',
      status: PatientStatus.ACTIVE,
      lastVisitAt: null,
    });
  });

  describe('Full Consultation Lifecycle: Draft -> Update -> Finalize -> Addenda', () => {
    it('executes full visit lifecycle, updates Patient.lastVisitAt with $max, and enforces immutability', async () => {
      // 1. Create draft consultation
      const createRes = await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/patients/${patientAIdStr}/consultations`)
        .set('Authorization', `Bearer ${clinicianAToken}`)
        .send({
          consultationDate: '2026-10-25T10:00:00.000Z',
          consultationTime: '10:30',
          chiefComplaint: 'Headache and fatigue',
          vitals: { systolic: 120, diastolic: 80, temperature: 98.6 },
        })
        .expect(201);

      expect(createRes.body.status).toBe(ConsultationStatus.DRAFT);
      expect(createRes.body.patientCode).toBe('P-00101');
      expect(createRes.body.version).toBe(1);
      const consultationId = createRes.body._id;

      // 2. Update draft consultation (notes, provisional medicines) with expectedVersion: 1
      const updateRes = await request(app.getHttpServer())
        .patch(`/clinics/${clinicAIdStr}/consultations/${consultationId}`)
        .set('Authorization', `Bearer ${clinicianAToken}`)
        .send({
          expectedVersion: 1,
          diagnosis: 'Tension headache',
          provisionalMedicines: [
            { name: 'Paracetamol', formulation: 'Tablet', strength: '500 mg', dose: '1 tab' },
          ],
        })
        .expect(200);

      expect(updateRes.body.version).toBe(2);
      expect(updateRes.body.diagnosis).toBe('Tension headache');

      // 3. Finalize consultation with expectedVersion: 2
      const finalizeRes = await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/consultations/${consultationId}/finalize`)
        .set('Authorization', `Bearer ${clinicianAToken}`)
        .send({
          expectedVersion: 2,
          chiefComplaint: 'Headache and fatigue',
          diagnosis: 'Tension headache',
        })
        .expect(200);

      expect(finalizeRes.body.status).toBe(ConsultationStatus.FINALIZED);
      expect(finalizeRes.body.version).toBe(3);
      expect(finalizeRes.body.finalizedAt).toBeDefined();

      // Verify Patient.lastVisitAt was updated
      const patientInDb = patientsDb.get(patientAIdStr);
      expect(new Date(patientInDb.lastVisitAt).toISOString()).toBe('2026-10-25T10:00:00.000Z');

      // 4. Attempt to PATCH finalized consultation -> MUST return 409 Conflict
      await request(app.getHttpServer())
        .patch(`/clinics/${clinicAIdStr}/consultations/${consultationId}`)
        .set('Authorization', `Bearer ${clinicianAToken}`)
        .send({
          expectedVersion: 3,
          chiefComplaint: 'Attempting to change finalized',
        })
        .expect(409);

      // 5. Append signed addendum to finalized consultation
      const addendumRes = await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/consultations/${consultationId}/addenda`)
        .set('Authorization', `Bearer ${clinicianAToken}`)
        .send({
          note: 'Patient reported relief 2 hours after dose.',
          reasonForAddendum: 'Follow-up observation phone call',
        })
        .expect(201);

      expect(addendumRes.body.sequenceNumber).toBe(1);
      expect(addendumRes.body.note).toBe('Patient reported relief 2 hours after dose.');

      // 6. Get single consultation by ID -> verifies addenda array populated
      const getRes = await request(app.getHttpServer())
        .get(`/clinics/${clinicAIdStr}/consultations/${consultationId}`)
        .set('Authorization', `Bearer ${clinicianAToken}`)
        .expect(200);

      expect(getRes.body.hasAddenda).toBe(true);
      expect(getRes.body.addenda).toHaveLength(1);
      expect(getRes.body.addenda[0].sequenceNumber).toBe(1);
    });
  });

  describe('Tenant Isolation & Cross-Clinic Security', () => {
    it('returns 404 Not Found when Doctor in Clinic A accesses a consultation in Clinic B', async () => {
      // Create consultation in Clinic B
      const createRes = await request(app.getHttpServer())
        .post(`/clinics/${clinicBIdStr}/patients/${patientBIdStr}/consultations`)
        .set('Authorization', `Bearer ${outsiderToken}`)
        .send({
          chiefComplaint: 'Clinic B visit',
        })
        .expect(201);

      const consultationBId = createRes.body._id;

      // Doctor in Clinic A calls Clinic A route targeting consultationB -> 404
      await request(app.getHttpServer())
        .get(`/clinics/${clinicAIdStr}/consultations/${consultationBId}`)
        .set('Authorization', `Bearer ${clinicianAToken}`)
        .expect(404);

      // Doctor in Clinic A attempts to modify consultationB -> 404
      await request(app.getHttpServer())
        .patch(`/clinics/${clinicAIdStr}/consultations/${consultationBId}`)
        .set('Authorization', `Bearer ${clinicianAToken}`)
        .send({ expectedVersion: 1, chiefComplaint: 'Hack' })
        .expect(404);
    });

    it('returns 400 Bad Request if X-Clinic-ID header conflicts with route clinicId', async () => {
      await request(app.getHttpServer())
        .get(`/clinics/${clinicAIdStr}/consultations/recent`)
        .set('Authorization', `Bearer ${clinicianAToken}`)
        .set('x-clinic-id', clinicBIdStr)
        .expect(400);
    });
  });

  describe('Role-Based Access Control', () => {
    it('allows STAFF to read consultations but forbids creating, editing, finalizing, or adding addenda (403)', async () => {
      // Create draft as clinician
      const createRes = await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/patients/${patientAIdStr}/consultations`)
        .set('Authorization', `Bearer ${clinicianAToken}`)
        .send({ chiefComplaint: 'Eye pain' })
        .expect(201);

      const consultationId = createRes.body._id;

      // Staff can read (200)
      await request(app.getHttpServer())
        .get(`/clinics/${clinicAIdStr}/consultations/${consultationId}`)
        .set('Authorization', `Bearer ${staffToken}`)
        .expect(200);

      // Staff cannot create (403)
      await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/patients/${patientAIdStr}/consultations`)
        .set('Authorization', `Bearer ${staffToken}`)
        .send({ chiefComplaint: 'Staff entry' })
        .expect(403);

      // Staff cannot update (403)
      await request(app.getHttpServer())
        .patch(`/clinics/${clinicAIdStr}/consultations/${consultationId}`)
        .set('Authorization', `Bearer ${staffToken}`)
        .send({ expectedVersion: 1, chiefComplaint: 'Staff edit' })
        .expect(403);

      // Staff cannot finalize (403)
      await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/consultations/${consultationId}/finalize`)
        .set('Authorization', `Bearer ${staffToken}`)
        .send({ expectedVersion: 1, chiefComplaint: 'Eye pain', diagnosis: 'Conjunctivitis' })
        .expect(403);

      // Staff cannot add addenda (403)
      await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/consultations/${consultationId}/addenda`)
        .set('Authorization', `Bearer ${staffToken}`)
        .send({ note: 'Staff note', reasonForAddendum: 'Note' })
        .expect(403);
    });
  });

  describe('Doctor Ownership Checks on Draft Cancellation', () => {
    it('forbids Doctor B from cancelling Doctor A draft (403), allows Doctor A to cancel own draft, and allows Owner to cancel', async () => {
      const createRes = await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/patients/${patientAIdStr}/consultations`)
        .set('Authorization', `Bearer ${clinicianAToken}`)
        .send({ chiefComplaint: 'Stomach ache' })
        .expect(201);

      const consultationId = createRes.body._id;

      // Doctor B attempts to cancel Doctor A draft -> 403 Forbidden
      await request(app.getHttpServer())
        .delete(`/clinics/${clinicAIdStr}/consultations/${consultationId}`)
        .set('Authorization', `Bearer ${clinicianBToken}`)
        .send({ reason: 'Attempted cancellation by different doctor' })
        .expect(403);

      // Doctor A cancels own draft -> 200 OK
      const cancelRes = await request(app.getHttpServer())
        .delete(`/clinics/${clinicAIdStr}/consultations/${consultationId}`)
        .set('Authorization', `Bearer ${clinicianAToken}`)
        .send({ reason: 'Patient left clinic before consultation' })
        .expect(200);

      expect(cancelRes.body.message).toContain('successfully cancelled');

      // Verify audit log
      const cancelAudit = auditLogsDb.find(
        (l) => l.action === ClinicAuditAction.CONSULTATION_CANCELLED,
      );
      expect(cancelAudit).toBeDefined();
      expect(cancelAudit.actorDoctorId.toString()).toBe(doctorClinicianAId.toString());

      // Owner can cancel Doctor A draft
      const createRes2 = await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/patients/${patientAIdStr}/consultations`)
        .set('Authorization', `Bearer ${clinicianAToken}`)
        .send({ chiefComplaint: 'Headache' })
        .expect(201);

      await request(app.getHttpServer())
        .delete(`/clinics/${clinicAIdStr}/consultations/${createRes2.body._id}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ reason: 'Clinic owner administrative cancellation' })
        .expect(200);
    });
  });

  describe('Persistent Idempotency & Crash Recovery', () => {
    it('crash-after-commit: replays cached response for identical Idempotency-Key with zero duplicate writes', async () => {
      const key = 'idem-e2e-crash-recovery-key';

      // First request succeeds
      const res1 = await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/patients/${patientAIdStr}/consultations`)
        .set('Authorization', `Bearer ${clinicianAToken}`)
        .set('Idempotency-Key', key)
        .send({
          chiefComplaint: 'Ear infection',
        })
        .expect(201);

      const firstConsultationId = res1.body._id;

      // Simulated network retry with identical payload
      const res2 = await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/patients/${patientAIdStr}/consultations`)
        .set('Authorization', `Bearer ${clinicianAToken}`)
        .set('Idempotency-Key', key)
        .send({
          chiefComplaint: 'Ear infection',
        })
        .expect(201);

      expect(res2.body._id).toBe(firstConsultationId);

      // Assert database has strictly 1 consultation and 1 audit log
      const count = Array.from(consultationsDb.values()).filter(
        (c) => c.patientId.toString() === patientAIdStr,
      ).length;
      expect(count).toBe(1);

      const auditCount = auditLogsDb.filter(
        (l) => l.action === ClinicAuditAction.CONSULTATION_CREATED,
      ).length;
      expect(auditCount).toBe(1);
    });

    it('rejects duplicate active draft creation for same patient without idempotency key (409 Conflict with active ID)', async () => {
      // Create first draft
      const res1 = await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/patients/${patientAIdStr}/consultations`)
        .set('Authorization', `Bearer ${clinicianAToken}`)
        .send({ chiefComplaint: 'Knee sprain' })
        .expect(201);

      const activeDraftId = res1.body._id;

      // Attempt to create second draft for same patient
      const res2 = await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/patients/${patientAIdStr}/consultations`)
        .set('Authorization', `Bearer ${clinicianAToken}`)
        .send({ chiefComplaint: 'Second conflicting draft' })
        .expect(409);

      expect(res2.body.message).toContain('active consultation draft already exists');
      expect(res2.body.existingConsultationId).toBe(activeDraftId);
    });

    it('enforces lease-expiry fencing: aborts transaction and produces zero surviving writes if worker lease expired before commit', async () => {
      const key = 'idem-e2e-fencing-key';

      // Simulate worker lease expiry while inside the transaction
      const origCreate = mockConsultationModel.create.getMockImplementation();
      mockConsultationModel.create.mockImplementationOnce(async (docs: any, opts: any) => {
        if (!origCreate) {
          throw new Error('origCreate is not defined on mockConsultationModel.create');
        }
        const result = await origCreate(docs, opts);
        // Worker lease expires while executing transaction
        const recordKey = `${clinicAIdStr}_${key}`;
        const record = idempotencyDb.get(recordKey);
        if (record) {
          record.lockedUntil = new Date(Date.now() - 5000); // Expired 5 seconds ago
        }
        return result;
      });

      const res = await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/patients/${patientAIdStr}/consultations`)
        .set('Authorization', `Bearer ${clinicianAToken}`)
        .set('Idempotency-Key', key)
        .send({ chiefComplaint: 'Severe migraine during long procedure' })
        .expect(409);

      expect(res.body.message).toContain('Idempotency lease expired or was revoked');

      // Assert transaction rolled back: strictly zero surviving consultations or audit logs
      const consultationCount = Array.from(consultationsDb.values()).filter(
        (c) => c.patientId.toString() === patientAIdStr,
      ).length;
      expect(consultationCount).toBe(0);

      const auditCount = auditLogsDb.filter(
        (l) => l.action === ClinicAuditAction.CONSULTATION_CREATED,
      ).length;
      expect(auditCount).toBe(0);
    });

    it('recovers from transaction abort: marks record FAILED with zero surviving writes, and permits successful retry', async () => {
      const key = 'idem-e2e-abort-recovery-key';
      const payload = { chiefComplaint: 'Chest tightness on exertion' };

      // Step 1: Initial attempt experiences transaction abort (simulated audit write failure)
      mockAuditLogModel.create.mockImplementationOnce(() => {
        throw new Error('Simulated transient database connection drop during audit log write');
      });

      await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/patients/${patientAIdStr}/consultations`)
        .set('Authorization', `Bearer ${clinicianAToken}`)
        .set('Idempotency-Key', key)
        .send(payload)
        .expect(500);

      // Verify transaction aborted and rollback occurred: zero surviving consultations and zero audit logs
      const survivingConsultations = Array.from(consultationsDb.values()).filter(
        (c) => c.patientId.toString() === patientAIdStr,
      ).length;
      expect(survivingConsultations).toBe(0);

      const survivingAuditLogs = auditLogsDb.filter(
        (l) => l.action === ClinicAuditAction.CONSULTATION_CREATED,
      ).length;
      expect(survivingAuditLogs).toBe(0);

      // Verify idempotency record was transitioned to FAILED outside the aborted transaction
      const recordKey = `${clinicAIdStr}_${key}`;
      const record = idempotencyDb.get(recordKey);
      expect(record).toBeDefined();
      expect(record.status).toBe('FAILED');
      expect(record.lockedUntil).toBeNull();

      // Step 2: Retry with identical payload and same Idempotency-Key
      const retryRes = await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/patients/${patientAIdStr}/consultations`)
        .set('Authorization', `Bearer ${clinicianAToken}`)
        .set('Idempotency-Key', key)
        .send(payload)
        .expect(201);

      expect(retryRes.body.chiefComplaint).toBe('Chest tightness on exertion');

      // Verify exactly 1 consultation and 1 audit log committed
      const finalConsultations = Array.from(consultationsDb.values()).filter(
        (c) => c.patientId.toString() === patientAIdStr,
      ).length;
      expect(finalConsultations).toBe(1);

      const finalAuditLogs = auditLogsDb.filter(
        (l) => l.action === ClinicAuditAction.CONSULTATION_CREATED,
      ).length;
      expect(finalAuditLogs).toBe(1);

      // Verify idempotency record transitioned to COMPLETED
      const finalRecord = idempotencyDb.get(recordKey);
      expect(finalRecord.status).toBe('COMPLETED');
      expect(finalRecord.lockedUntil).toBeNull();
      expect(finalRecord.responseCode).toBe(201);
      expect(finalRecord.responseBody._id.toString()).toBe(retryRes.body._id);
    });
  });

  describe('Non-Backward Moving Patient.lastVisitAt ($max Invariant)', () => {
    it('leaves Patient.lastVisitAt untouched when a retroactive consultation is finalized', async () => {
      // 1. Create and finalize visit on Oct 20
      const res1 = await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/patients/${patientAIdStr}/consultations`)
        .set('Authorization', `Bearer ${clinicianAToken}`)
        .send({
          consultationDate: '2026-10-20T10:00:00.000Z',
          chiefComplaint: 'Recent visit',
        })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/consultations/${res1.body._id}/finalize`)
        .set('Authorization', `Bearer ${clinicianAToken}`)
        .send({
          expectedVersion: 1,
          chiefComplaint: 'Recent visit',
          diagnosis: 'Healthy',
        })
        .expect(200);

      expect(
        new Date(patientsDb.get(patientAIdStr).lastVisitAt).toISOString(),
      ).toBe('2026-10-20T10:00:00.000Z');

      // 2. Create and finalize retroactive visit on Oct 15
      const res2 = await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/patients/${patientAIdStr}/consultations`)
        .set('Authorization', `Bearer ${clinicianAToken}`)
        .send({
          consultationDate: '2026-10-15T09:00:00.000Z',
          chiefComplaint: 'Past visit',
        })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/consultations/${res2.body._id}/finalize`)
        .set('Authorization', `Bearer ${clinicianAToken}`)
        .send({
          expectedVersion: 1,
          chiefComplaint: 'Past visit',
          diagnosis: 'Follow-up',
        })
        .expect(200);

      // Invariant: Patient.lastVisitAt remains Oct 20 (does NOT move backward)
      expect(
        new Date(patientsDb.get(patientAIdStr).lastVisitAt).toISOString(),
      ).toBe('2026-10-20T10:00:00.000Z');
    });
  });
});
