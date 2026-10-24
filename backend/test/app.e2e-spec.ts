import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, Module, Global } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';
import { DatabaseModule } from './../src/database/database.module.js';
import { Doctor } from './../src/auth/schemas/doctor.schema.js';
import { RefreshSession } from './../src/auth/schemas/refresh-session.schema.js';
import { PasswordResetToken } from './../src/auth/schemas/password-reset.schema.js';
import { RateLimit } from './../src/auth/schemas/rate-limit.schema.js';

describe('Health Endpoints (e2e)', () => {
  let app: INestApplication<App>;
  let mockConnectionState: {
    readyState: number;
    pingOk: boolean;
    pingError?: Error;
  };

  const createMockConnection = () => ({
    get readyState() {
      return mockConnectionState.readyState;
    },
    db: {
      admin: () => ({
        ping: async () => {
          if (mockConnectionState.pingError) {
            throw mockConnectionState.pingError;
          }
          return { ok: mockConnectionState.pingOk ? 1 : 0 };
        },
      }),
    },
    models: {} as Record<string, any>,
    model: () => ({}),
    on: () => {},
    close: async () => {},
  });

  @Global()
  @Module({
    providers: [
      {
        provide: getConnectionToken(),
        useFactory: () => createMockConnection(),
      },
      {
        provide: getModelToken(Doctor.name),
        useValue: {},
      },
      {
        provide: getModelToken(RefreshSession.name),
        useValue: {},
      },
      {
        provide: getModelToken(PasswordResetToken.name),
        useValue: {},
      },
      {
        provide: getModelToken(RateLimit.name),
        useValue: {},
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
    mockConnectionState = {
      readyState: 1,
      pingOk: true,
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideModule(DatabaseModule)
      .useModule(MockDatabaseModule)
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /health/live', () => {
    it('should return HTTP 200 with ok status and uptime', async () => {
      const res = await request(app.getHttpServer())
        .get('/health/live')
        .expect(200);

      expect(res.body.status).toBe('ok');
      expect(typeof res.body.uptime).toBe('number');
      expect(typeof res.body.timestamp).toBe('string');
    });

    it('should remain HTTP 200 when database is disconnected', async () => {
      mockConnectionState.readyState = 0; // disconnected

      const res = await request(app.getHttpServer())
        .get('/health/live')
        .expect(200);

      expect(res.body.status).toBe('ok');
    });
  });

  describe('GET /health/ready', () => {
    it('should return HTTP 200 with ready status and database ok when connected', async () => {
      mockConnectionState.readyState = 1;
      mockConnectionState.pingOk = true;

      const res = await request(app.getHttpServer())
        .get('/health/ready')
        .expect(200);

      expect(res.body.status).toBe('ready');
      expect(res.body.checks.process).toBe('ok');
      expect(res.body.checks.database).toBe('ok');
    });

    it('should return HTTP 503 and not_ready when database readyState is 0 (disconnected)', async () => {
      mockConnectionState.readyState = 0;

      const res = await request(app.getHttpServer())
        .get('/health/ready')
        .expect(503);

      expect(res.body.status).toBe('not_ready');
      expect(res.body.checks.process).toBe('ok');
      expect(res.body.checks.database).toBe('unavailable');
    });

    it('should return HTTP 503 and sanitized response when database ping fails', async () => {
      mockConnectionState.readyState = 1;
      mockConnectionState.pingError = new Error(
        'MongoServerSelectionError: cluster0.abcde.mongodb.net timeout',
      );

      const res = await request(app.getHttpServer())
        .get('/health/ready')
        .expect(503);

      expect(res.body.status).toBe('not_ready');
      expect(res.body.checks.database).toBe('unavailable');
      // Assert sanitized payload does not reveal hostnames, credentials, or internal error text
      const bodyStr = JSON.stringify(res.body);
      expect(bodyStr).not.toContain('cluster0.abcde.mongodb.net');
      expect(bodyStr).not.toContain('MongoServerSelectionError');
    });

    it('should handle startup outage, initial failure, and recovery upon reconnection', async () => {
      // 1. Initial startup outage: DB is unavailable
      mockConnectionState.readyState = 0;
      mockConnectionState.pingOk = false;

      const initialReady = await request(app.getHttpServer())
        .get('/health/ready')
        .expect(503);
      expect(initialReady.body.status).toBe('not_ready');
      expect(initialReady.body.checks.database).toBe('unavailable');

      const initialLive = await request(app.getHttpServer())
        .get('/health/live')
        .expect(200);
      expect(initialLive.body.status).toBe('ok');

      // 2. DB establishes connection
      mockConnectionState.readyState = 1;
      mockConnectionState.pingOk = true;

      const connectedReady = await request(app.getHttpServer())
        .get('/health/ready')
        .expect(200);
      expect(connectedReady.body.status).toBe('ready');
      expect(connectedReady.body.checks.database).toBe('ok');

      // 3. Transient outage
      mockConnectionState.readyState = 0;
      mockConnectionState.pingOk = false;

      const outageReady = await request(app.getHttpServer())
        .get('/health/ready')
        .expect(503);
      expect(outageReady.body.status).toBe('not_ready');

      // 4. DB reconnects
      mockConnectionState.readyState = 1;
      mockConnectionState.pingOk = true;

      const recoveredReady = await request(app.getHttpServer())
        .get('/health/ready')
        .expect(200);
      expect(recoveredReady.body.status).toBe('ready');
      expect(recoveredReady.body.checks.database).toBe('ok');
    });
  });
});
