import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import {
  INestApplication,
  Module,
  Global,
  ValidationPipe,
} from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { Types } from 'mongoose';
import { AppModule } from './../src/app.module.js';
import { DatabaseModule } from './../src/database/database.module.js';
import { Doctor } from './../src/auth/schemas/doctor.schema.js';
import { RefreshSession } from './../src/auth/schemas/refresh-session.schema.js';
import { PasswordResetToken } from './../src/auth/schemas/password-reset.schema.js';
import { RateLimit } from './../src/auth/schemas/rate-limit.schema.js';
import { PasswordService } from './../src/auth/password.service.js';
import { MailService } from './../src/auth/mail.service.js';
import { DoctorStatus } from './../src/auth/auth.constants.js';

describe('Auth Endpoints (e2e)', () => {
  const originalEnv = { ...process.env };

  beforeAll(() => {
    process.env.JWT_ACCESS_SECRET =
      'test-jwt-access-secret-32-chars-long-minimum!';
    process.env.JWT_REFRESH_SECRET =
      'test-jwt-refresh-secret-32-chars-long-minimum!';
    process.env.JWT_ISSUER = 'cliniqo-api-test';
    process.env.JWT_AUDIENCE = 'cliniqo-client-test';
  });

  afterAll(() => {
    process.env = originalEnv;
  });
  let app: INestApplication<App>;
  let mockDoctor: any;
  let mockPasswordService: PasswordService;
  let mockMailService: any;
  let mockSessionDoc: any;
  let mockResetDoc: any;

  const validDoctorId = new Types.ObjectId();
  const validHashedPassword =
    '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$1234567890abcdef1234567890abcdef';

  const createQueryMock = (result: any) => {
    const promise = Promise.resolve(result) as any;
    promise.select = vi.fn().mockImplementation(() => createQueryMock(result));
    return promise;
  };

  const mockDoctorModel = {
    findOne: vi.fn(),
    findById: vi.fn(),
  };

  const mockSessionModel = {
    create: vi.fn(),
    findOne: vi.fn(),
    updateMany: vi.fn(),
    updateOne: vi.fn(),
  };

  const mockResetModel = {
    create: vi.fn(),
    findOne: vi.fn(),
    updateMany: vi.fn(),
  };

  const mockRateLimitModel = {
    findOneAndUpdate: vi.fn(),
    updateOne: vi.fn(),
    deleteOne: vi.fn(),
  };

  const mockModels: Record<string, any> = {
    [Doctor.name]: mockDoctorModel,
    [RefreshSession.name]: mockSessionModel,
    [PasswordResetToken.name]: mockResetModel,
    [RateLimit.name]: mockRateLimitModel,
  };

  const mockConnection = {
    readyState: 1,
    db: { admin: () => ({ ping: async () => ({ ok: 1 }) }) },
    models: mockModels,
    model: (name: string) => mockModels[name] || {},
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
      {
        provide: getModelToken(Doctor.name),
        useValue: mockDoctorModel,
      },
      {
        provide: getModelToken(RefreshSession.name),
        useValue: mockSessionModel,
      },
      {
        provide: getModelToken(PasswordResetToken.name),
        useValue: mockResetModel,
      },
      {
        provide: getModelToken(RateLimit.name),
        useValue: mockRateLimitModel,
      },
    ],
    exports: [
      getConnectionToken(),
      getModelToken(Doctor.name),
      getModelToken(RefreshSession.name),
      getModelToken(PasswordResetToken.name),
      getModelToken(RateLimit.name),
    ],
  })
  class MockDatabaseModule {}

  beforeEach(async () => {
    mockPasswordService = new PasswordService();

    mockRateLimitModel.findOneAndUpdate.mockResolvedValue(null);
    mockRateLimitModel.updateOne.mockResolvedValue({ acknowledged: true });
    mockRateLimitModel.deleteOne.mockResolvedValue({ deletedCount: 1 });

    mockDoctor = {
      _id: validDoctorId,
      email: 'dr.smith@cliniqo.app',
      fullName: 'Dr. John Smith',
      status: DoctorStatus.ACTIVE,
      passwordHash: validHashedPassword,
      failedLoginAttempts: 0,
      lockUntil: null,
      save: vi.fn().mockResolvedValue(true),
    };

    mockMailService = {
      sendPasswordResetEmail: vi.fn().mockResolvedValue(true),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideModule(DatabaseModule)
      .useModule(MockDatabaseModule)
      .overrideProvider(getModelToken(Doctor.name))
      .useValue(mockDoctorModel)
      .overrideProvider(getModelToken(RefreshSession.name))
      .useValue(mockSessionModel)
      .overrideProvider(getModelToken(PasswordResetToken.name))
      .useValue(mockResetModel)
      .overrideProvider(getModelToken(RateLimit.name))
      .useValue(mockRateLimitModel)
      .overrideProvider(MailService)
      .useValue(mockMailService)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('POST /auth/login', () => {
    it('should login successfully and return access & refresh tokens', async () => {
      mockDoctorModel.findOne.mockImplementation(() =>
        createQueryMock(mockDoctor),
      );

      // Use a known hash matching 'ValidPassword123!'
      const knownHash =
        await mockPasswordService.hashPassword('ValidPassword123!');
      mockDoctor.passwordHash = knownHash;

      mockSessionModel.create.mockImplementation(async (data: any) => ({
        ...data,
        _id: new Types.ObjectId(),
      }));

      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: 'dr.smith@cliniqo.app',
          password: 'ValidPassword123!',
        })
        .expect(200);

      expect(res.body.accessToken).toBeDefined();
      expect(res.body.refreshToken).toBeDefined();
      expect(res.body.tokenType).toBe('Bearer');
      expect(res.body.doctor.email).toBe('dr.smith@cliniqo.app');
    });

    it('should return HTTP 401 on invalid credentials', async () => {
      mockDoctorModel.findOne.mockImplementation(() =>
        createQueryMock(mockDoctor),
      );

      await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: 'dr.smith@cliniqo.app',
          password: 'WrongPassword!',
        })
        .expect(401);
    });

    it('should return HTTP 400 on malformed email', async () => {
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: 'not-an-email',
          password: 'ValidPassword123!',
        })
        .expect(400);
    });

    it('should return HTTP 400 when unexpected unknown properties are submitted (forbidNonWhitelisted)', async () => {
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: 'dr.smith@cliniqo.app',
          password: 'ValidPassword123!',
          isAdmin: true, // Unknown / injected field!
        })
        .expect(400);
    });
  });

  describe('POST /auth/refresh', () => {
    it('should rotate refresh token and return new tokens on valid 64-character token', async () => {
      const validRefreshToken = 'a'.repeat(64);
      mockSessionDoc = {
        _id: new Types.ObjectId(),
        doctorId: validDoctorId,
        familyId: 'family-1',
        isRevoked: false,
        expiresAt: new Date(Date.now() + 100000),
        save: vi.fn().mockResolvedValue(true),
      };

      mockSessionModel.findOne.mockResolvedValue(mockSessionDoc);
      mockDoctorModel.findById.mockImplementation(() =>
        createQueryMock(mockDoctor),
      );
      mockSessionModel.create.mockImplementation(async (data: any) => ({
        ...data,
        _id: new Types.ObjectId(),
      }));

      const res = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: validRefreshToken })
        .expect(200);

      expect(res.body.accessToken).toBeDefined();
      expect(res.body.refreshToken).toBeDefined();
    });

    it('should return HTTP 400 if refresh token is not 64 characters', async () => {
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: 'short-token' })
        .expect(400);
    });
  });

  describe('POST /auth/logout', () => {
    it('should return HTTP 200 on logout', async () => {
      mockSessionModel.updateOne.mockResolvedValue({ modifiedCount: 1 });

      const res = await request(app.getHttpServer())
        .post('/auth/logout')
        .send({ refreshToken: 'b'.repeat(64) })
        .expect(200);

      expect(res.body.message).toContain('logged out');
    });
  });

  describe('POST /auth/forgot-password', () => {
    it('should return HTTP 200 with generic message for active account', async () => {
      mockDoctorModel.findOne.mockImplementation(() =>
        createQueryMock(mockDoctor),
      );
      mockResetModel.updateMany.mockResolvedValue({ modifiedCount: 0 });
      mockResetModel.create.mockResolvedValue({});

      const res = await request(app.getHttpServer())
        .post('/auth/forgot-password')
        .send({ email: 'dr.smith@cliniqo.app' })
        .expect(200);

      expect(res.body.message).toContain(
        'If an account exists with this email address',
      );
    });

    it('should return identical HTTP 200 generic message for unknown account', async () => {
      mockDoctorModel.findOne.mockImplementation(() => createQueryMock(null));

      const res = await request(app.getHttpServer())
        .post('/auth/forgot-password')
        .send({ email: 'unknown@cliniqo.app' })
        .expect(200);

      expect(res.body.message).toContain(
        'If an account exists with this email address',
      );
    });

    it('should return HTTP 400 on malformed email', async () => {
      await request(app.getHttpServer())
        .post('/auth/forgot-password')
        .send({ email: 'invalid-email' })
        .expect(400);
    });
  });

  describe('POST /auth/reset-password', () => {
    it('should reset password with HTTP 200 when token is valid and password is strong', async () => {
      mockResetDoc = {
        _id: new Types.ObjectId(),
        doctorId: validDoctorId,
        used: false,
        expiresAt: new Date(Date.now() + 600000),
        save: vi.fn().mockResolvedValue(true),
      };

      mockResetModel.findOne.mockResolvedValue(mockResetDoc);
      mockDoctorModel.findById.mockImplementation(() =>
        createQueryMock(mockDoctor),
      );
      mockSessionModel.updateMany.mockResolvedValue({ modifiedCount: 2 });

      const res = await request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({
          token: 'c'.repeat(64),
          newPassword: 'BrandNewStrongPassword2026!',
        })
        .expect(200);

      expect(res.body.message).toContain('reset successfully');
      expect(mockResetDoc.used).toBe(true);
      expect(mockDoctor.save).toHaveBeenCalled();
      expect(mockSessionModel.updateMany).toHaveBeenCalledWith(
        { doctorId: validDoctorId, isRevoked: false },
        expect.anything(),
      );
    });

    it('should return HTTP 400 if new password does not meet policy requirements', async () => {
      await request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({
          token: 'c'.repeat(64),
          newPassword: 'weak',
        })
        .expect(400);
    });
  });
});
