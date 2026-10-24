import { Injectable, Logger, Optional } from '@nestjs/common';
import * as argon2 from 'argon2';
import { ConfigService } from '../config/config.service.js';
import { AUTH_DEFAULTS } from './auth.constants.js';

export interface PasswordHashOptions {
  memoryCost?: number;
  timeCost?: number;
  parallelism?: number;
}

@Injectable()
export class PasswordService {
  private readonly logger = new Logger(PasswordService.name);
  private readonly memoryCost: number;
  private readonly timeCost: number;
  private readonly parallelism: number;

  constructor(@Optional() private readonly configService?: ConfigService) {
    this.memoryCost =
      this.configService?.argon2MemoryCost ?? AUTH_DEFAULTS.ARGON2_MEMORY_COST;
    this.timeCost =
      this.configService?.argon2TimeCost ?? AUTH_DEFAULTS.ARGON2_TIME_COST;
    this.parallelism =
      this.configService?.argon2Parallelism ?? AUTH_DEFAULTS.ARGON2_PARALLELISM;
  }

  /**
   * Hashes a plaintext password using Argon2id with RFC 9106 recommended parameters.
   * Throws an error if input is empty, non-string, or exceeds maximum safe length (1024 chars).
   */
  async hashPassword(
    password: string,
    options?: PasswordHashOptions,
  ): Promise<string> {
    if (typeof password !== 'string' || password.length === 0) {
      throw new Error('Password must be a non-empty string.');
    }

    if (password.length > 1024) {
      throw new Error(
        'Password exceeds maximum allowed length of 1024 characters.',
      );
    }

    const memoryCost = options?.memoryCost ?? this.memoryCost;
    const timeCost = options?.timeCost ?? this.timeCost;
    const parallelism = options?.parallelism ?? this.parallelism;

    return argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost,
      timeCost,
      parallelism,
    });
  }

  /**
   * Verifies a plaintext password against an Argon2id hash.
   * Returns false safely for malformed, corrupted, empty, or mismatched hashes without throwing.
   */
  async verifyPassword(hash: string, plaintext: string): Promise<boolean> {
    if (
      typeof hash !== 'string' ||
      typeof plaintext !== 'string' ||
      hash.length === 0 ||
      plaintext.length === 0
    ) {
      return false;
    }

    // Fast-path sanity check for Argon2 PHC format
    if (!hash.startsWith('$argon2')) {
      return false;
    }

    try {
      return await argon2.verify(hash, plaintext);
    } catch {
      // In case of corrupted salt or malformed hash format, fail safely
      return false;
    }
  }

  /**
   * Checks whether a hash was generated using outdated Argon2 parameters.
   */
  needsRehash(hash: string, options?: PasswordHashOptions): boolean {
    if (typeof hash !== 'string' || !hash.startsWith('$argon2')) {
      return true;
    }

    const memoryCost = options?.memoryCost ?? this.memoryCost;
    const timeCost = options?.timeCost ?? this.timeCost;

    try {
      return argon2.needsRehash(hash, {
        memoryCost,
        timeCost,
      });
    } catch {
      return true;
    }
  }
}
