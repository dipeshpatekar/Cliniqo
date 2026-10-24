import { describe, it, expect } from 'vitest';
import { ConfigService } from './config.service.js';

describe('ConfigService', () => {
  it('should use default values when environment variables are omitted', () => {
    const service = new ConfigService({});
    expect(service.port).toBe(3000);
    expect(service.nodeEnv).toBe('development');
    expect(service.isProduction).toBe(false);
    expect(service.isDevelopment).toBe(true);
    expect(service.corsOrigin).toBe('http://localhost:8443');
    expect(service.mongodbDbName).toBe('cliniqo');
    expect(service.mongodbUri).toBeUndefined();
  });

  it('should parse custom environment variables accurately', () => {
    const service = new ConfigService({
      NODE_ENV: 'production',
      PORT: '8080',
      CORS_ORIGIN: 'https://cliniqo.app',
      MONGODB_URI: 'mongodb+srv://user:pass@cluster.test/cliniqo',
      MONGODB_DB_NAME: 'prod_cliniqo',
    });
    expect(service.port).toBe(8080);
    expect(service.nodeEnv).toBe('production');
    expect(service.isProduction).toBe(true);
    expect(service.isDevelopment).toBe(false);
    expect(service.corsOrigin).toBe('https://cliniqo.app');
    expect(service.mongodbUri).toBe('mongodb+srv://user:pass@cluster.test/cliniqo');
    expect(service.mongodbDbName).toBe('prod_cliniqo');
  });
});
