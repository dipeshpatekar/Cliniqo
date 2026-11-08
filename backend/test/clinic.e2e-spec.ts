import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest"
import { Test, TestingModule } from "@nestjs/testing"
import {
  INestApplication,
  ValidationPipe,
  Global,
  Module,
} from "@nestjs/common"
import { getConnectionToken, getModelToken } from "@nestjs/mongoose"
import request from "supertest"
import { Types } from "mongoose"
import crypto from "node:crypto"
import { AppModule } from "../src/app.module.js"
import { DatabaseModule } from "../src/database/database.module.js"
import { TokenService } from "../src/auth/token.service.js"
import { MailService } from "../src/auth/mail.service.js"
import { Doctor } from "../src/auth/schemas/doctor.schema.js"
import { DoctorStatus } from "../src/auth/auth.constants.js"
import { Clinic } from "../src/clinic/schemas/clinic.schema.js"
import {
  ClinicMembership,
  ClinicRole,
  ClinicMembershipStatus,
} from "../src/clinic/schemas/clinic-membership.schema.js"
import {
  ClinicInvitation,
  ClinicInvitationStatus,
} from "../src/clinic/schemas/clinic-invitation.schema.js"
import { InvitationOutbox } from "../src/clinic/schemas/invitation-outbox.schema.js"
import {
  ClinicAuditLog,
  ClinicAuditAction,
} from "../src/clinic/schemas/clinic-audit-log.schema.js"
import { RefreshSession } from "../src/auth/schemas/refresh-session.schema.js"
import { PasswordResetToken } from "../src/auth/schemas/password-reset.schema.js"
import { RateLimit } from "../src/auth/schemas/rate-limit.schema.js"

describe("Clinic Tenancy, Isolation & Multi-Document Transactions (e2e)", () => {
  const originalEnv = { ...process.env }

  beforeAll(() => {
    process.env.JWT_ACCESS_SECRET =
      "test-jwt-access-secret-32-chars-long-minimum!"
    process.env.JWT_REFRESH_SECRET =
      "test-jwt-refresh-secret-32-chars-long-minimum!"
    process.env.JWT_ISSUER = "cliniqo-api-test"
    process.env.JWT_AUDIENCE = "cliniqo-client-test"
    process.env.OUTBOX_ENCRYPTION_KEY =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  })

  afterAll(() => {
    process.env = originalEnv
  })

  let app: INestApplication
  let tokenService: TokenService

  // In-memory collections for realistic E2E state simulation
  const clinicsDb = new Map<string, any>()
  const membershipsDb = new Map<string, any>()
  const invitationsDb = new Map<string, any>()
  const outboxDb = new Map<string, any>()
  const auditLogsDb: any[] = []
  const doctorsDb = new Map<string, any>()

  // Test Doctors
  const doctorAId = new Types.ObjectId("671aa0000000000000000001")
  const doctorBId = new Types.ObjectId("671aa0000000000000000002")
  const doctorCId = new Types.ObjectId("671aa0000000000000000003")

  let doctorAToken: string
  let doctorBToken: string
  let doctorCToken: string

  let sessionSnapshot: {
    clinics: Map<string, any>
    memberships: Map<string, any>
    invitations: Map<string, any>
    outbox: Map<string, any>
    auditLogs: any[]
  } | null = null

  const mockSession: any = {
    startTransaction: vi.fn().mockImplementation(() => {
      sessionSnapshot = {
        clinics: new Map(
          Array.from(clinicsDb.entries()).map(([k, v]) => [k, { ...v }]),
        ),
        memberships: new Map(
          Array.from(membershipsDb.entries()).map(([k, v]) => [k, { ...v }]),
        ),
        invitations: new Map(
          Array.from(invitationsDb.entries()).map(([k, v]) => [k, { ...v }]),
        ),
        outbox: new Map(
          Array.from(outboxDb.entries()).map(([k, v]) => [k, { ...v }]),
        ),
        auditLogs: auditLogsDb.map((l) => ({ ...l })),
      }
    }),
    commitTransaction: vi.fn().mockImplementation(() => {
      sessionSnapshot = null
    }),
    abortTransaction: vi.fn().mockImplementation(() => {
      if (sessionSnapshot) {
        clinicsDb.clear()
        for (const [k, v] of sessionSnapshot.clinics.entries()) {
          clinicsDb.set(k, v)
        }
        membershipsDb.clear()
        for (const [k, v] of sessionSnapshot.memberships.entries()) {
          membershipsDb.set(k, v)
        }
        invitationsDb.clear()
        for (const [k, v] of sessionSnapshot.invitations.entries()) {
          invitationsDb.set(k, v)
        }
        outboxDb.clear()
        for (const [k, v] of sessionSnapshot.outbox.entries()) {
          outboxDb.set(k, v)
        }
        auditLogsDb.length = 0
        auditLogsDb.push(...sessionSnapshot.auditLogs)
        sessionSnapshot = null
      }
    }),
    endSession: vi.fn().mockResolvedValue(undefined),
    inTransaction: vi.fn().mockReturnValue(true),
  }

  const createQueryMock = (result: any) => {
    const promise = Promise.resolve(result) as any
    promise.select = vi.fn().mockImplementation(() => createQueryMock(result))
    promise.session = vi.fn().mockImplementation(() => createQueryMock(result))
    promise.populate = vi.fn().mockImplementation(() => createQueryMock(result))
    promise.sort = vi.fn().mockImplementation(() => createQueryMock(result))
    promise.skip = vi.fn().mockImplementation(() => createQueryMock(result))
    promise.limit = vi.fn().mockImplementation(() => createQueryMock(result))
    promise.lean = vi.fn().mockImplementation(() => Promise.resolve(result))
    return promise
  }

  const mockDoctorModel = {
    findById: vi
      .fn()
      .mockImplementation((id) =>
        createQueryMock(doctorsDb.get(id?.toString()) || null),
      ),
    findOne: vi.fn().mockImplementation((query) => {
      if (query.email) {
        const doc = Array.from(doctorsDb.values()).find(
          (d) => d.email.toLowerCase() === query.email.toLowerCase(),
        )
        return createQueryMock(doc || null)
      }
      return createQueryMock(null)
    }),
  }

  const mockClinicModel = {
    findById: vi
      .fn()
      .mockImplementation((id) =>
        createQueryMock(clinicsDb.get(id?.toString()) || null),
      ),
    findOne: vi.fn().mockImplementation((query) => {
      for (const clinic of clinicsDb.values()) {
        if (query.slug && clinic.slug === query.slug) {
          return createQueryMock(clinic)
        }
        if (query._id && clinic._id.toString() === query._id.toString()) {
          if (query.status && clinic.status !== query.status) continue
          return createQueryMock(clinic)
        }
      }
      return createQueryMock(null)
    }),
    create: vi.fn().mockImplementation((docs) => {
      const created = docs.map((d: any) => {
        const doc = {
          _id: d._id || new Types.ObjectId(),
          ...d,
          createdAt: new Date(),
          updatedAt: new Date(),
        }
        clinicsDb.set(doc._id.toString(), doc)
        return doc
      })
      return Promise.resolve(created)
    }),
    findOneAndUpdate: vi.fn().mockImplementation((filter, update) => {
      for (const clinic of clinicsDb.values()) {
        const idMatch =
          !filter._id || clinic._id.toString() === filter._id.toString()
        const ownerMatch =
          !filter.ownerDoctorId ||
          clinic.ownerDoctorId?.toString() === filter.ownerDoctorId.toString()
        let statusMatch = true
        if (filter.status) {
          if (typeof filter.status === "object" && filter.status.$in) {
            statusMatch = filter.status.$in.includes(clinic.status)
          } else {
            statusMatch = clinic.status === filter.status
          }
        }

        if (idMatch && ownerMatch && statusMatch) {
          if (update.$set) {
            Object.assign(clinic, update.$set)
          }
          return createQueryMock(clinic)
        }
      }
      return createQueryMock(null)
    }),
  }

  const mockMembershipModel = {
    findOne: vi.fn().mockImplementation((query) => {
      for (const m of membershipsDb.values()) {
        const clinicMatch =
          !query.clinicId || m.clinicId.toString() === query.clinicId.toString()
        const doctorMatch =
          !query.doctorId || m.doctorId.toString() === query.doctorId.toString()
        const statusMatch = !query.status || m.status === query.status
        const roleMatch = !query.role || m.role === query.role

        if (clinicMatch && doctorMatch && statusMatch && roleMatch) {
          return createQueryMock({
            ...m,
            save: vi.fn().mockImplementation(function () {
              membershipsDb.set(this._id.toString(), this)
              return Promise.resolve(this)
            }),
          })
        }
      }
      return createQueryMock(null)
    }),
    find: vi.fn().mockImplementation((query) => {
      const results: any[] = []
      for (const m of membershipsDb.values()) {
        const clinicMatch =
          !query.clinicId || m.clinicId.toString() === query.clinicId.toString()
        const doctorMatch =
          !query.doctorId || m.doctorId.toString() === query.doctorId.toString()
        const statusMatch = !query.status || m.status === query.status

        if (clinicMatch && doctorMatch && statusMatch) {
          const populatedDoctor = doctorsDb.get(m.doctorId.toString())
          const populatedClinic = clinicsDb.get(m.clinicId.toString())
          results.push({
            ...m,
            doctorId: populatedDoctor || m.doctorId,
            clinicId: populatedClinic || m.clinicId,
          })
        }
      }
      return createQueryMock(results)
    }),
    create: vi.fn().mockImplementation((docs) => {
      const created = docs.map((d: any) => {
        const doc = {
          _id: d._id || new Types.ObjectId(),
          ...d,
          createdAt: new Date(),
          updatedAt: new Date(),
        }
        membershipsDb.set(doc._id.toString(), doc)
        return doc
      })
      return Promise.resolve(created)
    }),
    findOneAndUpdate: vi.fn().mockImplementation((filter, update) => {
      for (const m of membershipsDb.values()) {
        const idMatch =
          !filter._id || m._id.toString() === filter._id.toString()
        const clinicMatch =
          !filter.clinicId ||
          m.clinicId.toString() === filter.clinicId.toString()
        const doctorMatch =
          !filter.doctorId ||
          m.doctorId.toString() === filter.doctorId.toString()
        const roleMatch = !filter.role || m.role === filter.role
        const statusMatch = !filter.status || m.status === filter.status

        if (idMatch && clinicMatch && doctorMatch && roleMatch && statusMatch) {
          if (update.$set) {
            Object.assign(m, update.$set)
          }
          return createQueryMock(m)
        }
      }
      return createQueryMock(null)
    }),
  }

  const mockInvitationModel = {
    findById: vi
      .fn()
      .mockImplementation((id) =>
        createQueryMock(invitationsDb.get(id?.toString()) || null),
      ),
    findOne: vi.fn().mockImplementation((query) => {
      for (const inv of invitationsDb.values()) {
        const tokenMatch =
          !query.invitationTokenHash ||
          inv.invitationTokenHash === query.invitationTokenHash
        const emailMatch =
          !query.inviteeEmail ||
          inv.inviteeEmail.toLowerCase() === query.inviteeEmail.toLowerCase()
        const clinicMatch =
          !query.clinicId ||
          inv.clinicId.toString() === query.clinicId.toString()
        const statusMatch = !query.status || inv.status === query.status

        if (tokenMatch && emailMatch && clinicMatch && statusMatch) {
          return createQueryMock(inv)
        }
      }
      return createQueryMock(null)
    }),
    find: vi.fn().mockImplementation((query) => {
      const results: any[] = []
      for (const inv of invitationsDb.values()) {
        const emailMatch =
          !query.inviteeEmail ||
          inv.inviteeEmail.toLowerCase() === query.inviteeEmail.toLowerCase()
        const statusMatch = !query.status || inv.status === query.status
        if (emailMatch && statusMatch) {
          const populatedClinic = clinicsDb.get(inv.clinicId.toString())
          const populatedDoctor = doctorsDb.get(inv.invitedBy.toString())
          results.push({
            ...inv,
            clinicId: populatedClinic,
            invitedBy: populatedDoctor,
          })
        }
      }
      return createQueryMock(results)
    }),
    create: vi.fn().mockImplementation((docs) => {
      const created = docs.map((d: any) => {
        const doc = {
          _id: d._id || new Types.ObjectId(),
          ...d,
          createdAt: new Date(),
          updatedAt: new Date(),
        }
        invitationsDb.set(doc._id.toString(), doc)
        return doc
      })
      return Promise.resolve(created)
    }),
    findOneAndUpdate: vi.fn().mockImplementation((filter, update) => {
      for (const inv of invitationsDb.values()) {
        const idMatch =
          !filter._id || inv._id.toString() === filter._id.toString()
        const tokenMatch =
          !filter.invitationTokenHash ||
          inv.invitationTokenHash === filter.invitationTokenHash
        const statusMatch = !filter.status || inv.status === filter.status

        if ((idMatch || tokenMatch) && statusMatch) {
          if (update.$set) {
            Object.assign(inv, update.$set)
          }
          return createQueryMock(inv)
        }
      }
      return createQueryMock(null)
    }),
    updateMany: vi.fn().mockImplementation((filter, update) => {
      let count = 0
      for (const inv of invitationsDb.values()) {
        if (
          filter.clinicId &&
          inv.clinicId.toString() === filter.clinicId.toString()
        ) {
          if (filter.status && inv.status === filter.status) {
            if (update.$set) Object.assign(inv, update.$set)
            count++
          }
        }
      }
      return Promise.resolve({ modifiedCount: count })
    }),
  }

  const mockOutboxModel = {
    create: vi.fn().mockImplementation((docs) => {
      const created = docs.map((d: any) => {
        const doc = {
          _id: d._id || new Types.ObjectId(),
          ...d,
          createdAt: new Date(),
          updatedAt: new Date(),
        }
        outboxDb.set(doc._id.toString(), doc)
        return doc
      })
      return Promise.resolve(created)
    }),
    findOneAndUpdate: vi.fn().mockImplementation((filter, update) => {
      for (const job of outboxDb.values()) {
        if (!filter._id || job._id.toString() === filter._id.toString()) {
          if (update.$set) Object.assign(job, update.$set)
          return createQueryMock(job)
        }
      }
      return createQueryMock(null)
    }),
    updateMany: vi.fn().mockImplementation((filter, update) => {
      let count = 0
      for (const job of outboxDb.values()) {
        if (
          filter.clinicId &&
          job.clinicId.toString() === filter.clinicId.toString()
        ) {
          if (update.$set) Object.assign(job, update.$set)
          count++
        }
      }
      return Promise.resolve({ modifiedCount: count })
    }),
    updateOne: vi.fn().mockResolvedValue({ acknowledged: true }),
    exists: vi.fn().mockResolvedValue(true),
  }

  const mockAuditLogModel = {
    create: vi.fn().mockImplementation((docs) => {
      const created = docs.map((d: any) => {
        const doc = {
          _id: d._id || new Types.ObjectId(),
          ...d,
          timestamp: new Date(),
        }
        auditLogsDb.push(doc)
        return doc
      })
      return Promise.resolve(created)
    }),
    find: vi.fn().mockImplementation((query) => {
      const filtered = auditLogsDb.filter(
        (log) => log.clinicId.toString() === query.clinicId.toString(),
      )
      return createQueryMock(filtered)
    }),
    countDocuments: vi.fn().mockImplementation((query) => {
      const count = auditLogsDb.filter(
        (log) => log.clinicId.toString() === query.clinicId.toString(),
      ).length
      return Promise.resolve(count)
    }),
  }

  const mockModels: Record<string, any> = {
    [Doctor.name]: mockDoctorModel,
    [Clinic.name]: mockClinicModel,
    [ClinicMembership.name]: mockMembershipModel,
    [ClinicInvitation.name]: mockInvitationModel,
    [InvitationOutbox.name]: mockOutboxModel,
    [ClinicAuditLog.name]: mockAuditLogModel,
    [RefreshSession.name]: {
      create: vi.fn(),
      findOne: vi.fn(),
      updateMany: vi.fn(),
    },
    [PasswordResetToken.name]: { create: vi.fn(), findOne: vi.fn() },
    [RateLimit.name]: { findOneAndUpdate: vi.fn(), updateOne: vi.fn() },
  }

  const mockConnection: any = {
    readyState: 1,
    models: mockModels,
    model: (name: string) => mockModels[name] || {},
    startSession: vi.fn().mockResolvedValue(mockSession),
    getClient: () => ({
      topology: { description: { type: "ReplicaSetWithPrimary" } },
    }),
    on: () => {},
    close: async () => {},
  }

  @Global()
  @Module({
    providers: [
      { provide: getConnectionToken(), useValue: mockConnection },
      { provide: getModelToken(Doctor.name), useValue: mockDoctorModel },
      { provide: getModelToken(Clinic.name), useValue: mockClinicModel },
      {
        provide: getModelToken(ClinicMembership.name),
        useValue: mockMembershipModel,
      },
      {
        provide: getModelToken(ClinicInvitation.name),
        useValue: mockInvitationModel,
      },
      {
        provide: getModelToken(InvitationOutbox.name),
        useValue: mockOutboxModel,
      },
      {
        provide: getModelToken(ClinicAuditLog.name),
        useValue: mockAuditLogModel,
      },
      {
        provide: getModelToken(RefreshSession.name),
        useValue: mockModels[RefreshSession.name],
      },
      {
        provide: getModelToken(PasswordResetToken.name),
        useValue: mockModels[PasswordResetToken.name],
      },
      {
        provide: getModelToken(RateLimit.name),
        useValue: mockModels[RateLimit.name],
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
    ],
  })
  class MockDatabaseModule {}

  beforeEach(async () => {
    clinicsDb.clear()
    membershipsDb.clear()
    invitationsDb.clear()
    outboxDb.clear()
    auditLogsDb.length = 0
    doctorsDb.clear()

    const doctorA = {
      _id: doctorAId,
      email: "doca@cliniqo.app",
      firstName: "Alice",
      lastName: "Smith",
      status: DoctorStatus.ACTIVE,
      save: vi.fn().mockResolvedValue(true),
    }
    const doctorB = {
      _id: doctorBId,
      email: "docb@cliniqo.app",
      firstName: "Bob",
      lastName: "Jones",
      status: DoctorStatus.ACTIVE,
      save: vi.fn().mockResolvedValue(true),
    }
    const doctorC = {
      _id: doctorCId,
      email: "docc@cliniqo.app",
      firstName: "Charlie",
      lastName: "Brown",
      status: DoctorStatus.ACTIVE,
      save: vi.fn().mockResolvedValue(true),
    }

    doctorsDb.set(doctorAId.toString(), doctorA)
    doctorsDb.set(doctorBId.toString(), doctorB)
    doctorsDb.set(doctorCId.toString(), doctorC)

    const mockMailService = {
      sendPasswordResetEmail: vi.fn().mockResolvedValue(true),
      sendClinicInvitationEmail: vi.fn().mockResolvedValue(true),
    }

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideModule(DatabaseModule)
      .useModule(MockDatabaseModule)
      .overrideProvider(MailService)
      .useValue(mockMailService)
      .compile()

    app = moduleFixture.createNestApplication()
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    )
    await app.init()

    tokenService = moduleFixture.get<TokenService>(TokenService)

    // Generate authenticated JWT tokens for all three test doctors
    doctorAToken = await tokenService.generateAccessToken({
      _id: doctorAId,
      email: doctorA.email,
      fullName: `${doctorA.firstName} ${doctorA.lastName}`,
      status: DoctorStatus.ACTIVE,
    })

    doctorBToken = await tokenService.generateAccessToken({
      _id: doctorBId,
      email: doctorB.email,
      fullName: `${doctorB.firstName} ${doctorB.lastName}`,
      status: DoctorStatus.ACTIVE,
    })

    doctorCToken = await tokenService.generateAccessToken({
      _id: doctorCId,
      email: doctorC.email,
      fullName: `${doctorC.firstName} ${doctorC.lastName}`,
      status: DoctorStatus.ACTIVE,
    })
  })

  afterEach(async () => {
    if (app) {
      await app.close()
    }
  })

  describe("Scenario 1: Clinic Creation & Scoping", () => {
    it("creates a clinic and assigns Doctor A as OWNER", async () => {
      const res = await request(app.getHttpServer())
        .post("/clinics")
        .set("Authorization", `Bearer ${doctorAToken}`)
        .send({
          name: "City Health Clinic",
          slug: "city-health",
          phone: "+1-555-0100",
          email: "contact@cityhealth.test",
          address: {
            street: "100 Medical Blvd",
            city: "Metro",
            state: "NY",
            postalCode: "10001",
            country: "USA",
          },
        })
        .expect(201)

      expect(res.body.clinic).toBeDefined()
      expect(res.body.clinic.slug).toBe("city-health")
      expect(res.body.membership.role).toBe(ClinicRole.OWNER)
      expect(res.body.membership.status).toBe(ClinicMembershipStatus.ACTIVE)
    })
  })

  describe("Scenario 2: Cross-Tenant BOLA/IDOR Enforcement", () => {
    it("strictly forbids Doctor B from reading, updating, or listing members of Clinic A", async () => {
      // 1. Doctor A creates Clinic A
      const createRes = await request(app.getHttpServer())
        .post("/clinics")
        .set("Authorization", `Bearer ${doctorAToken}`)
        .send({
          name: "Clinic A Alpha",
          slug: "clinic-a-alpha",
          phone: "111-222-3333",
          email: "alpha@test.com",
          address: {
            street: "1 Alpha St",
            city: "AlphaCity",
            state: "NY",
            postalCode: "10001",
            country: "USA",
          },
        })
        .expect(201)

      const clinicAId = createRes.body.clinic._id

      // 2. Doctor B attempts to read Clinic A -> 403 Forbidden (zero data returned)
      const readRes = await request(app.getHttpServer())
        .get(`/clinics/${clinicAId}`)
        .set("Authorization", `Bearer ${doctorBToken}`)
        .expect(403)

      expect(readRes.body.name).toBeUndefined()
      expect(readRes.body.slug).toBeUndefined()

      // 3. Doctor B attempts to update Clinic A -> 403 Forbidden
      await request(app.getHttpServer())
        .patch(`/clinics/${clinicAId}`)
        .set("Authorization", `Bearer ${doctorBToken}`)
        .send({ name: "Hacked Clinic Name" })
        .expect(403)

      // 4. Doctor B attempts to list members of Clinic A -> 403 Forbidden
      await request(app.getHttpServer())
        .get(`/clinics/${clinicAId}/members`)
        .set("Authorization", `Bearer ${doctorBToken}`)
        .expect(403)

      // 5. Doctor B uses X-Clinic-ID header for Clinic A -> 403 Forbidden
      await request(app.getHttpServer())
        .get(`/clinics/${clinicAId}`)
        .set("Authorization", `Bearer ${doctorBToken}`)
        .set("X-Clinic-ID", clinicAId)
        .expect(403)
    })
  })

  describe("Scenario 3: Context Conflict Rejection", () => {
    it("rejects conflicting route parameter and X-Clinic-ID header with 400 Bad Request", async () => {
      const clinicAId = new Types.ObjectId().toString()
      const clinicBId = new Types.ObjectId().toString()

      await request(app.getHttpServer())
        .get(`/clinics/${clinicAId}`)
        .set("Authorization", `Bearer ${doctorAToken}`)
        .set("X-Clinic-ID", clinicBId) // Mismatched!
        .expect(400)
    })

    it("rejects invalid ObjectId clinic format with 400 Bad Request", async () => {
      await request(app.getHttpServer())
        .get("/clinics/not-a-valid-mongo-id")
        .set("Authorization", `Bearer ${doctorAToken}`)
        .expect(400)
    })
  })

  describe("Scenario 4: Role Escalation Prevention", () => {
    it("strictly forbids inviting a member with OWNER role", async () => {
      const createRes = await request(app.getHttpServer())
        .post("/clinics")
        .set("Authorization", `Bearer ${doctorAToken}`)
        .send({
          name: "Clinic Escalation Test",
          phone: "111-222-3333",
          email: "esc@test.com",
          address: {
            street: "1 St",
            city: "City",
            state: "NY",
            postalCode: "10001",
            country: "USA",
          },
        })
        .expect(201)

      const clinicId = createRes.body.clinic._id

      // Attempt to invite Doctor B as OWNER -> 400 Bad Request
      const res = await request(app.getHttpServer())
        .post(`/clinics/${clinicId}/invitations`)
        .set("Authorization", `Bearer ${doctorAToken}`)
        .send({
          inviteeEmail: "docb@cliniqo.app",
          role: "OWNER",
        })
        .expect(400)

      expect(res.body.message).toBeDefined()
    })
  })

  describe("Scenario 5: Invitation Lifecycle & Safe Listing", () => {
    it("lists pending invitations for recipient without exposing tokens or hashes", async () => {
      const createRes = await request(app.getHttpServer())
        .post("/clinics")
        .set("Authorization", `Bearer ${doctorAToken}`)
        .send({
          name: "Safe Listing Clinic",
          phone: "111-222-3333",
          email: "safe@test.com",
          address: {
            street: "1 St",
            city: "City",
            state: "NY",
            postalCode: "10001",
            country: "USA",
          },
        })
        .expect(201)

      const clinicId = createRes.body.clinic._id

      // Doctor A invites Doctor B
      const inviteRes = await request(app.getHttpServer())
        .post(`/clinics/${clinicId}/invitations`)
        .set("Authorization", `Bearer ${doctorAToken}`)
        .send({
          inviteeEmail: "docb@cliniqo.app",
          role: "DOCTOR",
        })
        .expect(201)

      // Verify create response contains zero tokens or hashes
      expect(inviteRes.body.rawToken).toBeUndefined()
      expect(inviteRes.body.invitationTokenHash).toBeUndefined()

      // Doctor B queries my invitations
      const listBRes = await request(app.getHttpServer())
        .get("/clinics/invitations")
        .set("Authorization", `Bearer ${doctorBToken}`)
        .expect(200)

      expect(listBRes.body).toHaveLength(1)
      expect(listBRes.body[0].role).toBe("DOCTOR")
      expect(listBRes.body[0].clinic.name).toBe("Safe Listing Clinic")
      // Crucial: no token hashes exposed to API consumers
      expect(listBRes.body[0].invitationTokenHash).toBeUndefined()
      expect(listBRes.body[0].rawToken).toBeUndefined()

      // Doctor C queries my invitations -> 0 results
      const listCRes = await request(app.getHttpServer())
        .get("/clinics/invitations")
        .set("Authorization", `Bearer ${doctorCToken}`)
        .expect(200)

      expect(listCRes.body).toHaveLength(0)
    })
  })

  describe("Scenario 6 & 7: Recipient Identity Verification & Replay Protection", () => {
    it("verifies recipient identity, permits acceptance, and blocks replay", async () => {
      const createRes = await request(app.getHttpServer())
        .post("/clinics")
        .set("Authorization", `Bearer ${doctorAToken}`)
        .send({
          name: "Acceptance Clinic",
          phone: "111-222-3333",
          email: "acc@test.com",
          address: {
            street: "1 St",
            city: "City",
            state: "NY",
            postalCode: "10001",
            country: "USA",
          },
        })
        .expect(201)

      const clinicId = createRes.body.clinic._id

      // Seed invitation directly for Doctor B
      const rawToken = "secret-invitation-token-1234567890"
      const tokenHash = crypto
        .createHash("sha256")
        .update(rawToken)
        .digest("hex")
      const invId = new Types.ObjectId()

      invitationsDb.set(invId.toString(), {
        _id: invId,
        clinicId: new Types.ObjectId(clinicId),
        inviteeEmail: "docb@cliniqo.app",
        role: "DOCTOR",
        status: ClinicInvitationStatus.PENDING,
        invitedBy: doctorAId,
        invitationTokenHash: tokenHash,
        expiresAt: new Date(Date.now() + 86400000),
      })

      // 1. Doctor C attempts to accept Doctor B's token -> 403 Forbidden
      const rejectRes = await request(app.getHttpServer())
        .post(`/clinics/invitations/${rawToken}/accept`)
        .set("Authorization", `Bearer ${doctorCToken}`)
        .expect(403)

      expect(rejectRes.body.message).toContain("different email address")

      // 2. Doctor B accepts -> 200 OK
      const acceptRes = await request(app.getHttpServer())
        .post(`/clinics/invitations/${rawToken}/accept`)
        .set("Authorization", `Bearer ${doctorBToken}`)
        .expect(200)

      expect(acceptRes.body.message).toContain("accepted successfully")

      // 3. Replay: Doctor B attempts to accept the same token a second time -> 404 Not Found
      await request(app.getHttpServer())
        .post(`/clinics/invitations/${rawToken}/accept`)
        .set("Authorization", `Bearer ${doctorBToken}`)
        .expect(404)
    })
  })

  describe("Scenario 8: Member Listing & Scoped Role Enforcement", () => {
    it("restricts member invitations to authorized roles (Doctor B cannot invite)", async () => {
      const createRes = await request(app.getHttpServer())
        .post("/clinics")
        .set("Authorization", `Bearer ${doctorAToken}`)
        .send({
          name: "Permissions Test Clinic",
          phone: "111-222-3333",
          email: "perm@test.com",
          address: {
            street: "1 St",
            city: "City",
            state: "NY",
            postalCode: "10001",
            country: "USA",
          },
        })
        .expect(201)

      const clinicId = createRes.body.clinic._id

      // Add Doctor B as DOCTOR member
      const memberBId = new Types.ObjectId()
      membershipsDb.set(memberBId.toString(), {
        _id: memberBId,
        clinicId: new Types.ObjectId(clinicId),
        doctorId: doctorBId,
        role: ClinicRole.DOCTOR,
        status: ClinicMembershipStatus.ACTIVE,
      })

      // Doctor B can list members
      const listRes = await request(app.getHttpServer())
        .get(`/clinics/${clinicId}/members`)
        .set("Authorization", `Bearer ${doctorBToken}`)
        .expect(200)

      expect(listRes.body).toHaveLength(2)

      // Doctor B (DOCTOR role) attempts to invite someone -> 403 Forbidden (requires MEMBER_INVITE)
      await request(app.getHttpServer())
        .post(`/clinics/${clinicId}/invitations`)
        .set("Authorization", `Bearer ${doctorBToken}`)
        .send({
          inviteeEmail: "newstaff@cliniqo.app",
          role: "STAFF",
        })
        .expect(403)
    })
  })

  describe("Scenario 9: Clinic Lifecycle Transitions & Audit Trail", () => {
    it("enforces status boundaries during suspension/archival and provides audit logs", async () => {
      const createRes = await request(app.getHttpServer())
        .post("/clinics")
        .set("Authorization", `Bearer ${doctorAToken}`)
        .send({
          name: "Lifecycle Clinic",
          phone: "111-222-3333",
          email: "life@test.com",
          address: {
            street: "1 St",
            city: "City",
            state: "NY",
            postalCode: "10001",
            country: "USA",
          },
        })
        .expect(201)

      const clinicId = createRes.body.clinic._id

      // Add Doctor B as member
      const memberBId = new Types.ObjectId()
      membershipsDb.set(memberBId.toString(), {
        _id: memberBId,
        clinicId: new Types.ObjectId(clinicId),
        doctorId: doctorBId,
        role: ClinicRole.DOCTOR,
        status: ClinicMembershipStatus.ACTIVE,
      })

      // 1. Doctor A suspends clinic with reason
      await request(app.getHttpServer())
        .post(`/clinics/${clinicId}/suspend`)
        .set("Authorization", `Bearer ${doctorAToken}`)
        .send({ reason: "Temporary suspension for compliance audit" })
        .expect(200)

      // 2. Doctor B attempts to access suspended clinic -> 403 Forbidden
      await request(app.getHttpServer())
        .get(`/clinics/${clinicId}`)
        .set("Authorization", `Bearer ${doctorBToken}`)
        .expect(403)

      // 3. Doctor A (OWNER) reads profile of suspended clinic -> 200 OK
      await request(app.getHttpServer())
        .get(`/clinics/${clinicId}`)
        .set("Authorization", `Bearer ${doctorAToken}`)
        .expect(200)

      // 4. Doctor A reactivates clinic
      await request(app.getHttpServer())
        .post(`/clinics/${clinicId}/reactivate`)
        .set("Authorization", `Bearer ${doctorAToken}`)
        .send({ reason: "Compliance audit cleared and approved" })
        .expect(200)

      // 5. Doctor A archives clinic
      await request(app.getHttpServer())
        .post(`/clinics/${clinicId}/archive`)
        .set("Authorization", `Bearer ${doctorAToken}`)
        .send({ reason: "Permanent retirement of facility" })
        .expect(200)

      // 6. Doctor A inspects immutable audit logs
      const auditRes = await request(app.getHttpServer())
        .get(`/clinics/${clinicId}/audit-logs`)
        .set("Authorization", `Bearer ${doctorAToken}`)
        .expect(200)

      expect(auditRes.body.logs.length).toBeGreaterThanOrEqual(4)
      const actions = auditRes.body.logs.map((l: any) => l.action)
      expect(actions).toContain(ClinicAuditAction.CLINIC_CREATED)
      expect(actions).toContain(ClinicAuditAction.CLINIC_SUSPENDED)
      expect(actions).toContain(ClinicAuditAction.CLINIC_REACTIVATED)
      expect(actions).toContain(ClinicAuditAction.CLINIC_ARCHIVED)

      // 7. Doctor B (non-owner) attempts to view audit logs -> 403 Forbidden
      await request(app.getHttpServer())
        .get(`/clinics/${clinicId}/audit-logs`)
        .set("Authorization", `Bearer ${doctorBToken}`)
        .expect(403)
    })
  })

  describe("Scenario 10: Single-Owner Invariant & Ownership Transfer", () => {
    it("blocks owner revocation and atomically transfers ownership", async () => {
      const createRes = await request(app.getHttpServer())
        .post("/clinics")
        .set("Authorization", `Bearer ${doctorAToken}`)
        .send({
          name: "Ownership Transfer Clinic",
          phone: "111-222-3333",
          email: "trans@test.com",
          address: {
            street: "1 St",
            city: "City",
            state: "NY",
            postalCode: "10001",
            country: "USA",
          },
        })
        .expect(201)

      const clinicId = createRes.body.clinic._id

      // Add Doctor B as member
      const memberBId = new Types.ObjectId()
      membershipsDb.set(memberBId.toString(), {
        _id: memberBId,
        clinicId: new Types.ObjectId(clinicId),
        doctorId: doctorBId,
        role: ClinicRole.DOCTOR,
        status: ClinicMembershipStatus.ACTIVE,
      })

      // 1. Doctor A attempts to revoke Doctor A (OWNER) -> 400 Bad Request
      const revokeRes = await request(app.getHttpServer())
        .delete(`/clinics/${clinicId}/members/${doctorAId.toString()}`)
        .set("Authorization", `Bearer ${doctorAToken}`)
        .expect(400)

      expect(revokeRes.body.message).toContain("Cannot revoke clinic owner")

      // 2. Doctor A transfers ownership to Doctor B -> 200 OK
      const transferRes = await request(app.getHttpServer())
        .post(`/clinics/${clinicId}/transfer-ownership`)
        .set("Authorization", `Bearer ${doctorAToken}`)
        .send({ newOwnerDoctorId: doctorBId.toString() })
        .expect(200)

      expect(transferRes.body.newOwnerDoctorId).toBe(doctorBId.toString())

      // 3. Verify Doctor B is now OWNER
      const updatedMembers = await request(app.getHttpServer())
        .get(`/clinics/${clinicId}/members`)
        .set("Authorization", `Bearer ${doctorBToken}`)
        .expect(200)

      const memberBRecord = updatedMembers.body.find(
        (m: any) => m.doctorId === doctorBId.toString(),
      )
      expect(memberBRecord.role).toBe(ClinicRole.OWNER)

      const memberARecord = updatedMembers.body.find(
        (m: any) => m.doctorId === doctorAId.toString(),
      )
      expect(memberARecord.role).toBe(ClinicRole.DOCTOR)
    })
  })
})
