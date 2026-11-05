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
import { Patient } from '../src/patient/schemas/patient.schema.js';
import { ClinicSequenceCounter } from '../src/patient/schemas/clinic-sequence-counter.schema.js';

describe('Patient Domain: Registration, Sequences, Demographics, Isolation & Concurrency (e2e)', () => {
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

  // In-memory collections
  const doctorsDb = new Map<string, any>();
  const clinicsDb = new Map<string, any>();
  const membershipsDb = new Map<string, any>();
  const patientsDb = new Map<string, any>();
  const countersDb = new Map<string, any>();
  const auditLogsDb: any[] = [];

  // Test Doctors
  const doctorOwnerId = new Types.ObjectId('672aa0000000000000000001');
  const doctorClinicianId = new Types.ObjectId('672aa0000000000000000002');
  const doctorStaffId = new Types.ObjectId('672aa0000000000000000003');
  const doctorOutsiderId = new Types.ObjectId('672aa0000000000000000004');

  let ownerToken: string;
  let clinicianToken: string;
  let staffToken: string;
  let outsiderToken: string;

  // Test Clinics
  const clinicAId = new Types.ObjectId('672bb0000000000000000001');
  const clinicBId = new Types.ObjectId('672bb0000000000000000002');
  const clinicAIdStr = clinicAId.toString();
  const clinicBIdStr = clinicBId.toString();

  let sessionSnapshot: {
    patients: Map<string, any>;
    counters: Map<string, any>;
    auditLogs: any[];
  } | null = null;

  const mockSession: any = {
    startTransaction: vi.fn().mockImplementation(() => {
      sessionSnapshot = {
        patients: new Map(
          Array.from(patientsDb.entries()).map(([k, v]) => [k, { ...v }]),
        ),
        counters: new Map(
          Array.from(countersDb.entries()).map(([k, v]) => [k, { ...v }]),
        ),
        auditLogs: auditLogsDb.map((l) => ({ ...l })),
      };
    }),
    commitTransaction: vi.fn().mockImplementation(() => {
      sessionSnapshot = null;
    }),
    abortTransaction: vi.fn().mockImplementation(() => {
      if (sessionSnapshot) {
        patientsDb.clear();
        for (const [k, v] of sessionSnapshot.patients.entries()) {
          patientsDb.set(k, v);
        }
        countersDb.clear();
        for (const [k, v] of sessionSnapshot.counters.entries()) {
          countersDb.set(k, v);
        }
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
      lean: vi.fn().mockReturnThis(),
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

  const mockCounterModel = {
    findOneAndUpdate: vi.fn().mockImplementation((filter, _updatePipeline, _options) => {
      const key = `${filter.clinicId.toString()}_${filter.sequenceName}`;
      let counter = countersDb.get(key);

      if (!counter) {
        counter = {
          clinicId: filter.clinicId,
          sequenceName: filter.sequenceName,
          seq: 101, // Aggregation pipeline starts with 101
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      } else {
        counter.seq += 1;
        counter.updatedAt = new Date();
      }

      countersDb.set(key, { ...counter });
      return createQueryMock({ ...counter });
    }),
  };

  const mockPatientModel = {
    create: vi.fn().mockImplementation((docs) => {
      const created = docs.map((d: any) => {
        const doc = {
          _id: d._id || new Types.ObjectId(),
          ...d,
          createdAt: new Date(),
          updatedAt: new Date(),
          save: vi.fn().mockImplementation(function (this: any) {
            patientsDb.set(this._id.toString(), { ...this });
            return Promise.resolve(this);
          }),
          toObject: function (this: any) {
            const { save: _, toObject: __, ...rest } = this;
            return rest;
          },
        };
        patientsDb.set(doc._id.toString(), doc);
        return doc;
      });
      return Promise.resolve(created);
    }),
    find: vi.fn().mockImplementation((filter) => {
      const results: any[] = [];
      for (const p of patientsDb.values()) {
        const clinicMatch =
          !filter.clinicId || p.clinicId.toString() === filter.clinicId.toString();
        const statusMatch = !filter.status || p.status === filter.status;
        const genderMatch = !filter.gender || p.gender === filter.gender;

        let queryMatch = true;
        if (filter.$or && Array.isArray(filter.$or)) {
          queryMatch = filter.$or.some((cond: any) => {
            if (cond.name && cond.name instanceof RegExp) {
              return cond.name.test(p.name);
            }
            if (cond.patientId && cond.patientId instanceof RegExp) {
              return cond.patientId.test(p.patientId);
            }
            if (cond.normalizedPhone && cond.normalizedPhone instanceof RegExp) {
              return cond.normalizedPhone.test(p.normalizedPhone);
            }
            return false;
          });
        }

        const phoneMatch =
          !filter.normalizedPhone || p.normalizedPhone === filter.normalizedPhone;

        if (clinicMatch && statusMatch && genderMatch && queryMatch && phoneMatch) {
          results.push(p);
        }
      }
      return createQueryMock(results);
    }),
    findOne: vi.fn().mockImplementation((filter) => {
      for (const p of patientsDb.values()) {
        const clinicMatch =
          !filter.clinicId || p.clinicId.toString() === filter.clinicId.toString();
        const statusMatch = !filter.status || p.status === filter.status;

        let idMatch = true;
        if (filter.patientId) {
          idMatch = p.patientId === filter.patientId;
        } else if (filter._id) {
          idMatch = p._id.toString() === filter._id.toString();
        } else if (filter.$or) {
          idMatch = filter.$or.some(
            (cond: any) =>
              (cond._id && p._id.toString() === cond._id.toString()) ||
              (cond.patientId && p.patientId === cond.patientId),
          );
        }

        if (clinicMatch && statusMatch && idMatch) {
          return createQueryMock(p);
        }
      }
      return createQueryMock(null);
    }),
    findOneAndUpdate: vi.fn().mockImplementation((filter, update) => {
      for (const p of patientsDb.values()) {
        const idMatch = !filter._id || p._id.toString() === filter._id.toString();
        if (idMatch) {
          if (update.$set) {
            Object.assign(p, update.$set);
          }
          if (update.$inc) {
            for (const [k, v] of Object.entries(update.$inc)) {
              p[k] = (p[k] || 0) + (v as number);
            }
          }
          p.updatedAt = new Date();
          return createQueryMock(p);
        }
      }
      return createQueryMock(null);
    }),
    countDocuments: vi.fn().mockImplementation((filter) => {
      let count = 0;
      for (const p of patientsDb.values()) {
        const clinicMatch =
          !filter.clinicId || p.clinicId.toString() === filter.clinicId.toString();
        const statusMatch = !filter.status || p.status === filter.status;
        if (clinicMatch && statusMatch) count++;
      }
      return createQueryMock(count);
    }),
  };

  const mockAuditLogModel = {
    create: vi.fn().mockImplementation((docs) => {
      const created = docs.map((d: any) => {
        const entry = {
          _id: new Types.ObjectId(),
          ...d,
          timestamp: new Date(),
        };
        auditLogsDb.push(entry);
        return entry;
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
    [ClinicAuditLog.name]: mockAuditLogModel,
    [ClinicInvitation.name]: { findOne: vi.fn(), create: vi.fn() },
    [InvitationOutbox.name]: { create: vi.fn(), findOneAndUpdate: vi.fn() },
    [RefreshSession.name]: { create: vi.fn(), findOne: vi.fn(), updateMany: vi.fn() },
    [PasswordResetToken.name]: { create: vi.fn(), findOne: vi.fn() },
    [RateLimit.name]: { findOneAndUpdate: vi.fn(), updateOne: vi.fn() },
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
      { provide: getModelToken(Patient.name), useValue: mockPatientModel },
      { provide: getModelToken(ClinicSequenceCounter.name), useValue: mockCounterModel },
      { provide: getModelToken(ClinicAuditLog.name), useValue: mockAuditLogModel },
      { provide: getModelToken(ClinicInvitation.name), useValue: mockModels[ClinicInvitation.name] },
      { provide: getModelToken(InvitationOutbox.name), useValue: mockModels[InvitationOutbox.name] },
      { provide: getModelToken(RefreshSession.name), useValue: mockModels[RefreshSession.name] },
      { provide: getModelToken(PasswordResetToken.name), useValue: mockModels[PasswordResetToken.name] },
      { provide: getModelToken(RateLimit.name), useValue: mockModels[RateLimit.name] },
    ],
    exports: [
      getConnectionToken(),
      getModelToken(Doctor.name),
      getModelToken(Clinic.name),
      getModelToken(ClinicMembership.name),
      getModelToken(Patient.name),
      getModelToken(ClinicSequenceCounter.name),
      getModelToken(ClinicAuditLog.name),
      getModelToken(ClinicInvitation.name),
      getModelToken(InvitationOutbox.name),
      getModelToken(RefreshSession.name),
      getModelToken(PasswordResetToken.name),
      getModelToken(RateLimit.name),
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
      .useValue({ sendMail: vi.fn().mockResolvedValue(true) })
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

    tokenService = app.get(TokenService);

    // Setup Test Doctors
    doctorsDb.set(doctorOwnerId.toString(), {
      _id: doctorOwnerId,
      email: 'owner@clinic.com',
      status: DoctorStatus.ACTIVE,
      isEmailVerified: true,
      firstName: 'Owner',
      lastName: 'Doc',
    });

    doctorsDb.set(doctorClinicianId.toString(), {
      _id: doctorClinicianId,
      email: 'clinician@clinic.com',
      status: DoctorStatus.ACTIVE,
      isEmailVerified: true,
      firstName: 'Clinician',
      lastName: 'Doc',
    });

    doctorsDb.set(doctorStaffId.toString(), {
      _id: doctorStaffId,
      email: 'staff@clinic.com',
      status: DoctorStatus.ACTIVE,
      isEmailVerified: true,
      firstName: 'Staff',
      lastName: 'User',
    });

    doctorsDb.set(doctorOutsiderId.toString(), {
      _id: doctorOutsiderId,
      email: 'outsider@other.com',
      status: DoctorStatus.ACTIVE,
      isEmailVerified: true,
      firstName: 'Outsider',
      lastName: 'Doc',
    });

    // Generate JWT access tokens
    ownerToken = await tokenService.generateAccessToken({
      _id: doctorOwnerId,
      email: 'owner@clinic.com',
      fullName: 'Owner Doc',
      status: DoctorStatus.ACTIVE,
    });

    clinicianToken = await tokenService.generateAccessToken({
      _id: doctorClinicianId,
      email: 'clinician@clinic.com',
      fullName: 'Clinician Doc',
      status: DoctorStatus.ACTIVE,
    });

    staffToken = await tokenService.generateAccessToken({
      _id: doctorStaffId,
      email: 'staff@clinic.com',
      fullName: 'Staff User',
      status: DoctorStatus.ACTIVE,
    });

    outsiderToken = await tokenService.generateAccessToken({
      _id: doctorOutsiderId,
      email: 'outsider@other.com',
      fullName: 'Outsider Doc',
      status: DoctorStatus.ACTIVE,
    });

    // Setup Clinics
    clinicsDb.set(clinicAId.toString(), {
      _id: clinicAId,
      name: 'Alpha Health Center',
      slug: 'alpha-health',
      status: ClinicStatus.ACTIVE,
      ownerDoctorId: doctorOwnerId,
    });

    clinicsDb.set(clinicBId.toString(), {
      _id: clinicBId,
      name: 'Beta Medical Clinic',
      slug: 'beta-medical',
      status: ClinicStatus.ACTIVE,
      ownerDoctorId: doctorOwnerId,
    });

    // Setup Memberships for Clinic A
    membershipsDb.set(`${clinicAIdStr}_${doctorOwnerId.toString()}`, {
      _id: new Types.ObjectId(),
      clinicId: clinicAId,
      doctorId: doctorOwnerId,
      role: ClinicRole.OWNER,
      status: ClinicMembershipStatus.ACTIVE,
    });

    membershipsDb.set(`${clinicAIdStr}_${doctorClinicianId.toString()}`, {
      _id: new Types.ObjectId(),
      clinicId: clinicAId,
      doctorId: doctorClinicianId,
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

    // Outsider is ONLY a member of Clinic B, not Clinic A
    membershipsDb.set(`${clinicBIdStr}_${doctorOutsiderId.toString()}`, {
      _id: new Types.ObjectId(),
      clinicId: clinicBId,
      doctorId: doctorOutsiderId,
      role: ClinicRole.OWNER,
      status: ClinicMembershipStatus.ACTIVE,
    });
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    patientsDb.clear();
    countersDb.clear();
    auditLogsDb.length = 0;
  });

  describe('1. First Registration & Monotonic Sequence Generation (P-00101)', () => {
    it('creates first patient with sequence starting at exactly P-00101', async () => {
      const payload = {
        name: 'Aarav Sharma',
        age: 32,
        gender: 'MALE',
        phone: '+91 98765 43210',
        allergies: ['Amoxicillin'],
        conditions: ['Hypertension'],
      };

      const res = await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/patients`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.body.patientId).toBe('P-00101');
      expect(res.body.name).toBe('Aarav Sharma');
      expect(res.body.initials).toBe('AS');
      expect(res.body.normalizedPhone).toBe('9876543210');
      expect(res.body.version).toBe(1);
      expect(res.body.status).toBe('ACTIVE');

      // Verify audit log
      const audit = auditLogsDb.find(
        (l) => l.action === ClinicAuditAction.PATIENT_CREATED,
      );
      expect(audit).toBeDefined();
      expect(audit.metadata.patientId).toBe('P-00101');
      expect(audit.actorDoctorId.toString()).toBe(doctorOwnerId.toString());
    });
  });

  describe('2. Concurrent First Registrations on Fresh Clinic', () => {
    it('generates strictly unique, ordered sequence IDs under concurrent requests with zero collisions', async () => {
      const registrationPayloads = [
        { name: 'Patient One', age: 25, gender: 'MALE', phone: '9876500001' },
        { name: 'Patient Two', age: 26, gender: 'FEMALE', phone: '9876500002' },
        { name: 'Patient Three', age: 27, gender: 'OTHER', phone: '9876500003' },
        { name: 'Patient Four', age: 28, gender: 'FEMALE', phone: '9876500004' },
        { name: 'Patient Five', age: 29, gender: 'MALE', phone: '9876500005' },
      ];

      const responses = await Promise.all(
        registrationPayloads.map((body) =>
          request(app.getHttpServer())
            .post(`/clinics/${clinicAIdStr}/patients`)
            .set('Authorization', `Bearer ${ownerToken}`)
            .send(body),
        ),
      );

      for (const res of responses) {
        expect(res.status).toBe(201);
      }

      const assignedPatientIds = responses
        .map((r) => r.body.patientId)
        .sort((a, b) => a.localeCompare(b));
      expect(assignedPatientIds).toEqual([
        'P-00101',
        'P-00102',
        'P-00103',
        'P-00104',
        'P-00105',
      ]);
    });
  });

  describe('3. Multi-Clinic Independent Sequence Counters', () => {
    it('maintains independent counters so Clinic B starts at P-00101 regardless of Clinic A count', async () => {
      // Register in Clinic A
      const resA = await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/patients`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'Alpha Patient', age: 40, gender: 'MALE', phone: '9876511111' });
      expect(resA.status).toBe(201);
      expect(resA.body.patientId).toBe('P-00101');

      // Register second patient in Clinic A
      const resA2 = await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/patients`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'Alpha Patient Two', age: 41, gender: 'FEMALE', phone: '9876511112' });
      expect(resA2.status).toBe(201);
      expect(resA2.body.patientId).toBe('P-00102');

      // Register first patient in Clinic B (outsider is owner of clinic B)
      const resB = await request(app.getHttpServer())
        .post(`/clinics/${clinicBIdStr}/patients`)
        .set('Authorization', `Bearer ${outsiderToken}`)
        .send({ name: 'Beta Patient One', age: 30, gender: 'MALE', phone: '9876522221' });
      expect(resB.status).toBe(201);
      expect(resB.body.patientId).toBe('P-00101'); // Completely fresh counter for Clinic B!
    });
  });

  describe('4. Strict Server-Side Clinic Isolation & Cross-Tenant Defense', () => {
    it('blocks outsider doctor from querying or modifying Clinic A patients', async () => {
      // Register patient in Clinic A
      const reg = await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/patients`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'Secret Patient', age: 50, gender: 'MALE', phone: '9876599999' });
      expect(reg.status).toBe(201);
      const patientId = reg.body.patientId;

      // Outsider attempts to read Clinic A patient
      const getRes = await request(app.getHttpServer())
        .get(`/clinics/${clinicAIdStr}/patients/${patientId}`)
        .set('Authorization', `Bearer ${outsiderToken}`);
      expect(getRes.status).toBe(403); // Forbidden: not a member of Clinic A

      // Outsider attempts to update Clinic A patient
      const patchRes = await request(app.getHttpServer())
        .patch(`/clinics/${clinicAIdStr}/patients/${patientId}`)
        .set('Authorization', `Bearer ${outsiderToken}`)
        .send({ name: 'Hacked Name' });
      expect(patchRes.status).toBe(403);

      // Outsider attempts to archive Clinic A patient
      const delRes = await request(app.getHttpServer())
        .delete(`/clinics/${clinicAIdStr}/patients/${patientId}`)
        .set('Authorization', `Bearer ${outsiderToken}`);
      expect(delRes.status).toBe(403);
    });

    it('returns 404 when an authenticated doctor authorized for Clinic A requests a Clinic B patient via Clinic A route', async () => {
      // Register a patient in Clinic B
      const regB = await request(app.getHttpServer())
        .post(`/clinics/${clinicBIdStr}/patients`)
        .set('Authorization', `Bearer ${outsiderToken}`)
        .send({ name: 'Clinic B Patient', age: 33, gender: 'FEMALE', phone: '9876512340' });
      expect(regB.status).toBe(201);
      const foreignPatientId = regB.body.patientId;

      // Doctor authorized for Clinic A queries foreign patient via Clinic A's route
      const getRes = await request(app.getHttpServer())
        .get(`/clinics/${clinicAIdStr}/patients/${foreignPatientId}`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(getRes.status).toBe(404);
      expect(getRes.body.message).toBe('Patient not found in this clinic');

      // Update attempt via Clinic A route also returns 404
      const patchRes = await request(app.getHttpServer())
        .patch(`/clinics/${clinicAIdStr}/patients/${foreignPatientId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'Tampered Name' });

      expect(patchRes.status).toBe(404);
      expect(patchRes.body.message).toBe('Patient not found in this clinic');
    });
  });

  describe('5. Role-Based Permissions (OWNER, DOCTOR, STAFF)', () => {
    it('allows STAFF to create and read patients but blocks archive', async () => {
      // Staff creates patient
      const createRes = await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/patients`)
        .set('Authorization', `Bearer ${staffToken}`)
        .send({ name: 'Staff Patient', age: 22, gender: 'FEMALE', phone: '9876533333' });
      expect(createRes.status).toBe(201);
      const patientId = createRes.body.patientId;

      // Staff reads patient
      const readRes = await request(app.getHttpServer())
        .get(`/clinics/${clinicAIdStr}/patients/${patientId}`)
        .set('Authorization', `Bearer ${staffToken}`);
      expect(readRes.status).toBe(200);

      // Staff attempts to archive patient -> 403 Forbidden
      const archiveRes = await request(app.getHttpServer())
        .delete(`/clinics/${clinicAIdStr}/patients/${patientId}`)
        .set('Authorization', `Bearer ${staffToken}`);
      expect(archiveRes.status).toBe(403);
    });

    it('allows OWNER to archive patient', async () => {
      const reg = await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/patients`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'To Be Archived', age: 60, gender: 'MALE', phone: '9876544444' });
      const patientId = reg.body.patientId;

      const delRes = await request(app.getHttpServer())
        .delete(`/clinics/${clinicAIdStr}/patients/${patientId}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(delRes.status).toBe(200);
      expect(delRes.body.success).toBe(true);

      // Verify audit log
      const audit = auditLogsDb.find(
        (l) => l.action === ClinicAuditAction.PATIENT_ARCHIVED,
      );
      expect(audit).toBeDefined();
      expect(audit.metadata.patientId).toBe(patientId);
    });
  });

  describe('6. Duplicate Mobile Pre-Flight Check', () => {
    it('returns exists: true when phone number matches active patient', async () => {
      await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/patients`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'Duplicate Target', age: 34, gender: 'FEMALE', phone: '9876555555' });

      const checkRes = await request(app.getHttpServer())
        .get(`/clinics/${clinicAIdStr}/patients/check-duplicate?phone=+91-98765-55555`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(checkRes.status).toBe(200);
      expect(checkRes.body.exists).toBe(true);
      expect(checkRes.body.matches).toHaveLength(1);
      expect(checkRes.body.matches[0].name).toBe('Duplicate Target');
    });

    it('returns exists: false for unregistered mobile number', async () => {
      const checkRes = await request(app.getHttpServer())
        .get(`/clinics/${clinicAIdStr}/patients/check-duplicate?phone=9123456780`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(checkRes.status).toBe(200);
      expect(checkRes.body.exists).toBe(false);
      expect(checkRes.body.matches).toHaveLength(0);
    });
  });

  describe('7. Allergy Warning & Medical Notes', () => {
    it('sets hasAllergyWarning: true when allergies are documented', async () => {
      const reg = await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/patients`)
        .set('Authorization', `Bearer ${clinicianToken}`)
        .send({
          name: 'Allergy Patient',
          age: 45,
          gender: 'MALE',
          phone: '9876566666',
          allergies: ['Penicillin', 'Aspirin'],
        });
      expect(reg.status).toBe(201);
      const patientId = reg.body.patientId;

      const getRes = await request(app.getHttpServer())
        .get(`/clinics/${clinicAIdStr}/patients/${patientId}`)
        .set('Authorization', `Bearer ${clinicianToken}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.hasAllergyWarning).toBe(true);
      expect(getRes.body.allergies).toEqual(['Penicillin', 'Aspirin']);
    });
  });

  describe('8. Directory Search, Filtering & Pagination', () => {
    beforeEach(async () => {
      await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/patients`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'Rohan Verma', age: 30, gender: 'MALE', phone: '9876577771' });

      await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/patients`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'Sneha Patel', age: 28, gender: 'FEMALE', phone: '9876577772' });
    });

    it('filters directory by search query and gender', async () => {
      const res = await request(app.getHttpServer())
        .get(`/clinics/${clinicAIdStr}/patients?query=Sneha&gender=FEMALE`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.patients).toHaveLength(1);
      expect(res.body.patients[0].name).toBe('Sneha Patel');
      expect(res.body.page).toBe(1);
      expect(res.body.limit).toBe(20);
    });
  });

  describe('9. Patient Update & Version Increment', () => {
    it('increments version and updates audit log on patient modification', async () => {
      const reg = await request(app.getHttpServer())
        .post(`/clinics/${clinicAIdStr}/patients`)
        .set('Authorization', `Bearer ${clinicianToken}`)
        .send({ name: 'Original Name', age: 50, gender: 'MALE', phone: '9876588888' });
      const patientId = reg.body.patientId;

      const patchRes = await request(app.getHttpServer())
        .patch(`/clinics/${clinicAIdStr}/patients/${patientId}`)
        .set('Authorization', `Bearer ${clinicianToken}`)
        .send({ name: 'Updated Full Name', age: 51 });

      expect(patchRes.status).toBe(200);
      expect(patchRes.body.version).toBe(2);
      expect(patchRes.body.name).toBe('Updated Full Name');
      expect(patchRes.body.initials).toBe('UN');

      // Verify audit log
      const audit = auditLogsDb.find(
        (l) => l.action === ClinicAuditAction.PATIENT_UPDATED,
      );
      expect(audit).toBeDefined();
      expect(audit.metadata.patientId).toBe(patientId);
    });
  });
});
