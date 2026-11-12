import { ConflictException, BadRequestException } from "@nestjs/common"
import { DoctorStatus, AUTH_DEFAULTS } from "../auth.constants.js"

export interface CreateDoctorInput {
  email: string
  password: string
  fullName: string
  phone?: string
  licenseNumber?: string
}

export interface DoctorResponse {
  id: string
  email: string
  fullName: string
  status: DoctorStatus
  phone?: string | null
  licenseNumber?: string | null
  createdAt?: Date
  updatedAt?: Date
}

/** RFC 5322 compliant email validation regex pattern */
const EMAIL_REGEX =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/

/**
 * Normalizes and validates an email address.
 * Trims leading/trailing whitespace, converts to lowercase, and asserts valid RFC 5322 format.
 * Throws BadRequestException on invalid input.
 */
export function normalizeEmail(email: unknown): string {
  if (typeof email !== "string") {
    throw new BadRequestException("Email must be a string.")
  }

  const trimmed = email.trim().toLowerCase()

  if (trimmed.length === 0) {
    throw new BadRequestException("Email cannot be empty.")
  }

  if (trimmed.length > 254) {
    throw new BadRequestException(
      "Email address exceeds maximum length of 254 characters.",
    )
  }

  if (!EMAIL_REGEX.test(trimmed)) {
    throw new BadRequestException("Invalid email address format.")
  }

  return trimmed
}

/**
 * Validates a password against Cliniqo's security policy:
 * - Minimum 10 characters, maximum 128 characters
 * - At least one uppercase letter
 * - At least one lowercase letter
 * - At least one digit
 * - At least one special character
 * - No leading or trailing whitespace
 */
export function validatePasswordPolicy(
  password: unknown,
): {
  isValid: boolean
  errors: string[]
} {
  const errors: string[] = []

  if (typeof password !== "string") {
    return { isValid: false, errors: ["Password must be a string."] }
  }

  if (password.length < AUTH_DEFAULTS.PASSWORD_MIN_LENGTH) {
    errors.push(
      `Password must be at least ${AUTH_DEFAULTS.PASSWORD_MIN_LENGTH} characters long.`,
    )
  }

  if (password.length > AUTH_DEFAULTS.PASSWORD_MAX_LENGTH) {
    errors.push(
      `Password cannot exceed ${AUTH_DEFAULTS.PASSWORD_MAX_LENGTH} characters.`,
    )
  }

  if (password !== password.trim()) {
    errors.push("Password cannot begin or end with whitespace.")
  }

  if (!/[A-Z]/.test(password)) {
    errors.push("Password must contain at least one uppercase letter.")
  }

  if (!/[a-z]/.test(password)) {
    errors.push("Password must contain at least one lowercase letter.")
  }

  if (!/[0-9]/.test(password)) {
    errors.push("Password must contain at least one number.")
  }

  if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?~`]/.test(password)) {
    errors.push("Password must contain at least one special character.")
  }

  return {
    isValid: errors.length === 0,
    errors,
  }
}

/**
 * Asserts password policy compliance or throws BadRequestException with generic guidance.
 */
export function assertPasswordPolicy(password: unknown): void {
  const result = validatePasswordPolicy(password)
  if (!result.isValid) {
    throw new BadRequestException(result.errors)
  }
}

/**
 * Checks if a database error is a MongoDB unique index duplicate-key collision (code 11000).
 */
export function isDuplicateKeyError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false
  }
  const err = error as Record<string, any>
  return (
    err.code === 11000 ||
    err.codeName === "DuplicateKey" ||
    Boolean(err.name === "MongoServerError" && err.code === 11000)
  )
}

/**
 * Handles database duplicate-key error safely.
 * Throws a safe, generic ConflictException without exposing MongoDB error internals or schema details.
 */
export function handleDuplicateDoctorError(error: unknown): never {
  if (isDuplicateKeyError(error)) {
    throw new ConflictException(
      "An account with this email address already exists.",
    )
  }
  throw error
}
