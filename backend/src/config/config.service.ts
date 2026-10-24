export interface AppConfig {
  nodeEnv: string;
  port: number;
  corsOrigin: string;
  mongodbUri?: string;
  mongodbDbName?: string;
}

const VALID_DB_NAME_REGEX = /^[a-zA-Z0-9_-]{1,63}$/;

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
}
