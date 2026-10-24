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
});
