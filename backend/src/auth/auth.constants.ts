/**
 * Authentication Constants & Enums for Cliniqo
 */

export enum DoctorStatus {
  /** Account is registered but awaiting email or administrative verification */
  PENDING_VERIFICATION = "pending_verification",
  /** Account is active and authorized to authenticate */
  ACTIVE = "active",
  /** Account has been administratively disabled; all sessions revoked */
  DISABLED = "disabled",
  /** Account temporarily locked due to excessive failed login attempts */
  LOCKED = "locked",
}

export const AUTH_DEFAULTS = {
  ARGON2_MEMORY_COST: 65536, // 64 MB
  ARGON2_TIME_COST: 3, // 3 iterations
  ARGON2_PARALLELISM: 4, // 4 threads
  JWT_ACCESS_EXPIRES_IN: "15m",
  JWT_REFRESH_EXPIRES_IN: "7d",
  PASSWORD_MIN_LENGTH: 10,
  PASSWORD_MAX_LENGTH: 128,
  MAX_FAILED_LOGIN_ATTEMPTS: 5,
  LOCKOUT_DURATION_MINUTES: 15,
} as const
