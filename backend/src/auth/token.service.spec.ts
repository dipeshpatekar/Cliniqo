import { describe, it, expect, beforeEach, vi } from "vitest"
import { UnauthorizedException } from "@nestjs/common"
import { JwtService } from "@nestjs/jwt"
import { Types } from "mongoose"
import {
  TokenService,
  hashOpaqueToken,
  parseDurationMs,
  normalizePemKey,
} from "./token.service.js"
import { ConfigService } from "../config/config.service.js"
import { DoctorStatus } from "./auth.constants.js"

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
