import { describe, it, expect } from 'vitest';
import { redactSensitiveData } from './app-logger.service.js';

describe('redactSensitiveData', () => {
  it('should redact sensitive keys case-insensitively', () => {
    const raw = {
      user: 'doctor@cliniqo.in',
      password: 'supersecretpassword123',
      AUTHORIZATION: 'Bearer eyJhbGciOi...',
      nested: {
        otp: '123456',
        publicNote: 'Follow-up visit',
      },
    };

    const redacted = redactSensitiveData(raw) as any;

    expect(redacted.user).toBe('doctor@cliniqo.in');
    expect(redacted.password).toBe('[REDACTED]');
    expect(redacted.AUTHORIZATION).toBe('[REDACTED]');
    expect(redacted.nested.otp).toBe('[REDACTED]');
    expect(redacted.nested.publicNote).toBe('Follow-up visit');
  });

  it('should handle primitives and arrays safely', () => {
    expect(redactSensitiveData('hello')).toBe('hello');
    expect(redactSensitiveData(12345)).toBe(12345);
    expect(redactSensitiveData(null)).toBeNull();

    const arr = [{ token: 'abc' }, { normal: 'def' }];
    const redactedArr = redactSensitiveData(arr) as any[];
    expect(redactedArr[0].token).toBe('[REDACTED]');
    expect(redactedArr[1].normal).toBe('def');
  });

  it('should redact MongoDB URI keys and connection string keys in objects', () => {
    const raw = {
      mongodb_uri:
        'mongodb+srv://cluster-admin:secretPass@cliniqo-cluster.mongodb.net/prod',
      mongodbUri: 'mongodb://localhost:27017/cliniqo',
      connectionString: 'mongodb+srv://admin:pass@db.example.com',
      db_uri: 'mongodb://app:pwd@10.0.0.1:27017/cliniqo',
      safeField: 'normal-value',
    };

    const redacted = redactSensitiveData(raw) as any;
    expect(redacted.mongodb_uri).toBe('[REDACTED]');
    expect(redacted.mongodbUri).toBe('[REDACTED]');
    expect(redacted.connectionString).toBe('[REDACTED]');
    expect(redacted.db_uri).toBe('[REDACTED]');
    expect(redacted.safeField).toBe('normal-value');
  });

  it('should redact raw MongoDB URI strings and embedded credentials', () => {
    const rawString =
      'Failed to connect to mongodb+srv://dr_smith:mySecretKey99@cliniqo.abcde.mongodb.net/cliniqo?retryWrites=true';
    const redacted = redactSensitiveData(rawString);
    expect(redacted).toBe('Failed to connect to [REDACTED_MONGODB_URI]');
    expect(redacted).not.toContain('mySecretKey99');
    expect(redacted).not.toContain('cliniqo.abcde.mongodb.net');
  });

  it('should redact MongoDB URIs in Error instances', () => {
    const error = new Error(
      'Connection failed: mongodb://admin:pass@127.0.0.1:27017/test?authSource=admin',
    );
    const redacted = redactSensitiveData(error) as any;
    expect(redacted.message).toBe('Connection failed: [REDACTED_MONGODB_URI]');
    expect(redacted.message).not.toContain('admin:pass');
  });
});
