export interface AppConfig {
  nodeEnv: string
  port: number
  corsOrigin: string
  mongodbUri?: string
  mongodbDbName?: string
  jwtAccessSecret?: string
  jwtRefreshSecret?: string
  jwtAccessExpiresIn?: string
  jwtRefreshExpiresIn?: string
  jwtIssuer?: string
  jwtAudience?: string
  jwtPrivateKey?: string
  jwtPublicKey?: string
  argon2MemoryCost?: number
  argon2TimeCost?: number
  argon2Parallelism?: number
  smtpHost?: string
  smtpPort?: number
  smtpUser?: string
  smtpPass?: string
  smtpFrom?: string
  smtpSecure?: boolean
  rateLimitLoginMax?: number
  rateLimitLoginWindowSec?: number
  rateLimitRecoveryMax?: number
  rateLimitRecoveryWindowSec?: number
  outboxEncryptionKey?: string
  adminDiagnosticKey?: string
  otpHmacSecret?: string
}

export interface AuthConfig {
  jwtAccessSecret: string
  jwtRefreshSecret: string
  jwtAccessExpiresIn: string
  jwtRefreshExpiresIn: string
  jwtIssuer: string
  jwtAudience: string
  argon2MemoryCost: number
  argon2TimeCost: number
  argon2Parallelism: number
  otpHmacSecret?: string
}

export interface SmtpConfig {
  host?: string
  port: number
  user?: string
  pass?: string
  from: string
  secure: boolean
}

export interface RateLimitConfig {
  loginMax: number
  loginWindowSec: number
  recoveryMax: number
  recoveryWindowSec: number
}

const HEX_64_REGEX = /^[0-9a-fA-F]{64}$/
const VALID_DB_NAME_REGEX = /^[a-zA-Z0-9_-]{1,63}$/
const VALID_EXPIRY_REGEX = /^\d+[smhd]$/
const WEAK_SECRETS = new Set([
  "secret",
  "changeme",
  "password",
  "12345678",
  "default_secret",
  "jwt_secret",
  "test_secret",
])

export class ConfigService {
  private readonly config: AppConfig

  constructor(env: Record<string, string | undefined> = process.env) {
    if (
      env === process.env &&
      !process.env.MONGODB_URI &&
      typeof process.loadEnvFile === "function"
    ) {
      try {
        process.loadEnvFile(".env")
      } catch {
        // Ignore if .env does not exist
      }
    }

    const nodeEnv = env.NODE_ENV || "development"
    this.config = {
      nodeEnv,
      port: parseInt(env.PORT || "3000", 10),
      corsOrigin: env.CORS_ORIGIN || "http://localhost:8443",
      mongodbUri: env.MONGODB_URI,
      mongodbDbName:
        env.MONGODB_DB_NAME ||
        (nodeEnv === "production" ? "cliniqo_prod" : "cliniqo_dev"),
      jwtAccessSecret: env.JWT_ACCESS_SECRET,
      jwtRefreshSecret: env.JWT_REFRESH_SECRET,
      jwtAccessExpiresIn: env.JWT_ACCESS_EXPIRES_IN || "15m",
      jwtRefreshExpiresIn: env.JWT_REFRESH_EXPIRES_IN || "7d",
      jwtIssuer: env.JWT_ISSUER || "cliniqo-backend",
      jwtAudience: env.JWT_AUDIENCE || "cliniqo-client",
      jwtPrivateKey: env.JWT_PRIVATE_KEY,
      jwtPublicKey: env.JWT_PUBLIC_KEY,
      argon2MemoryCost: env.ARGON2_MEMORY_COST
        ? parseInt(env.ARGON2_MEMORY_COST, 10)
        : 65536,
      argon2TimeCost: env.ARGON2_TIME_COST
        ? parseInt(env.ARGON2_TIME_COST, 10)
        : 3,
      argon2Parallelism: env.ARGON2_PARALLELISM
        ? parseInt(env.ARGON2_PARALLELISM, 10)
        : 4,
      smtpHost: env.SMTP_HOST,
      smtpPort: env.SMTP_PORT ? parseInt(env.SMTP_PORT, 10) : 587,
      smtpUser: env.SMTP_USER,
      smtpPass: env.SMTP_PASS,
      smtpFrom:
        env.SMTP_FROM ||
        (env.SMTP_USER ? env.SMTP_USER : "noreply@cliniqo.app"),
      smtpSecure:
        env.SMTP_SECURE === "true" ||
        (env.SMTP_PORT === "465" && env.SMTP_SECURE !== "false"),
      rateLimitLoginMax: env.RATE_LIMIT_LOGIN_MAX
        ? parseInt(env.RATE_LIMIT_LOGIN_MAX, 10)
        : 5,
      rateLimitLoginWindowSec: env.RATE_LIMIT_LOGIN_WINDOW_SEC
        ? parseInt(env.RATE_LIMIT_LOGIN_WINDOW_SEC, 10)
        : 60,
      rateLimitRecoveryMax: env.RATE_LIMIT_RECOVERY_MAX
        ? parseInt(env.RATE_LIMIT_RECOVERY_MAX, 10)
        : 3,
      rateLimitRecoveryWindowSec: env.RATE_LIMIT_RECOVERY_WINDOW_SEC
        ? parseInt(env.RATE_LIMIT_RECOVERY_WINDOW_SEC, 10)
        : 300,
      outboxEncryptionKey: env.OUTBOX_ENCRYPTION_KEY,
      adminDiagnosticKey: env.ADMIN_DIAGNOSTIC_KEY,
      otpHmacSecret: env.OTP_HMAC_SECRET,
    }
  }

  get isProduction(): boolean {
    return this.config.nodeEnv === "production"
  }

  get isDevelopment(): boolean {
    return this.config.nodeEnv === "development"
  }

  get isTest(): boolean {
    return this.config.nodeEnv === "test"
  }

  get port(): number {
    return this.config.port
  }

  get nodeEnv(): string {
    return this.config.nodeEnv
  }

  get corsOrigin(): string {
    return this.config.corsOrigin
  }

  get corsOrigins(): string[] {
    const raw = this.config.corsOrigin || ""
    const configured = raw
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean)

    const standardOrigins = [
      "http://localhost:8443",
      "http://127.0.0.1:8443",
      "http://tauri.localhost",
      "https://tauri.localhost",
      "tauri://localhost",
    ]

    for (const origin of standardOrigins) {
      if (!configured.includes(origin)) {
        configured.push(origin)
      }
    }

    return configured
  }

  get mongodbUri(): string | undefined {
    return this.config.mongodbUri
  }

  get mongodbDbName(): string {
    return this.config.mongodbDbName || "cliniqo_prod"
  }

  get adminDiagnosticKey(): string | undefined {
    return this.config.adminDiagnosticKey
  }

  get jwtAccessExpiresIn(): string {
    return this.config.jwtAccessExpiresIn || "15m"
  }

  get jwtRefreshExpiresIn(): string {
    return this.config.jwtRefreshExpiresIn || "7d"
  }

  get jwtIssuer(): string {
    return this.config.jwtIssuer || "cliniqo-backend"
  }

  get jwtAudience(): string {
    return this.config.jwtAudience || "cliniqo-client"
  }

  get jwtPrivateKey(): string | undefined {
    return this.config.jwtPrivateKey
  }

  get jwtPublicKey(): string | undefined {
    return this.config.jwtPublicKey
  }

  get argon2MemoryCost(): number {
    return this.config.argon2MemoryCost ?? 65536
  }

  get argon2TimeCost(): number {
    return this.config.argon2TimeCost ?? 3
  }

  get argon2Parallelism(): number {
    return this.config.argon2Parallelism ?? 4
  }

  get otpHmacSecret(): string {
    const secret = this.config.otpHmacSecret
    if (!secret || typeof secret !== "string" || secret.trim() === "") {
      throw new Error(
        "Authentication configuration error: OTP_HMAC_SECRET is required from environment configuration.",
      )
    }
    return secret.trim()
  }

  get smtpConfig(): SmtpConfig {
    return {
      host: this.config.smtpHost,
      port: this.config.smtpPort ?? 587,
      user: this.config.smtpUser,
      pass: this.config.smtpPass,
      from: this.config.smtpFrom || "noreply@cliniqo.app",
      secure: Boolean(this.config.smtpSecure),
    }
  }

  get isSmtpConfigured(): boolean {
    return Boolean(this.config.smtpHost && this.config.smtpHost.trim() !== "")
  }

  get rateLimitConfig(): RateLimitConfig {
    return {
      loginMax: this.config.rateLimitLoginMax ?? 5,
      loginWindowSec: this.config.rateLimitLoginWindowSec ?? 60,
      recoveryMax: this.config.rateLimitRecoveryMax ?? 3,
      recoveryWindowSec: this.config.rateLimitRecoveryWindowSec ?? 300,
    }
  }

  /**
   * Validates database configuration at startup.
   * Fails safely with a sanitized error message without leaking credentials or URIs.
   */
  validateDatabaseConfig(): { uri: string; dbName: string } {
    const uri = this.config.mongodbUri
    if (!uri || typeof uri !== "string" || uri.trim() === "") {
      throw new Error(
        "Database configuration error: MONGODB_URI is required and cannot be empty.",
      )
    }

    const trimmedUri = uri.trim()
    if (
      !trimmedUri.startsWith("mongodb://") &&
      !trimmedUri.startsWith("mongodb+srv://")
    ) {
      throw new Error(
        "Database configuration error: MONGODB_URI must begin with mongodb:// or mongodb+srv://",
      )
    }

    const dbName = this.mongodbDbName
    if (!dbName || !VALID_DB_NAME_REGEX.test(dbName)) {
      throw new Error(
        "Database configuration error: MONGODB_DB_NAME must only contain alphanumeric characters, underscores, and hyphens (1-63 chars).",
      )
    }

    // Detect if URI contains a database path that conflicts with dbName
    const uriPathMatch = trimmedUri.match(
      /(?:mongodb(?:\+srv)?:\/\/[^/?#]+)\/([^?#]+)/,
    )
    const uriPathDb = uriPathMatch ? uriPathMatch[1].trim() : null
    if (uriPathDb && uriPathDb !== dbName) {
      throw new Error(
        `Database configuration error: URI database path ("${uriPathDb}") conflicts with MONGODB_DB_NAME ("${dbName}"). Ensure both specify the same database name.`,
      )
    }

    // Fail-safe: Strict environment database isolation
    if (this.isProduction) {
      if (dbName !== "cliniqo_prod") {
        throw new Error(
          `Database configuration error: Database "${dbName}" is not permitted in production mode. Authoritative production database is strictly "cliniqo_prod".`,
        )
      }
    } else if (this.isDevelopment) {
      if (dbName === "cliniqo_prod") {
        throw new Error(
          'Database configuration error: Production database "cliniqo_prod" cannot be selected in development mode. Development must use "cliniqo_dev" or an explicitly configured local development database.',
        )
      }
      const isPermittedDevDb =
        dbName === "cliniqo_dev" ||
        dbName === "cliniqo_test" ||
        dbName.startsWith("cliniqo_dev_") ||
        dbName.startsWith("cliniqo_test_") ||
        dbName.startsWith("cliniqo_local_")
      if (!isPermittedDevDb) {
        throw new Error(
          `Database configuration error: Database "${dbName}" is not permitted in development mode. Allowed databases are "cliniqo_dev", "cliniqo_test", or local development databases.`,
        )
      }
    }

    return { uri: trimmedUri, dbName }
  }

  /**
   * Validates authentication configuration fail-closed.
   * Ensures cryptographic secrets meet length/entropy requirements and prevents default/weak secrets.
   */
  validateAuthConfig(): AuthConfig {
    const accessSecret = this.config.jwtAccessSecret
    const refreshSecret = this.config.jwtRefreshSecret

    const minSecretLength = this.isProduction ? 32 : 16

    if (!accessSecret || typeof accessSecret !== "string") {
      throw new Error(
        `Authentication configuration error: JWT_ACCESS_SECRET is required and must be at least ${minSecretLength} characters.`,
      )
    }

    if (WEAK_SECRETS.has(accessSecret.trim().toLowerCase())) {
      throw new Error(
        "Authentication configuration error: JWT_ACCESS_SECRET cannot use an insecure or default placeholder value.",
      )
    }

    if (accessSecret.trim().length < minSecretLength) {
      throw new Error(
        `Authentication configuration error: JWT_ACCESS_SECRET is required and must be at least ${minSecretLength} characters.`,
      )
    }

    if (!refreshSecret || typeof refreshSecret !== "string") {
      throw new Error(
        `Authentication configuration error: JWT_REFRESH_SECRET is required and must be at least ${minSecretLength} characters.`,
      )
    }

    if (WEAK_SECRETS.has(refreshSecret.trim().toLowerCase())) {
      throw new Error(
        "Authentication configuration error: JWT_REFRESH_SECRET cannot use an insecure or default placeholder value.",
      )
    }

    if (refreshSecret.trim().length < minSecretLength) {
      throw new Error(
        `Authentication configuration error: JWT_REFRESH_SECRET is required and must be at least ${minSecretLength} characters.`,
      )
    }

    if (accessSecret === refreshSecret) {
      throw new Error(
        "Authentication configuration error: JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be distinct keys.",
      )
    }

    const memoryCost = this.argon2MemoryCost
    if (isNaN(memoryCost) || memoryCost < 16384 || memoryCost > 1048576) {
      throw new Error(
        "Authentication configuration error: ARGON2_MEMORY_COST must be between 16384 (16MB) and 1048576 (1GB).",
      )
    }

    const timeCost = this.argon2TimeCost
    if (isNaN(timeCost) || timeCost < 1 || timeCost > 100) {
      throw new Error(
        "Authentication configuration error: ARGON2_TIME_COST must be between 1 and 100.",
      )
    }

    const parallelism = this.argon2Parallelism
    if (isNaN(parallelism) || parallelism < 1 || parallelism > 64) {
      throw new Error(
        "Authentication configuration error: ARGON2_PARALLELISM must be between 1 and 64.",
      )
    }

    const accessExpiresIn = this.jwtAccessExpiresIn
    if (!VALID_EXPIRY_REGEX.test(accessExpiresIn)) {
      throw new Error(
        "Authentication configuration error: JWT_ACCESS_EXPIRES_IN must be a valid time span (e.g., 15m, 1h, 7d).",
      )
    }

    const refreshExpiresIn = this.jwtRefreshExpiresIn
    if (!VALID_EXPIRY_REGEX.test(refreshExpiresIn)) {
      throw new Error(
        "Authentication configuration error: JWT_REFRESH_EXPIRES_IN must be a valid time span (e.g., 15m, 1h, 7d).",
      )
    }

    const otpHmacSecret = this.config.otpHmacSecret
    if (this.isProduction) {
      if (
        !otpHmacSecret ||
        typeof otpHmacSecret !== "string" ||
        otpHmacSecret.trim().length < 32
      ) {
        throw new Error(
          "Authentication configuration error: OTP_HMAC_SECRET is required and must be at least 32 characters in production.",
        )
      }
      if (WEAK_SECRETS.has(otpHmacSecret.trim().toLowerCase())) {
        throw new Error(
          "Authentication configuration error: OTP_HMAC_SECRET cannot use an insecure or placeholder value.",
        )
      }
      if (
        otpHmacSecret === accessSecret ||
        otpHmacSecret === refreshSecret
      ) {
        throw new Error(
          "Authentication configuration error: OTP_HMAC_SECRET must be distinct from JWT secrets.",
        )
      }
      if (!this.config.jwtPrivateKey || !this.config.jwtPublicKey) {
        throw new Error(
          "Authentication configuration error: JWT_PRIVATE_KEY and JWT_PUBLIC_KEY are required in production for RS256 desktop verification.",
        )
      }
    } else if (otpHmacSecret && typeof otpHmacSecret === "string") {
      if (WEAK_SECRETS.has(otpHmacSecret.trim().toLowerCase())) {
        throw new Error(
          "Authentication configuration error: OTP_HMAC_SECRET cannot use an insecure or placeholder value.",
        )
      }
      if (
        otpHmacSecret === accessSecret ||
        otpHmacSecret === refreshSecret
      ) {
        throw new Error(
          "Authentication configuration error: OTP_HMAC_SECRET must be distinct from JWT secrets.",
        )
      }
    }

    return {
      jwtAccessSecret: accessSecret.trim(),
      jwtRefreshSecret: refreshSecret.trim(),
      jwtAccessExpiresIn: accessExpiresIn,
      jwtRefreshExpiresIn: refreshExpiresIn,
      jwtIssuer: this.jwtIssuer,
      jwtAudience: this.jwtAudience,
      argon2MemoryCost: memoryCost,
      argon2TimeCost: timeCost,
      argon2Parallelism: parallelism,
      otpHmacSecret: otpHmacSecret ? otpHmacSecret.trim() : undefined,
    }
  }

  get outboxEncryptionKey(): string | undefined {
    return this.config.outboxEncryptionKey
  }

  /**
   * Validates OUTBOX_ENCRYPTION_KEY fail-closed.
   * Requires a 256-bit cryptographic key formatted as exactly 64 hexadecimal characters.
   */
  validateOutboxConfig(): Buffer {
    const key = this.config.outboxEncryptionKey
    if (!key || typeof key !== "string" || !HEX_64_REGEX.test(key.trim())) {
      throw new Error(
        "Configuration error: OUTBOX_ENCRYPTION_KEY is required and must be a 256-bit key represented as exactly 64 hexadecimal characters. Generate one with: openssl rand -hex 32",
      )
    }
    return Buffer.from(key.trim(), "hex")
  }

  /**
   * Validates SMTP configuration fail-closed.
   * Ensures Gmail SMTP host, port, user and app password meet requirements.
   */
  validateSmtpConfig(): SmtpConfig | null {
    if (!this.config.smtpHost || this.config.smtpHost.trim() === "") {
      if (this.isProduction) {
        throw new Error(
          "SMTP configuration error: SMTP_HOST is required in production environment.",
        )
      }
      return null
    }

    const host = this.config.smtpHost.trim()
    const port = this.config.smtpPort ?? 587
    if (isNaN(port) || port <= 0 || port > 65535) {
      throw new Error(
        `SMTP configuration error: SMTP_PORT must be a valid port number, got ${this.config.smtpPort}.`,
      )
    }

    const user = this.config.smtpUser?.trim()
    if (!user) {
      throw new Error(
        "SMTP configuration error: SMTP_USER is required when SMTP_HOST is configured.",
      )
    }

    const pass = this.config.smtpPass?.trim()
    if (!pass) {
      throw new Error(
        "SMTP configuration error: SMTP_PASS (Gmail App Password) is required when SMTP_HOST is configured.",
      )
    }

    const from =
      this.config.smtpFrom?.trim() || (user ? `Cliniqo <${user}>` : "noreply@cliniqo.app")
    const secure = Boolean(this.config.smtpSecure)

    return {
      host,
      port,
      user,
      pass,
      from,
      secure,
    }
  }
}
