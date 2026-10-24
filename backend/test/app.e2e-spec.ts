import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';

describe('Health Endpoints (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/health/live (GET)', () => {
    return request(app.getHttpServer())
      .get('/health/live')
      .expect(200)
      .expect((res) => {
        if (res.body.status !== 'ok') throw new Error('Expected status ok');
        if (typeof res.body.uptime !== 'number') throw new Error('Expected uptime number');
      });
  });

  it('/health/ready (GET)', () => {
    return request(app.getHttpServer())
      .get('/health/ready')
      .expect(200)
      .expect((res) => {
        if (res.body.status !== 'ready') throw new Error('Expected status ready');
        if (res.body.checks.process !== 'ok') throw new Error('Expected process check ok');
      });
  });

  afterEach(async () => {
    await app.close();
  });
});
