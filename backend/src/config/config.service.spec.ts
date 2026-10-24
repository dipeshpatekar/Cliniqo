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
    expect(service.mongodbUri).toBe(
      'mongodb+srv://user:pass@cluster.test/cliniqo',
    );
    expect(service.mongodbDbName).toBe('prod_cliniqo');
  });

  describe('validateDatabaseConfig', () => {
    it('should throw sanitized error when MONGODB_URI is missing or empty', () => {
      const service = new ConfigService({});
      expect(() => service.validateDatabaseConfig()).toThrow(
        'Database configuration error: MONGODB_URI is required and cannot be empty.',
      );
    });

    it('should throw sanitized error when MONGODB_URI has an invalid scheme', () => {
      const service = new ConfigService({
        MONGODB_URI: 'http://localhost:27017/cliniqo',
      });
      expect(() => service.validateDatabaseConfig()).toThrow(
        'Database configuration error: MONGODB_URI must begin with mongodb:// or mongodb+srv://',
      );
    });

    it('should throw sanitized error when MONGODB_DB_NAME has invalid characters', () => {
      const service = new ConfigService({
        MONGODB_URI: 'mongodb://localhost:27017',
        MONGODB_DB_NAME: 'invalid db name with spaces!',
      });
      expect(() => service.validateDatabaseConfig()).toThrow(
        'Database configuration error: MONGODB_DB_NAME must only contain alphanumeric characters, underscores, and hyphens',
      );
    });

    it('should succeed and return sanitized config for valid mongodb:// URI', () => {
      const service = new ConfigService({
        MONGODB_URI: 'mongodb://127.0.0.1:27017',
        MONGODB_DB_NAME: 'cliniqo_test',
      });
      const dbConfig = service.validateDatabaseConfig();
      expect(dbConfig.uri).toBe('mongodb://127.0.0.1:27017');
      expect(dbConfig.dbName).toBe('cliniqo_test');
    });

    it('should succeed and return config for valid mongodb+srv:// Atlas URI', () => {
      const service = new ConfigService({
        MONGODB_URI: 'mongodb+srv://user:secret@cluster0.abcde.mongodb.net',
        MONGODB_DB_NAME: 'cliniqo_prod',
      });
      const dbConfig = service.validateDatabaseConfig();
      expect(dbConfig.uri).toBe(
        'mongodb+srv://user:secret@cluster0.abcde.mongodb.net',
      );
      expect(dbConfig.dbName).toBe('cliniqo_prod');
    });

    it('should not leak passwords or credentials in error messages for invalid inputs', () => {
      const service = new ConfigService({
        MONGODB_URI: 'postgres://admin:superSecretPassword@localhost:5432/db',
      });
      let caughtError: Error | null = null;
      try {
        service.validateDatabaseConfig();
      } catch (err) {
        caughtError = err as Error;
      }
      expect(caughtError).not.toBeNull();
      expect(caughtError!.message).not.toContain('superSecretPassword');
      expect(caughtError!.message).not.toContain('admin');
      expect(caughtError!.message).toBe(
        'Database configuration error: MONGODB_URI must begin with mongodb:// or mongodb+srv://',
      );
    });
  });
});
