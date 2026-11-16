import { describe, it, expect, beforeEach, vi } from "vitest"
import { UnauthorizedException } from "@nestjs/common"
import { JwtService } from "@nestjs/jwt"
import { Types } from "mongoose"
import crypto from "node:crypto"
import {
  TokenService,
  hashOpaqueToken,
  parseDurationMs,
  normalizePemKey,
} from "./token.service.js"
import { ConfigService } from "../config/config.service.js"
import { DoctorStatus, SessionType } from "./auth.constants.js"

describe("TokenService", () => {
  let tokenService: TokenService
  let jwtService: JwtService
  let configService: ConfigService
  let mockSessionModel: any
  let mockDoctorModel: any

  const validAccessSecret = "a".repeat(32)
  const validRefreshSecret = "b".repeat(32)

  beforeEach(() => {
    configService = new ConfigService({
      NODE_ENV: "test",
      JWT_ACCESS_SECRET: validAccessSecret,
      JWT_REFRESH_SECRET: validRefreshSecret,
      JWT_ACCESS_EXPIRES_IN: "15m",
      JWT_REFRESH_EXPIRES_IN: "7d",
      JWT_ISSUER: "cliniqo-backend",
      JWT_AUDIENCE: "cliniqo-client",
    })

    jwtService = new JwtService()

    mockSessionModel = {
      create: vi.fn(),
      findOne: vi.fn(),
      updateMany: vi.fn(),
      updateOne: vi.fn(),
    }

    mockDoctorModel = {
      findById: vi.fn(),
    }

    tokenService = new TokenService(
      jwtService,
      configService,
      mockSessionModel,
      mockDoctorModel,
    )
  })

  describe("parseDurationMs & hashOpaqueToken", () => {
    it("should parse duration strings accurately", () => {
      expect(parseDurationMs("10s")).toBe(10000)
      expect(parseDurationMs("15m")).toBe(15 * 60 * 1000)
      expect(parseDurationMs("2h")).toBe(2 * 60 * 60 * 1000)
      expect(parseDurationMs("7d")).toBe(7 * 24 * 60 * 60 * 1000)
      expect(parseDurationMs("unknown")).toBe(15 * 60 * 1000)
    })

    it("should compute deterministic SHA-256 hash of tokens", () => {
      const hash1 = hashOpaqueToken("test-token")
      const hash2 = hashOpaqueToken("test-token")
      expect(hash1).toBe(hash2)
      expect(hash1).toHaveLength(64)
    })
  })

  describe("AccessToken Generation & Verification", () => {
    const mockDoctor = {
      _id: new Types.ObjectId(),
      email: "dr.smith@clinic.com",
      fullName: "Dr. Jane Smith",
      status: DoctorStatus.ACTIVE,
    }

    it("should generate a valid JWT access token with correct claims", async () => {
      const token = await tokenService.generateAccessToken(mockDoctor)
      expect(token).toBeDefined()

      const payload = await tokenService.verifyAccessToken(token)
      expect(payload.sub).toBe(mockDoctor._id.toString())
      expect(payload.email).toBe(mockDoctor.email)
      expect(payload.fullName).toBe(mockDoctor.fullName)
      expect(payload.status).toBe(DoctorStatus.ACTIVE)
      expect(payload.type).toBe("access")
      expect(payload.iss).toBe("cliniqo-backend")
      expect(payload.aud).toBe("cliniqo-client")
    })

    it("should expose backend public key metadata for desktop client verification", () => {
      const keyInfo = tokenService.getPublicKeyInfo()
      expect(keyInfo.algorithm).toBe("RS256")
      expect(keyInfo.publicKey).toContain("BEGIN PUBLIC KEY")
      expect(keyInfo.issuer).toBe("cliniqo-backend")
      expect(keyInfo.audience).toBe("cliniqo-client")
    })

    it("should fail verification if token is signed with wrong secret (secret separation)", async () => {
      // Sign with refresh secret instead of access secret
      const rogueToken = await jwtService.signAsync(
        { sub: "123", type: "access" },
        {
          secret: validRefreshSecret,
          issuer: "cliniqo-backend",
          audience: "cliniqo-client",
        },
      )

      await expect(tokenService.verifyAccessToken(rogueToken)).rejects.toThrow(
        UnauthorizedException,
      )
    })

    it("should fail verification if token is tampered with", async () => {
      const token = await tokenService.generateAccessToken(mockDoctor)
      const tampered = token.slice(0, -5) + "abcde"

      await expect(tokenService.verifyAccessToken(tampered)).rejects.toThrow(
        UnauthorizedException,
      )
    })

    it("should fail verification if token type is not access", async () => {
      const rogueToken = await jwtService.signAsync(
        { sub: "123", type: "refresh" },
        {
          secret: validAccessSecret,
          issuer: "cliniqo-backend",
          audience: "cliniqo-client",
        },
      )

      await expect(tokenService.verifyAccessToken(rogueToken)).rejects.toThrow(
        "Invalid or expired access token.",
      )
    })
  })

  describe("Refresh Session Lifecycle & Rotation", () => {
    const doctorId = new Types.ObjectId()

    it("should create an opaque refresh session and store only its SHA-256 hash", async () => {
      mockSessionModel.create.mockImplementation(async (data: any) => ({
        ...data,
        _id: new Types.ObjectId(),
      }))

      const { refreshToken, session } =
        await tokenService.createRefreshSession(doctorId)

      expect(refreshToken).toHaveLength(64)
      expect(session.tokenHash).toBe(hashOpaqueToken(refreshToken))
      expect(session.tokenHash).not.toBe(refreshToken)
      expect(session.isRevoked).toBe(false)
      expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now())
    })

    it("should rotate a valid refresh session and issue new access & refresh tokens", async () => {
      const rawOldToken = "c".repeat(64)
      const oldHash = hashOpaqueToken(rawOldToken)
      const familyId = "family-123"

      const mockOldSession = {
        _id: new Types.ObjectId(),
        doctorId,
        tokenHash: oldHash,
        familyId,
        isRevoked: false,
        expiresAt: new Date(Date.now() + 100000),
        save: vi.fn(),
      }

      mockSessionModel.findOne.mockResolvedValue(mockOldSession)
      mockDoctorModel.findById.mockResolvedValue({
        _id: doctorId,
        email: "dr@clinic.com",
        fullName: "Dr. Who",
        status: DoctorStatus.ACTIVE,
      })

      mockSessionModel.create.mockImplementation(async (data: any) => ({
        ...data,
        _id: new Types.ObjectId(),
      }))

      const result = await tokenService.rotateRefreshSession(rawOldToken)

      expect(result.accessToken).toBeDefined()
      expect(result.refreshToken).toBeDefined()
      expect(result.refreshToken).not.toBe(rawOldToken)
      expect(result.tokenType).toBe("Bearer")

      // Old session must be marked revoked
      expect(mockOldSession.isRevoked).toBe(true)
      expect(mockOldSession.save).toHaveBeenCalled()
    })

    it("should detect token replay/reuse and revoke entire session family", async () => {
      const rawReplayedToken = "d".repeat(64)
      const tokenHash = hashOpaqueToken(rawReplayedToken)
      const familyId = "family-compromised"

      const mockReplayedSession = {
        _id: new Types.ObjectId(),
        doctorId,
        tokenHash,
        familyId,
        isRevoked: true, // Already revoked/used!
        expiresAt: new Date(Date.now() + 100000),
      }

      mockSessionModel.findOne.mockResolvedValue(mockReplayedSession)
      mockSessionModel.updateMany.mockResolvedValue({ modifiedCount: 3 })

      await expect(
        tokenService.rotateRefreshSession(rawReplayedToken),
      ).rejects.toThrow(
        "Invalid refresh session. Potential token reuse detected. Please log in again.",
      )

      // Verify all sessions in that family were revoked
      expect(mockSessionModel.updateMany).toHaveBeenCalledWith(
        { familyId, isRevoked: false },
        expect.objectContaining({
          $set: expect.objectContaining({ isRevoked: true }),
        }),
      )
    })

    it("should reject rotation if refresh token is expired", async () => {
      const rawExpiredToken = "e".repeat(64)
      const tokenHash = hashOpaqueToken(rawExpiredToken)

      const mockExpiredSession = {
        _id: new Types.ObjectId(),
        doctorId,
        tokenHash,
        familyId: "family-expired",
        isRevoked: false,
        expiresAt: new Date(Date.now() - 10000), // Expired!
        save: vi.fn(),
      }

      mockSessionModel.findOne.mockResolvedValue(mockExpiredSession)

      await expect(
        tokenService.rotateRefreshSession(rawExpiredToken),
      ).rejects.toThrow("Refresh token has expired. Please log in again.")
      expect(mockExpiredSession.isRevoked).toBe(true)
    })

    it("should revoke a session explicitly on logout", async () => {
      mockSessionModel.updateOne.mockResolvedValue({ modifiedCount: 1 })

      const success = await tokenService.revokeSession("f".repeat(64))
      expect(success).toBe(true)
      expect(mockSessionModel.updateOne).toHaveBeenCalledWith(
        { tokenHash: hashOpaqueToken("f".repeat(64)), isRevoked: false },
        expect.objectContaining({
          $set: expect.objectContaining({ isRevoked: true }),
        }),
      )
    })

    it("should revoke all active sessions for a doctor", async () => {
      mockSessionModel.updateMany.mockResolvedValue({ modifiedCount: 5 })

      const count = await tokenService.revokeAllDoctorSessions(doctorId)
      expect(count).toBe(5)
      expect(mockSessionModel.updateMany).toHaveBeenCalledWith(
        { doctorId, isRevoked: false },
        expect.objectContaining({
          $set: expect.objectContaining({ isRevoked: true }),
        }),
      )
    })

    it("should create DESKTOP_PERSISTENT session with null expiresAt", async () => {
      mockSessionModel.create.mockImplementation((doc: any) => Promise.resolve(doc))

      const { session } = await tokenService.createRefreshSession(
        doctorId,
        undefined,
        undefined,
        {
          sessionType: "DESKTOP_PERSISTENT",
          deviceId: "win-device-uuid-123",
        },
      )

      expect(mockSessionModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionType: "DESKTOP_PERSISTENT",
          deviceId: "win-device-uuid-123",
          expiresAt: null,
          isRevoked: false,
        }),
      )
    })

    it("should allow DESKTOP_PERSISTENT session rotation without arbitrary time expiry", async () => {
      const rawToken = "d".repeat(64)
      const tokenHash = hashOpaqueToken(rawToken)

      const persistentSession: any = {
        doctorId,
        familyId: "fam-persistent-1",
        tokenHash,
        sessionType: "DESKTOP_PERSISTENT",
        deviceId: "win-device-uuid-123",
        isRevoked: false,
        expiresAt: null, // No expiration
        save: vi.fn().mockResolvedValue(true),
      }

      const activeDoctor = {
        _id: doctorId,
        email: "dr@clinic.com",
        fullName: "Dr. Persistent",
        status: DoctorStatus.ACTIVE,
      }

      mockSessionModel.findOne.mockResolvedValue(persistentSession)
      mockDoctorModel.findById.mockResolvedValue(activeDoctor)
      mockSessionModel.create.mockImplementation((doc: any) => Promise.resolve(doc))

      const result = await tokenService.rotateRefreshSession(rawToken, undefined, {
        deviceId: "win-device-uuid-123",
      })

      expect(result.refreshToken).toBeDefined()
      expect(result.accessToken).toBeDefined()
      expect(persistentSession.isRevoked).toBe(true)
      expect(persistentSession.replacedByTokenHash).toBeDefined()

      expect(mockSessionModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          familyId: "fam-persistent-1",
          sessionType: "DESKTOP_PERSISTENT",
          deviceId: "win-device-uuid-123",
          expiresAt: null,
          isRevoked: false,
        }),
      )
    })

    it("should support crash-safe rotation recovery within grace window without revoking family", async () => {
      const rawToken = "e".repeat(64)
      const tokenHash = hashOpaqueToken(rawToken)
      const successorHash = "f".repeat(64)

      // Session was already revoked 10 seconds ago during interrupted rotation
      const revokedSession: any = {
        doctorId,
        familyId: "fam-crash-recovery",
        tokenHash,
        sessionType: "DESKTOP_PERSISTENT",
        deviceId: "win-device-uuid-123",
        isRevoked: true,
        revokedAt: new Date(Date.now() - 10000), // 10 seconds ago (within 60s grace window)
        replacedByTokenHash: successorHash,
      }

      const activeSuccessor: any = {
        doctorId,
        familyId: "fam-crash-recovery",
        tokenHash: successorHash,
        sessionType: "DESKTOP_PERSISTENT",
        deviceId: "win-device-uuid-123",
        isRevoked: false,
        save: vi.fn().mockResolvedValue(true),
      }

      const activeDoctor = {
        _id: doctorId,
        email: "dr@clinic.com",
        fullName: "Dr. Recovered",
        status: DoctorStatus.ACTIVE,
      }

      mockSessionModel.findOne
        .mockResolvedValueOnce(revokedSession) // lookup of incoming old token
        .mockResolvedValueOnce(activeSuccessor) // lookup of linked successor token

      mockDoctorModel.findById.mockResolvedValue(activeDoctor)
      mockSessionModel.create.mockImplementation((doc: any) => Promise.resolve(doc))

      // Client retries with old token after crash
      const recovered = await tokenService.rotateRefreshSession(rawToken, undefined, {
        deviceId: "win-device-uuid-123",
      })

      expect(recovered.refreshToken).toBeDefined()
      expect(recovered.accessToken).toBeDefined()
      // Family was NOT revoked!
      expect(mockSessionModel.updateMany).not.toHaveBeenCalled()
    })

    it("should trigger genuine token reuse detection outside grace window and revoke entire family", async () => {
      const rawToken = "a".repeat(64)
      const tokenHash = hashOpaqueToken(rawToken)

      const ancientRevokedSession: any = {
        doctorId,
        familyId: "fam-attack-detected",
        tokenHash,
        sessionType: "DESKTOP_PERSISTENT",
        deviceId: "win-device-uuid-123",
        isRevoked: true,
        revokedAt: new Date(Date.now() - 500000), // 500 seconds ago (outside 60s grace window)
        replacedByTokenHash: "some-other-hash",
      }

      mockSessionModel.findOne.mockResolvedValue(ancientRevokedSession)

      await expect(
        tokenService.rotateRefreshSession(rawToken, undefined, {
          deviceId: "win-device-uuid-123",
        }),
      ).rejects.toThrow("Potential token reuse detected. Please log in again.")

      expect(mockSessionModel.updateMany).toHaveBeenCalledWith(
        { familyId: "fam-attack-detected", isRevoked: false },
        expect.objectContaining({
          $set: expect.objectContaining({ isRevoked: true }),
        }),
      )
    })

    it("should revoke device-specific sessions on demand", async () => {
      mockSessionModel.updateMany.mockResolvedValue({ modifiedCount: 2 })

      const count = await tokenService.revokeDeviceSessions(doctorId, "device-to-revoke")
      expect(count).toBe(2)
      expect(mockSessionModel.updateMany).toHaveBeenCalledWith(
        { doctorId, deviceId: "device-to-revoke", isRevoked: false },
        expect.objectContaining({
          $set: expect.objectContaining({ isRevoked: true }),
        }),
      )
    })

    describe("Crash-Safe Idempotency & Fault Injection Recovery", () => {
      const testDeviceId = "win-desktop-device-exact-1"
      const testIdempotencyKey = "client-retry-idempotency-key-xyz"

      it("should recover the exact replacement token on repeated retries with same idempotencyKey without revoking family", async () => {
        const initialToken = "c".repeat(64)
        const initialHash = hashOpaqueToken(initialToken)

        let savedOldSession: any = null
        let createdSuccessor: any = null

        const activeDoctor = {
          _id: doctorId,
          email: "dr@clinic.com",
          fullName: "Dr. Reliable",
          status: DoctorStatus.ACTIVE,
        }
        mockDoctorModel.findById.mockResolvedValue(activeDoctor)

        // 1. Initial rotation with idempotencyKey
        const initialActiveSession: any = {
          doctorId,
          familyId: "fam-idempotency",
          tokenHash: initialHash,
          sessionType: "DESKTOP_PERSISTENT",
          deviceId: testDeviceId,
          isRevoked: false,
          save: vi.fn().mockImplementation(async function () {
            savedOldSession = this
            return true
          }),
        }

        mockSessionModel.findOne.mockImplementation(async (query: any) => {
          if (query.tokenHash === initialHash) {
            return savedOldSession || initialActiveSession
          }
          if (query.tokenHash === createdSuccessor?.tokenHash) {
            return createdSuccessor
          }
          return null
        })

        mockSessionModel.create.mockImplementation(async (doc: any) => {
          createdSuccessor = { ...doc, isRevoked: false }
          return createdSuccessor
        })

        const firstResult = await tokenService.rotateRefreshSession(
          initialToken,
          undefined,
          { deviceId: testDeviceId, idempotencyKey: testIdempotencyKey },
        )

        expect(firstResult.refreshToken).toBeDefined()
        expect(savedOldSession.isRevoked).toBe(true)
        expect(savedOldSession.rotationReceiptHash).toBeDefined()
        expect(savedOldSession.encryptedSuccessorToken).toBeDefined()

        // 2. Retry 1: Client lost response and retries with EXACT same token, deviceId, idempotencyKey
        const retry1Result = await tokenService.rotateRefreshSession(
          initialToken,
          undefined,
          { deviceId: testDeviceId, idempotencyKey: testIdempotencyKey },
        )

        // Must return the exact same replacement token!
        expect(retry1Result.refreshToken).toBe(firstResult.refreshToken)
        expect(retry1Result.accessToken).toBeDefined()
        expect(mockSessionModel.updateMany).not.toHaveBeenCalled()

        // 3. Retry 2: Another retry (e.g. after restart) returns the exact same credential
        const retry2Result = await tokenService.rotateRefreshSession(
          initialToken,
          undefined,
          { deviceId: testDeviceId, idempotencyKey: testIdempotencyKey },
        )
        expect(retry2Result.refreshToken).toBe(firstResult.refreshToken)
        expect(mockSessionModel.updateMany).not.toHaveBeenCalled()
      })

      it("should recover unpersisted successor session after crash between old-token invalidation and successor creation (fault injection)", async () => {
        const initialToken = "d".repeat(64)
        const initialHash = hashOpaqueToken(initialToken)

        const activeDoctor = {
          _id: doctorId,
          email: "dr@clinic.com",
          fullName: "Dr. CrashSafe",
          status: DoctorStatus.ACTIVE,
        }
        mockDoctorModel.findById.mockResolvedValue(activeDoctor)

        // Simulate state right after a crash:
        // Old token was saved as revoked with encryptedSuccessorToken, but process died before successorModel.create()
        const rawSuccessorToken = "1".repeat(64)
        const successorHash = hashOpaqueToken(rawSuccessorToken)
        const receiptKey = crypto
          .createHash("sha256")
          .update(`cliniqo-rotation-receipt-v1:${initialToken}:${testIdempotencyKey}`)
          .digest()

        const iv = crypto.randomBytes(12)
        const cipher = crypto.createCipheriv("aes-256-gcm", receiptKey, iv)
        const enc = Buffer.concat([cipher.update(rawSuccessorToken, "utf8"), cipher.final()])
        const tag = cipher.getAuthTag()
        const encryptedSuccessorToken = `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`

        const crashedOldSession: any = {
          doctorId,
          familyId: "fam-crash-between-writes",
          tokenHash: initialHash,
          sessionType: "DESKTOP_PERSISTENT",
          deviceId: testDeviceId,
          isRevoked: true,
          revokedAt: new Date(Date.now() - 3600000), // 1 hour ago
          replacedByTokenHash: successorHash,
          rotationReceiptHash: hashOpaqueToken(testIdempotencyKey),
          encryptedSuccessorToken,
        }

        mockSessionModel.findOne.mockImplementation(async (query: any) => {
          if (query.tokenHash === initialHash) return crashedOldSession
          // Successor document does NOT exist in database (crash occurred before create!)
          return null
        })

        mockSessionModel.create.mockImplementation(async (doc: any) => doc)

        // Recovering client starts up and retries with old token + deviceId + idempotencyKey
        const recovered = await tokenService.rotateRefreshSession(
          initialToken,
          undefined,
          { deviceId: testDeviceId, idempotencyKey: testIdempotencyKey },
        )

        expect(recovered.refreshToken).toBe(rawSuccessorToken)
        expect(recovered.accessToken).toBeDefined()
        // Successor session was created in DB during recovery
        expect(mockSessionModel.create).toHaveBeenCalledWith(
          expect.objectContaining({
            tokenHash: successorHash,
            deviceId: testDeviceId,
            isRevoked: false,
          }),
        )
        // Family was NOT revoked!
        expect(mockSessionModel.updateMany).not.toHaveBeenCalled()
      })

      it("should recover session days after rotation when successor has not been consumed", async () => {
        const oldToken = "8".repeat(64)
        const oldHash = hashOpaqueToken(oldToken)
        const successorToken = "9".repeat(64)
        const successorHash = hashOpaqueToken(successorToken)

        const receiptKey = crypto
          .createHash("sha256")
          .update(`cliniqo-rotation-receipt-v1:${oldToken}:${testIdempotencyKey}`)
          .digest()

        const iv = crypto.randomBytes(12)
        const cipher = crypto.createCipheriv("aes-256-gcm", receiptKey, iv)
        const enc = Buffer.concat([cipher.update(successorToken, "utf8"), cipher.final()])
        const tag = cipher.getAuthTag()
        const encryptedSuccessorToken = `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`

        // Rotated 5 days ago (far beyond 60s)
        const fiveDaysAgo = new Date(Date.now() - 5 * 86400 * 1000)
        const ancientRotatedSession: any = {
          doctorId,
          familyId: "fam-five-days-later",
          tokenHash: oldHash,
          sessionType: "DESKTOP_PERSISTENT",
          deviceId: testDeviceId,
          isRevoked: true,
          revokedAt: fiveDaysAgo,
          replacedByTokenHash: successorHash,
          rotationReceiptHash: hashOpaqueToken(testIdempotencyKey),
          encryptedSuccessorToken,
        }

        const unconsumedSuccessor: any = {
          doctorId,
          familyId: "fam-five-days-later",
          tokenHash: successorHash,
          sessionType: "DESKTOP_PERSISTENT",
          deviceId: testDeviceId,
          isRevoked: false, // never consumed
        }

        const activeDoctor = {
          _id: doctorId,
          email: "dr@clinic.com",
          fullName: "Dr. FiveDays",
          status: DoctorStatus.ACTIVE,
        }
        mockDoctorModel.findById.mockResolvedValue(activeDoctor)

        mockSessionModel.findOne.mockImplementation(async (query: any) => {
          if (query.tokenHash === oldHash) return ancientRotatedSession
          if (query.tokenHash === successorHash) return unconsumedSuccessor
          return null
        })

        const result = await tokenService.rotateRefreshSession(
          oldToken,
          undefined,
          { deviceId: testDeviceId, idempotencyKey: testIdempotencyKey },
        )

        expect(result.refreshToken).toBe(successorToken)
        expect(mockSessionModel.updateMany).not.toHaveBeenCalled()
      })

      it("should reject recovery and revoke entire family if successor was already consumed (genuine replay attack)", async () => {
        const oldToken = "6".repeat(64)
        const oldHash = hashOpaqueToken(oldToken)
        const successorToken = "7".repeat(64)
        const successorHash = hashOpaqueToken(successorToken)

        const receiptKey = crypto
          .createHash("sha256")
          .update(`cliniqo-rotation-receipt-v1:${oldToken}:${testIdempotencyKey}`)
          .digest()

        const iv = crypto.randomBytes(12)
        const cipher = crypto.createCipheriv("aes-256-gcm", receiptKey, iv)
        const enc = Buffer.concat([cipher.update(successorToken, "utf8"), cipher.final()])
        const tag = cipher.getAuthTag()
        const encryptedSuccessorToken = `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`

        const oldSession: any = {
          doctorId,
          familyId: "fam-replay-attack",
          tokenHash: oldHash,
          sessionType: "DESKTOP_PERSISTENT",
          deviceId: testDeviceId,
          isRevoked: true,
          revokedAt: new Date(Date.now() - 3600000),
          replacedByTokenHash: successorHash,
          rotationReceiptHash: hashOpaqueToken(testIdempotencyKey),
          encryptedSuccessorToken,
        }

        const consumedSuccessor: any = {
          doctorId,
          familyId: "fam-replay-attack",
          tokenHash: successorHash,
          sessionType: "DESKTOP_PERSISTENT",
          deviceId: testDeviceId,
          isRevoked: true, // ALREADY CONSUMED/REVOKED by legitimate client!
        }

        mockSessionModel.findOne.mockImplementation(async (query: any) => {
          if (query.tokenHash === oldHash) return oldSession
          if (query.tokenHash === successorHash) return consumedSuccessor
          return null
        })

        await expect(
          tokenService.rotateRefreshSession(
            oldToken,
            undefined,
            { deviceId: testDeviceId, idempotencyKey: testIdempotencyKey },
          ),
        ).rejects.toThrow("Potential token reuse detected")

        expect(mockSessionModel.updateMany).toHaveBeenCalledWith(
          { familyId: "fam-replay-attack", isRevoked: false },
          expect.objectContaining({
            $set: expect.objectContaining({ isRevoked: true }),
          }),
        )
      })

      it("should fail closed and revoke family if deviceId is mismatched, missing or empty during recovery", async () => {
        const oldToken = "2".repeat(64)
        const oldHash = hashOpaqueToken(oldToken)

        const revokedSession: any = {
          doctorId,
          familyId: "fam-device-check",
          tokenHash: oldHash,
          sessionType: "DESKTOP_PERSISTENT",
          deviceId: "device-legit-001",
          isRevoked: true,
          revokedAt: new Date(Date.now() - 10000),
          replacedByTokenHash: "dummy-successor",
        }

        mockSessionModel.findOne.mockResolvedValue(revokedSession)

        // Case 1: Mismatched deviceId
        await expect(
          tokenService.rotateRefreshSession(
            oldToken,
            undefined,
            { deviceId: "device-attacker-999", idempotencyKey: testIdempotencyKey },
          ),
        ).rejects.toThrow("Potential token reuse detected")

        // Case 2: Missing deviceId
        await expect(
          tokenService.rotateRefreshSession(
            oldToken,
            undefined,
            { idempotencyKey: testIdempotencyKey },
          ),
        ).rejects.toThrow("Potential token reuse detected")

        // Case 3: Empty string deviceId
        await expect(
          tokenService.rotateRefreshSession(
            oldToken,
            undefined,
            { deviceId: "   ", idempotencyKey: testIdempotencyKey },
          ),
        ).rejects.toThrow("Potential token reuse detected")
      })
    })

    describe("MongoDB findOneAndUpdate CAS path", () => {
      const casDeviceId = "win-desktop-device-cas-1"
      const casIdempotencyKey = "client-cas-idempotency-key-12345"

      it("should handle two concurrent refresh requests via atomic CAS without revoking family", async () => {
        const initialToken = "a1b2c3d4".repeat(8)
        const initialHash = hashOpaqueToken(initialToken)
        const familyId = "fam-concurrent-cas-test"

        const activeDoctor = {
          _id: doctorId,
          email: "dr.cas@clinic.com",
          fullName: "Dr. CAS Concurrency",
          status: DoctorStatus.ACTIVE,
        }
        mockDoctorModel.findById.mockResolvedValue(activeDoctor)

        // In-memory simulation of MongoDB collection
        const dbSessions = new Map<string, any>()
        dbSessions.set(initialHash, {
          doctorId,
          familyId,
          tokenHash: initialHash,
          sessionType: SessionType.DESKTOP_PERSISTENT,
          deviceId: casDeviceId,
          isRevoked: false,
          revokedAt: null,
          replacedByTokenHash: null,
          rotationReceiptHash: null,
          encryptedSuccessorToken: null,
        })

        mockSessionModel.findOne = vi.fn().mockImplementation(async (query: any) => {
          if (query.tokenHash) {
            const doc = dbSessions.get(query.tokenHash)
            if (!doc) return null
            if (query.familyId && doc.familyId !== query.familyId) return null
            if (query.isRevoked !== undefined && doc.isRevoked !== query.isRevoked) return null
            return { ...doc }
          }
          return null
        })

        // Atomic CAS simulation: matches only if { tokenHash, isRevoked: false }
        mockSessionModel.findOneAndUpdate = vi.fn().mockImplementation(async (filter: any, update: any) => {
          const doc = dbSessions.get(filter.tokenHash)
          if (!doc) return null
          if (filter.isRevoked !== undefined && doc.isRevoked !== filter.isRevoked) {
            return null // CAS failed: another request already updated/revoked it
          }
          const previousState = { ...doc }
          if (update.$set) {
            Object.assign(doc, update.$set)
          }
          return previousState
        })

        mockSessionModel.create = vi.fn().mockImplementation(async (doc: any) => {
          const created = { ...doc, isRevoked: false }
          dbSessions.set(doc.tokenHash, created)
          return created
        })

        // Fire two concurrent refresh requests with the same token, deviceId and idempotencyKey
        const [resultA, resultB] = await Promise.all([
          tokenService.rotateRefreshSession(
            initialToken,
            { userAgent: "ClientA/1.0", ipAddress: "127.0.0.1" },
            { deviceId: casDeviceId, idempotencyKey: casIdempotencyKey },
          ),
          tokenService.rotateRefreshSession(
            initialToken,
            { userAgent: "ClientB/1.0", ipAddress: "127.0.0.1" },
            { deviceId: casDeviceId, idempotencyKey: casIdempotencyKey },
          ),
        ])

        // 1. Both requests must receive the exact same rotated successor refresh token
        expect(resultA.refreshToken).toBeDefined()
        expect(resultB.refreshToken).toBeDefined()
        expect(resultA.refreshToken).toBe(resultB.refreshToken)

        // 2. Both requests must receive valid access tokens
        expect(resultA.accessToken).toBeDefined()
        expect(resultB.accessToken).toBeDefined()

        // 3. findOneAndUpdate was called by both requests (one succeeded, one failed CAS)
        expect(mockSessionModel.findOneAndUpdate).toHaveBeenCalledTimes(2)

        // 4. Exactly one successor session document was created in the database
        expect(mockSessionModel.create).toHaveBeenCalledTimes(1)

        // 5. Successor document in DB is active and belongs to the same family and device
        const successorHash = hashOpaqueToken(resultA.refreshToken)
        const successorDoc = dbSessions.get(successorHash)
        expect(successorDoc).toBeDefined()
        expect(successorDoc.isRevoked).toBe(false)
        expect(successorDoc.familyId).toBe(familyId)
        expect(successorDoc.deviceId).toBe(casDeviceId)

        // 6. Session family was NOT revoked (no false token-reuse detection)
        expect(mockSessionModel.updateMany).not.toHaveBeenCalled()
      })

      it("should recover from successor-creation failure right after findOneAndUpdate CAS update upon client retry", async () => {
        const initialToken = "e5f6a7b8".repeat(8)
        const initialHash = hashOpaqueToken(initialToken)
        const familyId = "fam-cas-crash-recovery"

        const activeDoctor = {
          _id: doctorId,
          email: "dr.fault@clinic.com",
          fullName: "Dr. Fault Injection",
          status: DoctorStatus.ACTIVE,
        }
        mockDoctorModel.findById.mockResolvedValue(activeDoctor)

        const dbSessions = new Map<string, any>()
        dbSessions.set(initialHash, {
          doctorId,
          familyId,
          tokenHash: initialHash,
          sessionType: SessionType.DESKTOP_PERSISTENT,
          deviceId: casDeviceId,
          isRevoked: false,
          revokedAt: null,
          replacedByTokenHash: null,
          rotationReceiptHash: null,
          encryptedSuccessorToken: null,
        })

        mockSessionModel.findOne = vi.fn().mockImplementation(async (query: any) => {
          if (query.tokenHash) {
            const doc = dbSessions.get(query.tokenHash)
            if (!doc) return null
            if (query.familyId && doc.familyId !== query.familyId) return null
            if (query.isRevoked !== undefined && doc.isRevoked !== query.isRevoked) return null
            return { ...doc }
          }
          return null
        })

        mockSessionModel.findOneAndUpdate = vi.fn().mockImplementation(async (filter: any, update: any) => {
          const doc = dbSessions.get(filter.tokenHash)
          if (!doc) return null
          if (filter.isRevoked !== undefined && doc.isRevoked !== filter.isRevoked) {
            return null
          }
          const previousState = { ...doc }
          if (update.$set) {
            Object.assign(doc, update.$set)
          }
          return previousState
        })

        // FAULT INJECTION: Simulate failure right after CAS update during sessionModel.create
        // (e.g., database connection reset, out-of-memory, or app crash)
        let createAttempt = 0
        mockSessionModel.create = vi.fn().mockImplementation(async (doc: any) => {
          createAttempt++
          if (createAttempt === 1) {
            throw new Error("MongoDB network timeout during successor session create")
          }
          const created = { ...doc, isRevoked: false }
          dbSessions.set(doc.tokenHash, created)
          return created
        })

        // 1. Initial attempt fails due to injected error on create
        await expect(
          tokenService.rotateRefreshSession(
            initialToken,
            undefined,
            { deviceId: casDeviceId, idempotencyKey: casIdempotencyKey },
          ),
        ).rejects.toThrow("MongoDB network timeout during successor session create")

        // At this point: old token is marked revoked with receipt in DB, but successor was NOT saved!
        const oldDocAfterCrash = dbSessions.get(initialHash)
        expect(oldDocAfterCrash.isRevoked).toBe(true)
        expect(oldDocAfterCrash.replacedByTokenHash).toBeDefined()
        expect(oldDocAfterCrash.rotationReceiptHash).toBeDefined()
        expect(oldDocAfterCrash.encryptedSuccessorToken).toBeDefined()
        // Confirm no successor document in DB
        expect(dbSessions.get(oldDocAfterCrash.replacedByTokenHash)).toBeUndefined()

        // 2. Client retries (e.g. after network restore or application restart) with exact same credentials
        const retryResult = await tokenService.rotateRefreshSession(
          initialToken,
          undefined,
          { deviceId: casDeviceId, idempotencyKey: casIdempotencyKey },
        )

        // 3. Retry succeeds and recovers the exact successor token matching the CAS receipt
        expect(retryResult.refreshToken).toBeDefined()
        expect(hashOpaqueToken(retryResult.refreshToken)).toBe(oldDocAfterCrash.replacedByTokenHash)
        expect(retryResult.accessToken).toBeDefined()

        // 4. Successor document was created during recovery and is unrevoked
        const successorDoc = dbSessions.get(oldDocAfterCrash.replacedByTokenHash)
        expect(successorDoc).toBeDefined()
        expect(successorDoc.isRevoked).toBe(false)
        expect(successorDoc.familyId).toBe(familyId)
        expect(successorDoc.deviceId).toBe(casDeviceId)

        // 5. Family was NOT revoked
        expect(mockSessionModel.updateMany).not.toHaveBeenCalled()
      })
    })
  })

  describe("normalizePemKey", () => {
    it("should format raw base64 key into valid PEM block with headers", () => {
      const rawBase64 =
        "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA3CxRzNxFJV/qUjkRPgXG"
      const result = normalizePemKey(rawBase64, "PUBLIC KEY")
      expect(result).toContain("-----BEGIN PUBLIC KEY-----")
      expect(result).toContain("-----END PUBLIC KEY-----")
      expect(result).toContain(rawBase64)
    })

    it("should preserve already formatted PEM key", () => {
      const pem =
        "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A\n-----END PUBLIC KEY-----\n"
      const result = normalizePemKey(pem, "PUBLIC KEY")
      expect(result).toBe(pem)
    })

    it("should replace literal escaped \\n with actual newlines", () => {
      const escaped =
        "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\\n-----END PRIVATE KEY-----"
      const result = normalizePemKey(escaped, "PRIVATE KEY")
      expect(result).toBe(
        "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n",
      )
    })
  })
})
