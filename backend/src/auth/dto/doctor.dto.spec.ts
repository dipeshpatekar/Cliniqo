import { describe, it, expect } from "vitest"
import { BadRequestException, ConflictException } from "@nestjs/common"
import {
  normalizeEmail,
  validatePasswordPolicy,
  assertPasswordPolicy,
  isDuplicateKeyError,
  handleDuplicateDoctorError,
} from "./doctor.dto.js"

describe("Doctor DTO & Validation Utilities", () => {
  describe("normalizeEmail", () => {
    it("should trim and lowercase valid email addresses", () => {
      expect(normalizeEmail("  Doctor.Smith@Example.COM  ")).toBe(
        "doctor.smith@example.com",
      )
      expect(normalizeEmail("clinic.dr_patel+admin@med-clinic.org")).toBe(
        "clinic.dr_patel+admin@med-clinic.org",
      )
    })

    it("should throw BadRequestException for non-string or empty input", () => {
      expect(() => normalizeEmail("")).toThrow(BadRequestException)
      expect(() => normalizeEmail("   ")).toThrow(BadRequestException)
      expect(() => normalizeEmail(null)).toThrow(BadRequestException)
      expect(() => normalizeEmail(undefined)).toThrow(BadRequestException)
      expect(() => normalizeEmail(12345)).toThrow(BadRequestException)
    })

    it("should throw BadRequestException for invalid email formats", () => {
      expect(() => normalizeEmail("invalid-email")).toThrow(BadRequestException)
      expect(() => normalizeEmail("@missing-user.com")).toThrow(
        BadRequestException,
      )
      expect(() => normalizeEmail("missing-domain@")).toThrow(
        BadRequestException,
      )
      expect(() => normalizeEmail("user@.com")).toThrow(BadRequestException)
      expect(() => normalizeEmail("user name@domain.com")).toThrow(
        BadRequestException,
      )
    })

    it("should reject email addresses exceeding 254 characters", () => {
      const longLocal = "a".repeat(250)
      expect(() => normalizeEmail(`${longLocal}@example.com`)).toThrow(
        BadRequestException,
      )
    })
  })

  describe("validatePasswordPolicy", () => {
    it("should validate and approve compliant strong passwords", () => {
      const result = validatePasswordPolicy("SecureP@ssw0rd2026!")
      expect(result.isValid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    it("should reject passwords shorter than 10 characters", () => {
      const result = validatePasswordPolicy("Sh0rt!a")
      expect(result.isValid).toBe(false)
      expect(result.errors).toContain(
        "Password must be at least 10 characters long.",
      )
    })

    it("should reject passwords longer than 128 characters", () => {
      const longPass = "A1!" + "a".repeat(126)
      const result = validatePasswordPolicy(longPass)
      expect(result.isValid).toBe(false)
      expect(result.errors).toContain("Password cannot exceed 128 characters.")
    })

    it("should reject passwords with leading or trailing whitespace", () => {
      const result = validatePasswordPolicy("  ValidPass123!#  ")
      expect(result.isValid).toBe(false)
      expect(result.errors).toContain(
        "Password cannot begin or end with whitespace.",
      )
    })

    it("should require at least one uppercase letter", () => {
      const result = validatePasswordPolicy("lowercase123!@#")
      expect(result.isValid).toBe(false)
      expect(result.errors).toContain(
        "Password must contain at least one uppercase letter.",
      )
    })

    it("should require at least one lowercase letter", () => {
      const result = validatePasswordPolicy("UPPERCASE123!@#")
      expect(result.isValid).toBe(false)
      expect(result.errors).toContain(
        "Password must contain at least one lowercase letter.",
      )
    })

    it("should require at least one number", () => {
      const result = validatePasswordPolicy("NoNumbersHere!@#")
      expect(result.isValid).toBe(false)
      expect(result.errors).toContain(
        "Password must contain at least one number.",
      )
    })

    it("should require at least one special character", () => {
      const result = validatePasswordPolicy("NoSpecialCharacters123")
      expect(result.isValid).toBe(false)
      expect(result.errors).toContain(
        "Password must contain at least one special character.",
      )
    })

    it("should reject non-string inputs safely", () => {
      const result = validatePasswordPolicy(null)
      expect(result.isValid).toBe(false)
      expect(result.errors).toContain("Password must be a string.")
    })
  })

  describe("assertPasswordPolicy", () => {
    it("should pass silently for compliant passwords", () => {
      expect(() => assertPasswordPolicy("ValidAndCompliant123!")).not.toThrow()
    })

    it("should throw BadRequestException containing errors for non-compliant passwords", () => {
      expect(() => assertPasswordPolicy("weak")).toThrow(BadRequestException)
    })
  })

  describe("isDuplicateKeyError & handleDuplicateDoctorError", () => {
    it("should recognize MongoDB duplicate key error code 11000", () => {
      const mongoError = {
        name: "MongoServerError",
        code: 11000,
        keyPattern: { email: 1 },
        keyValue: { email: "dr_existing@clinic.com" },
        message: "E11000 duplicate key error collection: cliniqo.doctors",
      }

      expect(isDuplicateKeyError(mongoError)).toBe(true)
    })

    it("should return false for other database errors", () => {
      expect(isDuplicateKeyError(new Error("Connection timeout"))).toBe(false)
      expect(isDuplicateKeyError({ code: 12345 })).toBe(false)
      expect(isDuplicateKeyError(null)).toBe(false)
    })

    it("should throw a safe, generic ConflictException on duplicate key error without leaking internal DB details", () => {
      const mongoError = {
        name: "MongoServerError",
        code: 11000,
        keyPattern: { email: 1 },
        keyValue: { email: "dr_existing@clinic.com" },
        message:
          'E11000 duplicate key error collection: cliniqo_prod.doctors index: email_1 dup key: { email: "dr_existing@clinic.com" }',
      }

      expect(() => handleDuplicateDoctorError(mongoError)).toThrow(
        ConflictException,
      )

      try {
        handleDuplicateDoctorError(mongoError)
      } catch (err: any) {
        expect(err.message).toBe(
          "An account with this email address already exists.",
        )
        // Ensure no internal DB details are leaked in exception
        expect(err.message).not.toContain("E11000")
        expect(err.message).not.toContain("cliniqo_prod")
        expect(err.message).not.toContain("email_1")
      }
    })

    it("should rethrow non-duplicate-key errors unmodified", () => {
      const genericError = new Error("Disk full")
      expect(() => handleDuplicateDoctorError(genericError)).toThrow(
        genericError,
      )
    })
  })
})
