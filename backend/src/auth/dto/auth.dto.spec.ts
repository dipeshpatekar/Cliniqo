import { describe, it, expect } from "vitest"
import { validate } from "class-validator"
import { plainToInstance } from "class-transformer"
import {
  LoginDto,
  RefreshTokenDto,
  ForgotPasswordDto,
  VerifyOtpDto,
  ResendOtpDto,
  ResetPasswordDto,
} from "./auth.dto.js"

const createCompliantPassword = () =>
  ["Mock", "Valid", "Pass", "2026", "!"].join("")
const createLoginPassword = () => ["Mock", "Login", "Pass", "123", "!"].join("")

describe("Auth DTOs Runtime Validation", () => {
  describe("LoginDto", () => {
    it("should validate valid login payload", async () => {
      const dto = plainToInstance(LoginDto, {
        email: "dr.smith@clinic.com",
        password: createLoginPassword(),
      })
      const errors = await validate(dto)
      expect(errors).toHaveLength(0)
    })

    it("should reject malformed email address", async () => {
      const dto = plainToInstance(LoginDto, {
        email: "not-an-email",
        password: createLoginPassword(),
      })
      const errors = await validate(dto)
      expect(errors.length).toBeGreaterThan(0)
      expect(errors[0].constraints?.isEmail).toBeDefined()
    })

    it("should reject empty or missing password", async () => {
      const dto = plainToInstance(LoginDto, {
        email: "dr.smith@clinic.com",
        password: "",
      })
      const errors = await validate(dto)
      expect(errors.length).toBeGreaterThan(0)
      expect(errors[0].constraints?.isNotEmpty).toBeDefined()
    })
  })

  describe("RefreshTokenDto", () => {
    it("should validate 64-character hex refresh token", async () => {
      const dto = plainToInstance(RefreshTokenDto, {
        refreshToken: "a".repeat(64),
      })
      const errors = await validate(dto)
      expect(errors).toHaveLength(0)
    })

    it("should reject refresh tokens with invalid length", async () => {
      const dto = plainToInstance(RefreshTokenDto, {
        refreshToken: "short-token",
      })
      const errors = await validate(dto)
      expect(errors.length).toBeGreaterThan(0)
      expect(errors[0].constraints?.isLength).toBeDefined()
    })
  })

  describe("ForgotPasswordDto", () => {
    it("should validate valid email address", async () => {
      const dto = plainToInstance(ForgotPasswordDto, {
        email: "doctor@example.com",
      })
      const errors = await validate(dto)
      expect(errors).toHaveLength(0)
    })

    it("should reject missing or invalid email", async () => {
      const dto = plainToInstance(ForgotPasswordDto, {
        email: "invalid-email",
      })
      const errors = await validate(dto)
      expect(errors.length).toBeGreaterThan(0)
      expect(errors[0].constraints?.isEmail).toBeDefined()
    })
  })

  describe("VerifyOtpDto", () => {
    it("should validate compliant 6-digit numeric OTP and email", async () => {
      const dto = plainToInstance(VerifyOtpDto, {
        email: "doctor@example.com",
        otp: "123456",
      })
      const errors = await validate(dto)
      expect(errors).toHaveLength(0)
    })

    it("should reject OTP with letters or special characters", async () => {
      const dto = plainToInstance(VerifyOtpDto, {
        email: "doctor@example.com",
        otp: "12A45!",
      })
      const errors = await validate(dto)
      expect(errors.length).toBeGreaterThan(0)
      expect(errors[0].constraints?.matches).toBeDefined()
    })

    it("should reject OTP shorter than 6 digits", async () => {
      const dto = plainToInstance(VerifyOtpDto, {
        email: "doctor@example.com",
        otp: "12345",
      })
      const errors = await validate(dto)
      expect(errors.length).toBeGreaterThan(0)
      expect(errors[0].constraints?.isLength).toBeDefined()
    })

    it("should reject OTP longer than 6 digits", async () => {
      const dto = plainToInstance(VerifyOtpDto, {
        email: "doctor@example.com",
        otp: "1234567",
      })
      const errors = await validate(dto)
      expect(errors.length).toBeGreaterThan(0)
      expect(errors[0].constraints?.isLength).toBeDefined()
    })

    it("should reject invalid email", async () => {
      const dto = plainToInstance(VerifyOtpDto, {
        email: "not-an-email",
        otp: "123456",
      })
      const errors = await validate(dto)
      expect(errors.length).toBeGreaterThan(0)
      expect(errors[0].constraints?.isEmail).toBeDefined()
    })
  })

  describe("ResendOtpDto", () => {
    it("should validate valid email address", async () => {
      const dto = plainToInstance(ResendOtpDto, {
        email: "doctor@example.com",
      })
      const errors = await validate(dto)
      expect(errors).toHaveLength(0)
    })

    it("should reject invalid email address", async () => {
      const dto = plainToInstance(ResendOtpDto, {
        email: "not-an-email",
      })
      const errors = await validate(dto)
      expect(errors.length).toBeGreaterThan(0)
      expect(errors[0].constraints?.isEmail).toBeDefined()
    })
  })

  describe("ResetPasswordDto", () => {
    it("should validate compliant 64-char token and strong password", async () => {
      const dto = plainToInstance(ResetPasswordDto, {
        token: "b".repeat(64),
        newPassword: createCompliantPassword(),
      })
      const errors = await validate(dto)
      expect(errors).toHaveLength(0)
    })

    it("should reject weak new password failing complexity requirements", async () => {
      const dto = plainToInstance(ResetPasswordDto, {
        token: "b".repeat(64),
        newPassword: "weak",
      })
      const errors = await validate(dto)
      expect(errors.length).toBeGreaterThan(0)
      expect(errors[0].constraints?.isStrongPassword).toBeDefined()
    })

    it("should reject token that is not 64 characters", async () => {
      const dto = plainToInstance(ResetPasswordDto, {
        token: "invalid-token-length",
        newPassword: createCompliantPassword(),
      })
      const errors = await validate(dto)
      expect(errors.length).toBeGreaterThan(0)
      expect(errors[0].constraints?.isLength).toBeDefined()
    })
  })
})
