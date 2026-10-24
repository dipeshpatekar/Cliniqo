import { describe, it, expect } from 'vitest';
import { PasswordService } from './password.service.js';
import { ConfigService } from '../config/config.service.js';

describe('PasswordService', () => {
  it('should hash a password using Argon2id', async () => {
    const service = new PasswordService();
    const hash = await service.hashPassword('SuperSecret123!');

    expect(hash).toBeDefined();
    expect(hash.startsWith('$argon2id$')).toBe(true);
    // RFC 9106 recommended parameters check in PHC format string
    expect(hash).toContain('m=65536');
    expect(hash).toContain('t=3');
    expect(hash).toContain('p=4');
  });

  it('should prove password hash differs from plaintext', async () => {
    const service = new PasswordService();
    const plaintext = 'DrSmithClinic2026!';
    const hash = await service.hashPassword(plaintext);

    expect(hash).not.toBe(plaintext);
    expect(hash).not.toContain(plaintext);
  });

  it('should generate distinct hashes for the same password due to unique salting', async () => {
    const service = new PasswordService();
    const password = 'IdenticalPassword123#';

    const hash1 = await service.hashPassword(password);
    const hash2 = await service.hashPassword(password);

    expect(hash1).not.toBe(hash2);
    expect(await service.verifyPassword(hash1, password)).toBe(true);
    expect(await service.verifyPassword(hash2, password)).toBe(true);
  });

  it('should verify password successfully only for the correct plaintext', async () => {
    const service = new PasswordService();
    const password = 'CorrectHorseBatteryStaple99!';
    const hash = await service.hashPassword(password);

    expect(await service.verifyPassword(hash, password)).toBe(true);
    expect(await service.verifyPassword(hash, 'WrongPassword123!')).toBe(false);
    expect(await service.verifyPassword(hash, password.toLowerCase())).toBe(
      false,
    );
  });

  it('should fail verification safely without throwing when given invalid inputs', async () => {
    const service = new PasswordService();
    const validHash = await service.hashPassword('ValidPassword123!');

    expect(await service.verifyPassword('', 'somePassword')).toBe(false);
    expect(await service.verifyPassword(validHash, '')).toBe(false);
    expect(
      await service.verifyPassword(
        'not-a-valid-argon2-hash',
        'ValidPassword123!',
      ),
    ).toBe(false);
    expect(
      await service.verifyPassword(
        '$argon2id$v=19$m=65536,t=3,p=4$corrupted_salt$corrupted_hash',
        'ValidPassword123!',
      ),
    ).toBe(false);
  });

  it('should reject invalid password inputs during hashing', async () => {
    const service = new PasswordService();

    await expect(service.hashPassword('')).rejects.toThrow(
      'Password must be a non-empty string.',
    );
    await expect(service.hashPassword(null as any)).rejects.toThrow(
      'Password must be a non-empty string.',
    );
    await expect(service.hashPassword('a'.repeat(1025))).rejects.toThrow(
      'Password exceeds maximum allowed length of 1024 characters.',
    );
  });

  it('should allow configurable Argon2 options via ConfigService', async () => {
    const mockConfig = new ConfigService({
      ARGON2_MEMORY_COST: '32768',
      ARGON2_TIME_COST: '2',
      ARGON2_PARALLELISM: '2',
    });

    const service = new PasswordService(mockConfig);
    const hash = await service.hashPassword('ConfigurablePassword1!');

    expect(hash).toContain('m=32768');
    expect(hash).toContain('t=2');
    expect(hash).toContain('p=2');
    expect(await service.verifyPassword(hash, 'ConfigurablePassword1!')).toBe(
      true,
    );
  });

  it('should check if hash needs rehash when parameters change', async () => {
    const service = new PasswordService();
    const lowCostHash = await service.hashPassword('LegacyPassword123!', {
      memoryCost: 16384,
      timeCost: 1,
    });

    expect(service.needsRehash(lowCostHash)).toBe(true);

    const standardHash = await service.hashPassword('CurrentPassword123!');
    expect(service.needsRehash(standardHash)).toBe(false);
  });
});
