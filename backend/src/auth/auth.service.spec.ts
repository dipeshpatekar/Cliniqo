import { describe, it, expect, beforeEach, vi } from "vitest"
import {
  BadRequestException,
  ConflictException,
  HttpException,
} from "@nestjs/common"
import { Types } from "mongoose"
import { AuthService, generateSecureOtp, hashOtp } from "./auth.service.js"
import { ConfigService } from "../config/config.service.js"
import { DoctorStatus } from "./auth.constants.js"

describe("AuthService", () => {
  let authService: AuthService
  let mockDoctorModel: any
  let mockResetModel: any
  let mockPasswordService: any
  let mockTokenService: any
  let mockMailService: any
  let mockRateLimiter: any
  let configService: ConfigService

  beforeEach(() => {
    configService = new ConfigService({
      JWT_ACCESS_EXPIRES_IN: "15m",
      JWT_REFRESH_EXPIRES_IN: "7d",
      RATE_LIMIT_LOGIN_MAX: "5",
      RATE_LIMIT_LOGIN_WINDOW_SEC: "60",
      RATE_LIMIT_RECOVERY_MAX: "3",
      RATE_LIMIT_RECOVERY_WINDOW_SEC: "300",
      OTP_HMAC_SECRET: "test-otp-hmac-server-secret-32-chars-long!",
    })

    const doctorModelFn: any = vi
      .fn()
      .mockImplementation(function (this: any, data: any) {
        Object.assign(this, data, {
          _id: new Types.ObjectId(),
          save: vi.fn().mockResolvedValue(true),
        })
      })
    doctorModelFn.findOne = vi.fn()
    doctorModelFn.findById = vi.fn()
    doctorModelFn.create = vi.fn()
    mockDoctorModel = doctorModelFn

    mockResetModel = {
      create: vi.fn(),
      findOne: vi.fn(),
      updateMany: vi.fn(),
      findOneAndUpdate: vi.fn(),
      updateOne: vi.fn(),
      findById: vi.fn(),
    }

    mockPasswordService = {
      hashPassword: vi.fn(),
      verifyPassword: vi.fn(),
      needsRehash: vi.fn(),
    }

    mockTokenService = {
      generateAccessToken: vi.fn(),
      createRefreshSession: vi.fn(),
      rotateRefreshSession: vi.fn(),
      revokeSession: vi.fn(),
      revokeAllDoctorSessions: vi.fn(),
    }

    mockMailService = {
      sendPasswordResetEmail: vi.fn(),
      sendPasswordResetOtpEmail: vi.fn(),
    }

    mockRateLimiter = {
      assertRateLimit: vi.fn(),
      resetLimit: vi.fn(),
      checkRateLimit: vi.fn().mockResolvedValue({
        allowed: true,
        remaining: 1,
        retryAfterSeconds: 0,
      }),
    }

    authService = new AuthService(
      mockDoctorModel,
      mockResetModel,
      mockPasswordService,
      mockTokenService,
      mockMailService,
      mockRateLimiter,
      configService,
    )
  })

  describe("login", () => {
    const doctorId = new Types.ObjectId()
    const mockDoctor = {
      _id: doctorId,
      email: "dr.jane@clinic.com",
      fullName: "Dr. Jane Doe",
      status: DoctorStatus.ACTIVE,
      passwordHash: "$argon2id$v=19$valid_hash",
      failedLoginAttempts: 0,
      lockUntil: null,
      lastLoginAt: null,
      save: vi.fn(),
    }

    it("should authenticate active doctor with valid credentials and return tokens", async () => {
      mockDoctorModel.findOne.mockReturnValue({
        select: vi.fn().mockResolvedValue(mockDoctor),
      })
      mockPasswordService.verifyPassword.mockResolvedValue(true)
      mockPasswordService.needsRehash.mockReturnValue(false)
      mockTokenService.generateAccessToken.mockResolvedValue("valid-access-jwt")
      mockTokenService.createRefreshSession.mockResolvedValue({
        refreshToken: "a".repeat(64),
      })

      const result = await authService.login({
        email: "  DR.JANE@CLINIC.COM  ",
        password: "ValidPassword123!",
      })

      expect(result.accessToken).toBe("valid-access-jwt")
      expect(result.refreshToken).toBe("a".repeat(64))
      expect(result.tokenType).toBe("Bearer")
      expect(result.doctor.email).toBe("dr.jane@clinic.com")
      expect(mockDoctor.failedLoginAttempts).toBe(0)
      expect(mockDoctor.save).toHaveBeenCalled()
      expect(mockRateLimiter.resetLimit).toHaveBeenCalled()
    })

    it("should run dummy verify and throw generic UnauthorizedException if account does not exist", async () => {
      mockDoctorModel.findOne.mockReturnValue({
        select: vi.fn().mockResolvedValue(null),
      })
      mockPasswordService.verifyPassword.mockResolvedValue(false)

      await expect(
        authService.login({
          email: "nonexistent@clinic.com",
          password: "Password123!",
        }),
      ).rejects.toThrow("Invalid email or password.")

      // Timing defense check
      expect(mockPasswordService.verifyPassword).toHaveBeenCalled()
    })

    it("should increment failedLoginAttempts and throw UnauthorizedException on wrong password", async () => {
      const doc = { ...mockDoctor, failedLoginAttempts: 2, save: vi.fn() }
      mockDoctorModel.findOne.mockReturnValue({
        select: vi.fn().mockResolvedValue(doc),
      })
      mockPasswordService.verifyPassword.mockResolvedValue(false)

      await expect(
        authService.login({
          email: "dr.jane@clinic.com",
          password: "WrongPassword!",
        }),
      ).rejects.toThrow("Invalid email or password.")

      expect(doc.failedLoginAttempts).toBe(3)
      expect(doc.save).toHaveBeenCalled()
    })

    it("should lock account after 5 failed login attempts", async () => {
      const doc = {
        ...mockDoctor,
        failedLoginAttempts: 4,
        status: DoctorStatus.ACTIVE,
        save: vi.fn(),
      }
      mockDoctorModel.findOne.mockReturnValue({
        select: vi.fn().mockResolvedValue(doc),
      })
      mockPasswordService.verifyPassword.mockResolvedValue(false)

      await expect(
        authService.login({
          email: "dr.jane@clinic.com",
          password: "WrongPassword!",
        }),
      ).rejects.toThrow("Invalid email or password.")

      expect(doc.failedLoginAttempts).toBe(5)
      expect(doc.status).toBe(DoctorStatus.LOCKED)
      expect(doc.lockUntil).toBeDefined()
    })

    it("should reject login if account is locked and cool-down period has not expired", async () => {
      const lockedDoc = {
        ...mockDoctor,
        status: DoctorStatus.LOCKED,
        lockUntil: new Date(Date.now() + 10 * 60 * 1000), // Locked for 10 more minutes
      }
      mockDoctorModel.findOne.mockReturnValue({
        select: vi.fn().mockResolvedValue(lockedDoc),
      })

      await expect(
        authService.login({
          email: "dr.jane@clinic.com",
          password: "ValidPassword123!",
        }),
      ).rejects.toThrow("Account is temporarily locked")
    })

    it("should auto-unlock account when lockout period has elapsed", async () => {
      const expiredLockDoc = {
        ...mockDoctor,
        status: DoctorStatus.LOCKED,
        lockUntil: new Date(Date.now() - 1000), // Expired!
        save: vi.fn(),
      }
      mockDoctorModel.findOne.mockReturnValue({
        select: vi.fn().mockResolvedValue(expiredLockDoc),
      })
      mockPasswordService.verifyPassword.mockResolvedValue(true)
      mockPasswordService.needsRehash.mockReturnValue(false)
      mockTokenService.generateAccessToken.mockResolvedValue("new-token")
      mockTokenService.createRefreshSession.mockResolvedValue({
        refreshToken: "b".repeat(64),
      })

      const result = await authService.login({
        email: "dr.jane@clinic.com",
        password: "ValidPassword123!",
      })

      expect(result.accessToken).toBe("new-token")
      expect(expiredLockDoc.status).toBe(DoctorStatus.ACTIVE)
      expect(expiredLockDoc.failedLoginAttempts).toBe(0)
      expect(expiredLockDoc.lockUntil).toBeNull()
    })

    it("should reject login if account is disabled", async () => {
      const disabledDoc = { ...mockDoctor, status: DoctorStatus.DISABLED }
      mockDoctorModel.findOne.mockReturnValue({
        select: vi.fn().mockResolvedValue(disabledDoc),
      })

      await expect(
        authService.login({
          email: "dr.jane@clinic.com",
          password: "ValidPassword123!",
        }),
      ).rejects.toThrow("Account is disabled")
    })

    it("should reject login if account verification is pending", async () => {
      const pendingDoc = {
        ...mockDoctor,
        status: DoctorStatus.PENDING_VERIFICATION,
      }
      mockDoctorModel.findOne.mockReturnValue({
        select: vi.fn().mockResolvedValue(pendingDoc),
      })

      await expect(
        authService.login({
          email: "dr.jane@clinic.com",
          password: "ValidPassword123!",
        }),
      ).rejects.toThrow("Account verification is pending")
    })
  })

  describe("forgotPassword", () => {
    it("should generate cryptographically secure 6-digit OTP, save hash with 5-min expiry, send OTP mail, and return generic response", async () => {
      const doctorId = new Types.ObjectId()
      mockDoctorModel.findOne.mockResolvedValue({
        _id: doctorId,
        email: "doctor@clinic.com",
        status: DoctorStatus.ACTIVE,
      })
      mockResetModel.findOne.mockResolvedValue(null) // No active cooldown
      mockResetModel.updateMany.mockResolvedValue({ modifiedCount: 0 })
      mockResetModel.create.mockResolvedValue({})
      mockMailService.sendPasswordResetOtpEmail.mockResolvedValue(true)

      const result = await authService.forgotPassword({
        email: "doctor@clinic.com",
      })

      expect(result.message).toContain(
        "If an account exists with this email address",
      )
      // Verify both IP-based and per-email rate limiting are asserted
      expect(mockRateLimiter.assertRateLimit).toHaveBeenCalledWith(
        "recovery:ip:unknown-client",
        3,
        300,
      )
      expect(mockRateLimiter.assertRateLimit).toHaveBeenCalledWith(
        "recovery:email:doctor@clinic.com",
        3,
        300,
      )
      expect(mockResetModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          doctorId,
          email: "doctor@clinic.com",
          attempts: 0,
          maxAttempts: 5,
          used: false,
          otpHash: expect.any(String),
          expiresAt: expect.any(Date),
          resendCooldownUntil: expect.any(Date),
        }),
      )

      // Verify OTP is strictly a 6-digit numeric string passed to mailer
      const mailCall = mockMailService.sendPasswordResetOtpEmail.mock.calls[0]
      expect(mailCall[0]).toBe("doctor@clinic.com")
      expect(mailCall[1]).toMatch(/^\d{6}$/)

      // Verify 5-minute expiry (approx 300,000 ms from now)
      const createArgs = mockResetModel.create.mock.calls[0][0]
      const ttlMs = createArgs.expiresAt.getTime() - Date.now()
      expect(ttlMs).toBeGreaterThan(290000)
      expect(ttlMs).toBeLessThanOrEqual(300000)

      // Verify hash stored matches hashOtp(email, rawOtp, secret)
      expect(createArgs.otpHash).toBe(
        hashOtp("doctor@clinic.com", mailCall[1], configService.otpHmacSecret),
      )

      // Verify single-use: prior unused tokens for this doctor are invalidated
      expect(mockResetModel.updateMany).toHaveBeenCalledWith(
        { doctorId, used: false },
        expect.objectContaining({ $set: expect.objectContaining({ used: true }) }),
      )
    })

    it("should enforce resend cooldown if an active OTP was recently issued", async () => {
      const doctorId = new Types.ObjectId()
      mockDoctorModel.findOne.mockResolvedValue({
        _id: doctorId,
        email: "doctor@clinic.com",
        status: DoctorStatus.ACTIVE,
      })
      // Active record with 20 seconds remaining on cooldown
      mockResetModel.findOne.mockResolvedValue({
        doctorId,
        used: false,
        resendCooldownUntil: new Date(Date.now() + 20000),
      })

      await expect(
        authService.forgotPassword({ email: "doctor@clinic.com" }),
      ).rejects.toThrow(HttpException)

      expect(mockResetModel.create).not.toHaveBeenCalled()
      expect(mockMailService.sendPasswordResetOtpEmail).not.toHaveBeenCalled()
    })

    it("should reject concurrent forgotPassword request within cooldown period using atomic rate limiter", async () => {
      const doctorId = new Types.ObjectId()
      mockDoctorModel.findOne.mockResolvedValue({
        _id: doctorId,
        email: "doctor@clinic.com",
        status: DoctorStatus.ACTIVE,
      })
      // Simulate rate limiter reporting cooldown active
      mockRateLimiter.checkRateLimit.mockResolvedValue({
        allowed: false,
        remaining: 0,
        retryAfterSeconds: 25,
      })

      await expect(
        authService.forgotPassword({ email: "doctor@clinic.com" }),
      ).rejects.toThrow(HttpException)

      expect(mockRateLimiter.checkRateLimit).toHaveBeenCalledWith(
        `recovery:cooldown:${doctorId.toString()}`,
        1,
        30,
      )
      expect(mockResetModel.create).not.toHaveBeenCalled()
    })

    it("should log sanitized warning and return generic response when mail delivery returns false", async () => {
      const doctorId = new Types.ObjectId()
      mockDoctorModel.findOne.mockResolvedValue({
        _id: doctorId,
        email: "doctor@clinic.com",
        status: DoctorStatus.ACTIVE,
      })
      mockRateLimiter.checkRateLimit.mockResolvedValue({
        allowed: true,
        remaining: 0,
        retryAfterSeconds: 0,
      })
      mockResetModel.findOne.mockResolvedValue(null)
      mockMailService.sendPasswordResetOtpEmail.mockResolvedValue(false)

      const result = await authService.forgotPassword({
        email: "doctor@clinic.com",
      })

      expect(result.message).toContain(
        "If an account exists with this email address",
      )
      expect(mockResetModel.create).toHaveBeenCalled()
      expect(mockMailService.sendPasswordResetOtpEmail).toHaveBeenCalled()
    })

    it("should return identical generic response for nonexistent doctor without sending email", async () => {
      mockDoctorModel.findOne.mockResolvedValue(null)

      const result = await authService.forgotPassword({
        email: "ghost@clinic.com",
      })

      expect(result.message).toContain(
        "If an account exists with this email address",
      )
      expect(mockResetModel.create).not.toHaveBeenCalled()
      expect(mockMailService.sendPasswordResetOtpEmail).not.toHaveBeenCalled()
    })
  })

  describe("verifyOtp", () => {
    const doctorId = new Types.ObjectId()
    const validEmail = "doctor@clinic.com"
    const validOtp = "729401"
    let validOtpHash: string

    beforeEach(() => {
      validOtpHash = hashOtp(validEmail, validOtp, configService.otpHmacSecret)
    })

    it("should verify valid OTP server-side atomically and issue single-use 64-char resetToken", async () => {
      const resetRecord = {
        _id: new Types.ObjectId(),
        doctorId,
        email: validEmail,
        otpHash: validOtpHash,
        attempts: 0,
        maxAttempts: 5,
        used: false,
        expiresAt: new Date(Date.now() + 240000), // 4 mins remaining
        tokenHash: "preliminary-hash",
        verifiedAt: new Date(),
      }

      mockDoctorModel.findOne.mockResolvedValue({
        _id: doctorId,
        email: validEmail,
        status: DoctorStatus.ACTIVE,
      })
      mockResetModel.findOneAndUpdate.mockResolvedValue(resetRecord)

      const result = await authService.verifyOtp({
        email: validEmail,
        otp: validOtp,
      })

      expect(result.message).toContain("confirmed successfully")
      expect(result.resetToken).toBeDefined()
      expect(result.resetToken).toHaveLength(64)
      expect(mockRateLimiter.assertRateLimit).toHaveBeenCalledWith(
        "verify_otp:ip:unknown-client",
        10,
        300,
      )
      expect(mockRateLimiter.assertRateLimit).toHaveBeenCalledWith(
        `verify_otp:email:${validEmail}`,
        5,
        300,
      )
      expect(mockResetModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          doctorId,
          used: false,
          verifiedAt: null,
          attempts: { $lt: 5 },
          otpHash: validOtpHash,
        }),
        expect.objectContaining({
          $set: expect.objectContaining({
            verifiedAt: expect.any(Date),
          }),
        }),
        expect.objectContaining({
          new: true,
          sort: { createdAt: -1 },
        }),
      )
    })

    it("should reject invalid OTP, atomically increment attempts, and throw BadRequestException", async () => {
      const resetRecord = {
        _id: new Types.ObjectId(),
        doctorId,
        email: validEmail,
        otpHash: validOtpHash,
        attempts: 1,
        maxAttempts: 5,
        used: false,
        expiresAt: new Date(Date.now() + 240000),
      }

      mockDoctorModel.findOne.mockResolvedValue({
        _id: doctorId,
        email: validEmail,
        status: DoctorStatus.ACTIVE,
      })
      // 1st findOneAndUpdate (match on otpHash) returns null (wrong OTP)
      mockResetModel.findOneAndUpdate.mockResolvedValueOnce(null)
      // findOne returns current record
      mockResetModel.findOne.mockReturnValue({
        sort: vi.fn().mockResolvedValue(resetRecord),
      })
      // 2nd findOneAndUpdate ($inc: { attempts: 1 }) returns updated record with attempts: 2
      mockResetModel.findOneAndUpdate.mockResolvedValueOnce({
        ...resetRecord,
        attempts: 2,
      })

      await expect(
        authService.verifyOtp({
          email: validEmail,
          otp: "000000", // Wrong OTP!
        }),
      ).rejects.toThrow("That code is not valid. Check all six digits and try again.")

      expect(mockResetModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          _id: resetRecord._id,
          used: false,
          attempts: { $lt: 5 },
        }),
        { $inc: { attempts: 1 } },
        { new: true },
      )
    })

    it("should permanently invalidate OTP and lock when maximum attempts exceeded", async () => {
      const resetRecord = {
        _id: new Types.ObjectId(),
        doctorId,
        email: validEmail,
        otpHash: validOtpHash,
        attempts: 4, // 5th attempt will exceed maxAttempts
        maxAttempts: 5,
        used: false,
        expiresAt: new Date(Date.now() + 240000),
      }

      mockDoctorModel.findOne.mockResolvedValue({
        _id: doctorId,
        email: validEmail,
        status: DoctorStatus.ACTIVE,
      })
      mockResetModel.findOneAndUpdate.mockResolvedValueOnce(null)
      mockResetModel.findOne.mockReturnValue({
        sort: vi.fn().mockResolvedValue(resetRecord),
      })
      // Increment reaches 5 attempts
      mockResetModel.findOneAndUpdate.mockResolvedValueOnce({
        ...resetRecord,
        attempts: 5,
      })
      mockResetModel.updateOne.mockResolvedValue({ modifiedCount: 1 })

      await expect(
        authService.verifyOtp({
          email: validEmail,
          otp: "999999", // Final wrong guess!
        }),
      ).rejects.toThrow("Resend limit reached. Please wait before requesting another code.")

      expect(mockResetModel.updateOne).toHaveBeenCalledWith(
        { _id: resetRecord._id, used: false },
        expect.objectContaining({ $set: expect.objectContaining({ used: true }) }),
      )
    })

    it("should reject expired OTP (5-minute TTL elapsed)", async () => {
      const expiredRecord = {
        _id: new Types.ObjectId(),
        doctorId,
        email: validEmail,
        otpHash: validOtpHash,
        attempts: 0,
        maxAttempts: 5,
        used: false,
        expiresAt: new Date(Date.now() - 5000), // Expired!
      }

      mockDoctorModel.findOne.mockResolvedValue({
        _id: doctorId,
        email: validEmail,
        status: DoctorStatus.ACTIVE,
      })
      mockResetModel.findOneAndUpdate.mockResolvedValueOnce(null)
      mockResetModel.findOne.mockReturnValue({
        sort: vi.fn().mockResolvedValue(expiredRecord),
      })
      mockResetModel.updateOne.mockResolvedValue({ modifiedCount: 1 })

      await expect(
        authService.verifyOtp({
          email: validEmail,
          otp: validOtp,
        }),
      ).rejects.toThrow("This code has expired. Request a new code to continue.")

      expect(mockResetModel.updateOne).toHaveBeenCalledWith(
        { _id: expiredRecord._id, used: false },
        expect.objectContaining({ $set: expect.objectContaining({ used: true }) }),
      )
    })

    it("should reject reuse of an already used OTP (replay attack protection)", async () => {
      const usedRecord = {
        _id: new Types.ObjectId(),
        doctorId,
        email: validEmail,
        otpHash: validOtpHash,
        used: true, // Already used!
        expiresAt: new Date(Date.now() + 100000),
      }

      mockDoctorModel.findOne.mockResolvedValue({
        _id: doctorId,
        email: validEmail,
        status: DoctorStatus.ACTIVE,
      })
      mockResetModel.findOneAndUpdate.mockResolvedValueOnce(null)
      mockResetModel.findOne.mockReturnValue({
        sort: vi.fn().mockResolvedValue(usedRecord),
      })

      await expect(
        authService.verifyOtp({
          email: validEmail,
          otp: validOtp,
        }),
      ).rejects.toThrow("This code has already been used. Please request a new code.")
    })

    it("should prevent concurrent OTP verification race conditions (only 1 caller succeeds, 2nd caller rejected)", async () => {
      mockDoctorModel.findOne.mockResolvedValue({
        _id: doctorId,
        email: validEmail,
        status: DoctorStatus.ACTIVE,
      })

      // Caller 1 succeeds atomically
      mockResetModel.findOneAndUpdate.mockResolvedValueOnce({
        _id: new Types.ObjectId(),
        doctorId,
        verifiedAt: new Date(),
      })

      // Caller 2 fails conditional update (null because verifiedAt is already non-null)
      mockResetModel.findOneAndUpdate.mockResolvedValueOnce(null)
      mockResetModel.findOne.mockReturnValue({
        sort: vi.fn().mockResolvedValue({
          doctorId,
          used: false,
          verifiedAt: new Date(), // Already claimed by caller 1!
          expiresAt: new Date(Date.now() + 100000),
        }),
      })

      const [res1, err2] = await Promise.allSettled([
        authService.verifyOtp({ email: validEmail, otp: validOtp }),
        authService.verifyOtp({ email: validEmail, otp: validOtp }),
      ])

      expect(res1.status).toBe("fulfilled")
      if (res1.status === "fulfilled") {
        expect(res1.value.resetToken).toBeDefined()
      }

      expect(err2.status).toBe("rejected")
      if (err2.status === "rejected") {
        expect(err2.reason.message).toBe(
          "This code has already been used. Please request a new code.",
        )
      }
    })
  })

  describe("OTP Cryptographic Helpers", () => {
    it("should generate cryptographically secure 6-digit numeric OTPs", () => {
      for (let i = 0; i < 50; i++) {
        const otp = generateSecureOtp()
        expect(otp).toMatch(/^\d{6}$/)
        const num = parseInt(otp, 10)
        expect(num).toBeGreaterThanOrEqual(100000)
        expect(num).toBeLessThan(1000000)
      }
    })

    it("should compute deterministic server-keyed HMAC-SHA256 hashes", () => {
      const secret = "test-secret-1234567890"
      const hash1 = hashOtp("doctor@clinic.com", "123456", secret)
      const hash2 = hashOtp("DOCTOR@CLINIC.COM", "123456", secret)
      const differentHash = hashOtp("other@clinic.com", "123456", secret)
      const differentSecretHash = hashOtp(
        "doctor@clinic.com",
        "123456",
        "different-secret",
      )

      expect(hash1).toBe(hash2)
      expect(hash1).not.toBe(differentHash)
      expect(hash1).not.toBe(differentSecretHash)
      expect(hash1).toHaveLength(64)
    })

    it("should throw when hashOtp is called without a valid serverSecret", () => {
      expect(() => hashOtp("doctor@clinic.com", "123456", "" as any)).toThrow(
        "OTP hashing error: serverSecret is required and cannot be empty.",
      )
      expect(() => hashOtp("doctor@clinic.com", "123456", undefined as any)).toThrow(
        "OTP hashing error: serverSecret is required and cannot be empty.",
      )
      expect(() => hashOtp("doctor@clinic.com", "123456", "   ")).toThrow(
        "OTP hashing error: serverSecret is required and cannot be empty.",
      )
    })
  })

  describe("resetPassword", () => {
    const doctorId = new Types.ObjectId()

    it("should reset password, mark token used atomically, update hash with Argon2id, and invalidate all doctor sessions", async () => {
      const resetRecord = {
        _id: new Types.ObjectId(),
        doctorId,
        tokenHash: "hash-abc",
        used: true,
        expiresAt: new Date(Date.now() + 600000),
      }

      const doctorDoc = {
        _id: doctorId,
        status: DoctorStatus.LOCKED,
        passwordHash: "old-hash",
        failedLoginAttempts: 5,
        lockUntil: new Date(),
        save: vi.fn(),
      }

      mockResetModel.findOneAndUpdate.mockResolvedValue(resetRecord)
      mockDoctorModel.findById.mockResolvedValue(doctorDoc)
      mockPasswordService.hashPassword.mockResolvedValue(
        "$argon2id$new_secure_hash",
      )
      mockTokenService.revokeAllDoctorSessions.mockResolvedValue(3)

      const result = await authService.resetPassword({
        token: "a".repeat(64),
        newPassword: "BrandNewStrongPassword2026!",
      })

      expect(result.message).toContain("Password has been reset successfully")
      expect(mockRateLimiter.assertRateLimit).toHaveBeenCalledWith(
        "reset:ip:unknown-client",
        3,
        300,
      )
      expect(mockResetModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          used: false,
        }),
        expect.objectContaining({
          $set: expect.objectContaining({ used: true }),
        }),
        { new: true },
      )
      expect(doctorDoc.passwordHash).toBe("$argon2id$new_secure_hash")
      expect(doctorDoc.status).toBe(DoctorStatus.ACTIVE)
      expect(doctorDoc.failedLoginAttempts).toBe(0)
      expect(doctorDoc.lockUntil).toBeNull()
      expect(doctorDoc.save).toHaveBeenCalled()

      // Ensure all active sessions were revoked
      expect(mockTokenService.revokeAllDoctorSessions).toHaveBeenCalledWith(
        doctorId,
      )
    })

    it("should reject reset if token is expired or not found", async () => {
      mockResetModel.findOneAndUpdate.mockResolvedValue(null)

      await expect(
        authService.resetPassword({
          token: "b".repeat(64),
          newPassword: "StrongPassword123!",
        }),
      ).rejects.toThrow("Invalid or expired password reset token.")
    })

    it("should reject reset if token was already used (replay attack)", async () => {
      mockResetModel.findOneAndUpdate.mockResolvedValue(null)

      await expect(
        authService.resetPassword({
          token: "c".repeat(64),
          newPassword: "StrongPassword123!",
        }),
      ).rejects.toThrow("Invalid or expired password reset token.")
    })

    it("should reject reset if new password does not meet complexity requirements", async () => {
      await expect(
        authService.resetPassword({
          token: "d".repeat(64),
          newPassword: "weak",
        }),
      ).rejects.toThrow(BadRequestException)

      expect(mockResetModel.findOneAndUpdate).not.toHaveBeenCalled()
    })

    it("should prevent concurrent reset-token reuse race conditions (only 1 caller succeeds, 2nd caller rejected)", async () => {
      const resetRecord = {
        _id: new Types.ObjectId(),
        doctorId,
        tokenHash: "hash-abc",
        used: true,
        expiresAt: new Date(Date.now() + 600000),
      }

      const doctorDoc = {
        _id: doctorId,
        status: DoctorStatus.ACTIVE,
        passwordHash: "old-hash",
        failedLoginAttempts: 0,
        lockUntil: null,
        save: vi.fn(),
      }

      // Caller 1 matches unused token and consumes it atomically
      mockResetModel.findOneAndUpdate.mockResolvedValueOnce(resetRecord)
      // Caller 2 runs concurrently, token already marked used: false -> returns null
      mockResetModel.findOneAndUpdate.mockResolvedValueOnce(null)

      mockDoctorModel.findById.mockResolvedValue(doctorDoc)
      mockPasswordService.hashPassword.mockResolvedValue("$argon2id$new_hash")
      mockTokenService.revokeAllDoctorSessions.mockResolvedValue(1)

      const [res1, err2] = await Promise.allSettled([
        authService.resetPassword({
          token: "e".repeat(64),
          newPassword: "BrandNewStrongPassword2026!",
        }),
        authService.resetPassword({
          token: "e".repeat(64),
          newPassword: "BrandNewStrongPassword2026!",
        }),
      ])

      expect(res1.status).toBe("fulfilled")
      if (res1.status === "fulfilled") {
        expect(res1.value.message).toContain("Password has been reset successfully")
      }

      expect(err2.status).toBe("rejected")
      if (err2.status === "rejected") {
        expect(err2.reason.message).toBe("Invalid or expired password reset token.")
      }
    })
  })

  describe("register", () => {
    it("should register a new active doctor and return access and refresh tokens", async () => {
      mockDoctorModel.findOne.mockResolvedValue(null)
      mockPasswordService.hashPassword.mockResolvedValue("$argon2id$hashed")
      const testDoctorId = new Types.ObjectId()
      mockDoctorModel.mockImplementation(function (this: any, data: any) {
        Object.assign(this, data, {
          _id: testDoctorId,
          save: vi.fn().mockResolvedValue(true),
        })
      })
      mockTokenService.generateAccessToken.mockResolvedValue("registered-jwt")
      mockTokenService.createRefreshSession.mockResolvedValue({
        refreshToken: "b".repeat(64),
      })

      const result = await authService.register({
        fullName: "  Dr. Jane Smith  ",
        email: "  DR.JANE@CLINIC.COM  ",
        password: "ValidPassword123!",
        phone: " 9876543210 ",
      })

      expect(result.accessToken).toBe("registered-jwt")
      expect(result.refreshToken).toBe("b".repeat(64))
      expect(result.doctor.email).toBe("dr.jane@clinic.com")
      expect(result.doctor.fullName).toBe("Dr. Jane Smith")
      expect(result.doctor.status).toBe(DoctorStatus.ACTIVE)
      expect(mockDoctorModel).toHaveBeenCalledWith(
        expect.objectContaining({
          fullName: "Dr. Jane Smith",
          email: "dr.jane@clinic.com",
          phone: "9876543210",
          status: DoctorStatus.ACTIVE,
        }),
      )
    })

    it("should throw ConflictException if an account with the email already exists", async () => {
      mockDoctorModel.findOne.mockResolvedValue({ email: "dr.jane@clinic.com" })

      await expect(
        authService.register({
          fullName: "Dr. Jane Smith",
          email: "dr.jane@clinic.com",
          password: "ValidPassword123!",
        }),
      ).rejects.toThrow(ConflictException)
      expect(mockDoctorModel).not.toHaveBeenCalled()
    })
  })
})
