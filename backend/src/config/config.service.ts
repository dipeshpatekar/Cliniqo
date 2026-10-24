export interface AppConfig {
  nodeEnv: string;
  port: number;
  corsOrigin: string;
  mongodbUri?: string;
  mongodbDbName?: string;
}

export class ConfigService {
  private readonly config: AppConfig;

  constructor(env: Record<string, string | undefined> = process.env) {
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
}
