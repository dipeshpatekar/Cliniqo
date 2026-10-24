export interface AppConfig {
  nodeEnv: string;
  port: number;
  corsOrigin: string;
  mongodbUri?: string;
  mongodbDbName?: string;
  jwtAccessSecret?: string;
  jwtRefreshSecret?: string;
  jwtAccessExpiresIn?: string;
  jwtRefreshExpiresIn?: string;
  argon2MemoryCost?: number;
  argon2TimeCost?: number;
  argon2Parallelism?: number;
}

export interface AuthConfig {
  jwtAccessSecret: string;
  jwtRefreshSecret: string;
  jwtAccessExpiresIn: string;
  jwtRefreshExpiresIn: string;
  argon2MemoryCost: number;
  argon2TimeCost: number;
  argon2Parallelism: number;
}

const VALID_DB_NAME_REGEX = /^[a-zA-Z0-9_-]{1,63}$/;
const VALID_EXPIRY_REGEX = /^\d+[smhd]$/;
const WEAK_SECRETS = new Set([
  'secret',
  'changeme',
  'password',
  '12345678',
  'default_secret',
  'jwt_secret',
  'test_secret',
]);

export class ConfigService {
  private readonly config: AppConfig;

  constructor(env: Record<string, string | undefined> = process.env) {
    if (
      env === process.env &&
      !process.env.MONGODB_URI &&
      typeof process.loadEnvFile === 'function'
    ) {
      try {
        process.loadEnvFile('.env');
      } catch {
        // Ignore if .env does not exist
      }
    }

    this.config = {
      nodeEnv: env.NODE_ENV || 'development',
      port: parseInt(env.PORT || '3000', 10),
      corsOrigin: env.CORS_ORIGIN || 'http://localhost:8443',
      mongodbUri: env.MONGODB_URI,
      mongodbDbName: env.MONGODB_DB_NAME || 'cliniqo',
      jwtAccessSecret: env.JWT_ACCESS_SECRET,
      jwtRefreshSecret: env.JWT_REFRESH_SECRET,
      jwtAccessExpiresIn: env.JWT_ACCESS_EXPIRES_IN || '15m',
      jwtRefreshExpiresIn: env.JWT_REFRESH_EXPIRES_IN || '7d',
      argon2MemoryCost: env.ARGON2_MEMORY_COST
        ? parseInt(env.ARGON2_MEMORY_COST, 10)
        : 65536,
      argon2TimeCost: env.ARGON2_TIME_COST
        ? parseInt(env.ARGON2_TIME_COST, 10)
        : 3,
      argon2Parallelism: env.ARGON2_PARALLELISM
        ? parseInt(env.ARGON2_PARALLELISM, 10)
        : 4,
    };
  }

  get isProduction(): boolean {
    return this.config.nodeEnv === 'production';
  }

  get isDevelopment(): boolean {
    return this.config.nodeEnv === 'development';
  }

  get isTest(): boolean {
    return this.config.nodeEnv === 'test';
  }

  get port(): number {
    return this.config.port;
  }

  get nodeEnv(): string {
    return this.config.nodeEnv;
  }

  get corsOrigin(): string {
    return this.config.corsOrigin;
  }

  get mongodbUri(): string | undefined {
    return this.config.mongodbUri;
  }

  get mongodbDbName(): string {
    return this.config.mongodbDbName || 'cliniqo';
  }

  get jwtAccessExpiresIn(): string {
    return this.config.jwtAccessExpiresIn || '15m';
  }

  get jwtRefreshExpiresIn(): string {
    return this.config.jwtRefreshExpiresIn || '7d';
  }

  get argon2MemoryCost(): number {
    return this.config.argon2MemoryCost ?? 65536;
  }

  get argon2TimeCost(): number {
    return this.config.argon2TimeCost ?? 3;
  }

  get argon2Parallelism(): number {
    return this.config.argon2Parallelism ?? 4;
  }

  /**
   * Validates database configuration at startup.
   * Fails safely with a sanitized error message without leaking credentials or URIs.
   */
  validateDatabaseConfig(): { uri: string; dbName: string } {
    const uri = this.config.mongodbUri;
    if (!uri || typeof uri !== 'string' || uri.trim() === '') {
      throw new Error(
        'Database configuration error: MONGODB_URI is required and cannot be empty.',
      );
    }

    const trimmedUri = uri.trim();
    if (
      !trimmedUri.startsWith('mongodb://') &&
      !trimmedUri.startsWith('mongodb+srv://')
    ) {
      throw new Error(
        'Database configuration error: MONGODB_URI must begin with mongodb:// or mongodb+srv://',
      );
    }

    const dbName = this.mongodbDbName;
    if (!dbName || !VALID_DB_NAME_REGEX.test(dbName)) {
      throw new Error(
        'Database configuration error: MONGODB_DB_NAME must only contain alphanumeric characters, underscores, and hyphens (1-63 chars).',
      );
    }

    return { uri: trimmedUri, dbName };
  }

  /**
   * Validates authentication configuration fail-closed.
   * Ensures cryptographic secrets meet length/entropy requirements and prevents default/weak secrets.
   */
  validateAuthConfig(): AuthConfig {
    const accessSecret = this.config.jwtAccessSecret;
    const refreshSecret = this.config.jwtRefreshSecret;

    const minSecretLength = this.isProduction ? 32 : 16;

    if (!accessSecret || typeof accessSecret !== 'string') {
      throw new Error(
        `Authentication configuration error: JWT_ACCESS_SECRET is required and must be at least ${minSecretLength} characters.`,
      );
    }

    if (WEAK_SECRETS.has(accessSecret.trim().toLowerCase())) {
      throw new Error(
        'Authentication configuration error: JWT_ACCESS_SECRET cannot use an insecure or default placeholder value.',
      );
    }

    if (accessSecret.trim().length < minSecretLength) {
      throw new Error(
        `Authentication configuration error: JWT_ACCESS_SECRET is required and must be at least ${minSecretLength} characters.`,
      );
    }

    if (!refreshSecret || typeof refreshSecret !== 'string') {
      throw new Error(
        `Authentication configuration error: JWT_REFRESH_SECRET is required and must be at least ${minSecretLength} characters.`,
      );
    }

    if (WEAK_SECRETS.has(refreshSecret.trim().toLowerCase())) {
      throw new Error(
        'Authentication configuration error: JWT_REFRESH_SECRET cannot use an insecure or default placeholder value.',
      );
    }

    if (refreshSecret.trim().length < minSecretLength) {
      throw new Error(
        `Authentication configuration error: JWT_REFRESH_SECRET is required and must be at least ${minSecretLength} characters.`,
      );
    }

    if (accessSecret === refreshSecret) {
      throw new Error(
        'Authentication configuration error: JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be distinct keys.',
      );
    }

    const memoryCost = this.argon2MemoryCost;
    if (isNaN(memoryCost) || memoryCost < 16384 || memoryCost > 1048576) {
      throw new Error(
        'Authentication configuration error: ARGON2_MEMORY_COST must be between 16384 (16MB) and 1048576 (1GB).',
      );
    }

    const timeCost = this.argon2TimeCost;
    if (isNaN(timeCost) || timeCost < 1 || timeCost > 100) {
      throw new Error(
        'Authentication configuration error: ARGON2_TIME_COST must be between 1 and 100.',
      );
    }

    const parallelism = this.argon2Parallelism;
    if (isNaN(parallelism) || parallelism < 1 || parallelism > 64) {
      throw new Error(
        'Authentication configuration error: ARGON2_PARALLELISM must be between 1 and 64.',
      );
    }

    const accessExpiresIn = this.jwtAccessExpiresIn;
    if (!VALID_EXPIRY_REGEX.test(accessExpiresIn)) {
      throw new Error(
        'Authentication configuration error: JWT_ACCESS_EXPIRES_IN must be a valid time span (e.g., 15m, 1h, 7d).',
      );
    }

    const refreshExpiresIn = this.jwtRefreshExpiresIn;
    if (!VALID_EXPIRY_REGEX.test(refreshExpiresIn)) {
      throw new Error(
        'Authentication configuration error: JWT_REFRESH_EXPIRES_IN must be a valid time span (e.g., 15m, 1h, 7d).',
      );
    }

    return {
      jwtAccessSecret: accessSecret.trim(),
      jwtRefreshSecret: refreshSecret.trim(),
      jwtAccessExpiresIn: accessExpiresIn,
      jwtRefreshExpiresIn: refreshExpiresIn,
      argon2MemoryCost: memoryCost,
      argon2TimeCost: timeCost,
      argon2Parallelism: parallelism,
    };
  }
}
