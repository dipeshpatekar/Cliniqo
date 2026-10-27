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

  describe('validateAuthConfig', () => {
    const validAccessSecret = 'a'.repeat(32);
    const validRefreshSecret = 'b'.repeat(32);

    it('should validate and return auth configuration when valid secrets are provided', () => {
      const service = new ConfigService({
        NODE_ENV: 'production',
        JWT_ACCESS_SECRET: validAccessSecret,
        JWT_REFRESH_SECRET: validRefreshSecret,
        JWT_ACCESS_EXPIRES_IN: '15m',
        JWT_REFRESH_EXPIRES_IN: '7d',
        JWT_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----',
        JWT_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----',
        ARGON2_MEMORY_COST: '65536',
        ARGON2_TIME_COST: '3',
        ARGON2_PARALLELISM: '4',
      });

      const authConfig = service.validateAuthConfig();
      expect(authConfig.jwtAccessSecret).toBe(validAccessSecret);
      expect(authConfig.jwtRefreshSecret).toBe(validRefreshSecret);
      expect(authConfig.jwtAccessExpiresIn).toBe('15m');
      expect(authConfig.jwtRefreshExpiresIn).toBe('7d');
      expect(authConfig.jwtIssuer).toBe('cliniqo-backend');
      expect(authConfig.jwtAudience).toBe('cliniqo-client');
      expect(authConfig.argon2MemoryCost).toBe(65536);
      expect(authConfig.argon2TimeCost).toBe(3);
      expect(authConfig.argon2Parallelism).toBe(4);
    });

    it('should reject production auth config if JWT_PRIVATE_KEY or JWT_PUBLIC_KEY is missing', () => {
      const service = new ConfigService({
        NODE_ENV: 'production',
        JWT_ACCESS_SECRET: validAccessSecret,
        JWT_REFRESH_SECRET: validRefreshSecret,
      });

      expect(() => service.validateAuthConfig()).toThrow(
        /JWT_PRIVATE_KEY and JWT_PUBLIC_KEY are required in production/,
      );
    });

    it('should allow development mode without JWT_PRIVATE_KEY or JWT_PUBLIC_KEY', () => {
      const service = new ConfigService({
        NODE_ENV: 'development',
        JWT_ACCESS_SECRET: validAccessSecret,
        JWT_REFRESH_SECRET: validRefreshSecret,
      });

      const authConfig = service.validateAuthConfig();
      expect(authConfig).toBeDefined();
    });

    it('should provide default and custom SMTP and rate limit configuration', () => {
      const defaultService = new ConfigService({});
      expect(defaultService.isSmtpConfigured).toBe(false);
      expect(defaultService.smtpConfig.port).toBe(587);
      expect(defaultService.smtpConfig.from).toBe('noreply@cliniqo.app');
      expect(defaultService.rateLimitConfig.loginMax).toBe(5);
      expect(defaultService.rateLimitConfig.loginWindowSec).toBe(60);

      const customService = new ConfigService({
        SMTP_HOST: 'smtp.mailtrap.io',
        SMTP_PORT: '2525',
        SMTP_USER: 'user',
        SMTP_PASS: 'pass',
        SMTP_FROM: 'clinic@cliniqo.app',
        SMTP_SECURE: 'true',
        RATE_LIMIT_LOGIN_MAX: '10',
        RATE_LIMIT_LOGIN_WINDOW_SEC: '120',
      });
      expect(customService.isSmtpConfigured).toBe(true);
      expect(customService.smtpConfig.host).toBe('smtp.mailtrap.io');
      expect(customService.smtpConfig.port).toBe(2525);
      expect(customService.smtpConfig.secure).toBe(true);
      expect(customService.rateLimitConfig.loginMax).toBe(10);
      expect(customService.rateLimitConfig.loginWindowSec).toBe(120);
    });

    it('should throw when JWT_ACCESS_SECRET is missing or empty', () => {
      const service = new ConfigService({
        JWT_REFRESH_SECRET: validRefreshSecret,
      });

      expect(() => service.validateAuthConfig()).toThrow(
        'Authentication configuration error: JWT_ACCESS_SECRET is required',
      );
    });

    it('should enforce 32-character minimum secret length in production', () => {
      const service = new ConfigService({
        NODE_ENV: 'production',
        JWT_ACCESS_SECRET: 'short-secret-under-32-chars!',
        JWT_REFRESH_SECRET: validRefreshSecret,
      });

      expect(() => service.validateAuthConfig()).toThrow(
        'Authentication configuration error: JWT_ACCESS_SECRET is required and must be at least 32 characters.',
      );
    });

    it('should throw when a known weak or placeholder secret is supplied', () => {
      const service = new ConfigService({
        NODE_ENV: 'development',
        JWT_ACCESS_SECRET: 'changeme',
        JWT_REFRESH_SECRET: validRefreshSecret,
      });

      expect(() => service.validateAuthConfig()).toThrow(
        'Authentication configuration error: JWT_ACCESS_SECRET cannot use an insecure or default placeholder value.',
      );
    });

    it('should throw when JWT_ACCESS_SECRET and JWT_REFRESH_SECRET are identical', () => {
      const service = new ConfigService({
        NODE_ENV: 'production',
        JWT_ACCESS_SECRET: validAccessSecret,
        JWT_REFRESH_SECRET: validAccessSecret,
      });

      expect(() => service.validateAuthConfig()).toThrow(
        'Authentication configuration error: JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be distinct keys.',
      );
    });

    it('should validate Argon2 parameter bounds', () => {
      const lowMemService = new ConfigService({
        JWT_ACCESS_SECRET: validAccessSecret,
        JWT_REFRESH_SECRET: validRefreshSecret,
        ARGON2_MEMORY_COST: '1024', // under 16MB
      });
      expect(() => lowMemService.validateAuthConfig()).toThrow(
        'Authentication configuration error: ARGON2_MEMORY_COST must be between 16384 (16MB) and 1048576 (1GB).',
      );

      const invalidTimeService = new ConfigService({
        JWT_ACCESS_SECRET: validAccessSecret,
        JWT_REFRESH_SECRET: validRefreshSecret,
        ARGON2_TIME_COST: '0',
      });
      expect(() => invalidTimeService.validateAuthConfig()).toThrow(
        'Authentication configuration error: ARGON2_TIME_COST must be between 1 and 100.',
      );
    });

    it('should throw when expiry format is invalid', () => {
      const invalidAccessExpiryService = new ConfigService({
        JWT_ACCESS_SECRET: validAccessSecret,
        JWT_REFRESH_SECRET: validRefreshSecret,
        JWT_ACCESS_EXPIRES_IN: 'invalid-expiry',
      });
      expect(() => invalidAccessExpiryService.validateAuthConfig()).toThrow(
        'Authentication configuration error: JWT_ACCESS_EXPIRES_IN must be a valid time span',
      );

      const invalidRefreshExpiryService = new ConfigService({
        JWT_ACCESS_SECRET: validAccessSecret,
        JWT_REFRESH_SECRET: validRefreshSecret,
        JWT_REFRESH_EXPIRES_IN: '10years',
      });
      expect(() => invalidRefreshExpiryService.validateAuthConfig()).toThrow(
        'Authentication configuration error: JWT_REFRESH_EXPIRES_IN must be a valid time span',
      );
    });
  });

  describe('validateOutboxConfig', () => {
    it('returns a 32-byte Buffer when OUTBOX_ENCRYPTION_KEY is a valid 64-hex string', () => {
      const validHexKey =
        '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      const service = new ConfigService({
        OUTBOX_ENCRYPTION_KEY: validHexKey,
      });
      const buffer = service.validateOutboxConfig();
      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.length).toBe(32);
      expect(buffer.toString('hex')).toBe(validHexKey);
    });

    it('throws when OUTBOX_ENCRYPTION_KEY is missing or empty', () => {
      const service = new ConfigService({});
      expect(() => service.validateOutboxConfig()).toThrow(
        'Configuration error: OUTBOX_ENCRYPTION_KEY is required and must be a 256-bit key represented as exactly 64 hexadecimal characters',
      );
    });

    it('throws when OUTBOX_ENCRYPTION_KEY contains non-hex characters', () => {
      const invalidHexKey =
        'replace_with_64_character_hex_key_generated_by_openssl_rand_hex_32';
      const service = new ConfigService({
        OUTBOX_ENCRYPTION_KEY: invalidHexKey,
      });
      expect(() => service.validateOutboxConfig()).toThrow(
        'Configuration error: OUTBOX_ENCRYPTION_KEY is required and must be a 256-bit key represented as exactly 64 hexadecimal characters',
      );
    });

    it('throws when OUTBOX_ENCRYPTION_KEY is shorter than 64 characters', () => {
      const shortKey = '0123456789abcdef';
      const service = new ConfigService({
        OUTBOX_ENCRYPTION_KEY: shortKey,
      });
      expect(() => service.validateOutboxConfig()).toThrow(
        'Configuration error: OUTBOX_ENCRYPTION_KEY is required and must be a 256-bit key represented as exactly 64 hexadecimal characters',
      );
    });
  });
});
