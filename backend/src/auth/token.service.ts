import {
  Injectable,
  UnauthorizedException,
  Logger,
  Optional,
} from "@nestjs/common"
import { JwtService } from "@nestjs/jwt"
import { InjectModel, InjectConnection } from "@nestjs/mongoose"
import { Model, Types, type Connection } from "mongoose"
import crypto from "node:crypto"
import { ConfigService } from "../config/config.service.js"
import {
  RefreshSession,
  type RefreshSessionDocument,
} from "./schemas/refresh-session.schema.js"
import { Doctor, type DoctorDocument } from "./schemas/doctor.schema.js"
import { DoctorStatus, SessionType, AUTH_DEFAULTS } from "./auth.constants.js"

export interface AccessTokenPayload {
  sub: string
  email: string
  fullName: string
  status: DoctorStatus
  phone?: string
  qualification?: string
  registrationNumber?: string
  type: "access"
  iat?: number
  exp?: number
  iss?: string
  aud?: string
}

export function parseDurationMs(durationStr: string): number {
  const match = durationStr.match(/^(\d+)(s|m|h|d)$/)
  if (!match) return 15 * 60 * 1000
  const val = parseInt(match[1], 10)
  const unit = match[2]
  switch (unit) {
    case "s":
      return val * 1000
    case "m":
      return val * 60 * 1000
    case "h":
      return val * 60 * 60 * 1000
    case "d":
      return val * 24 * 60 * 60 * 1000
    default:
      return 15 * 60 * 1000
  }
}

export function hashOpaqueToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex")
}

export function deriveReceiptKey(
  rawToken: string,
  idempotencyKey: string,
): Buffer {
  return crypto
    .createHash("sha256")
    .update(`cliniqo-rotation-receipt-v1:${rawToken}:${idempotencyKey}`)
    .digest()
}

export function encryptSuccessorToken(token: string, key: Buffer): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv)
  const encrypted = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`
}

export function decryptSuccessorToken(
  encryptedStr: string,
  key: Buffer,
): string | null {
  try {
    const parts = encryptedStr.split(":")
    if (parts.length !== 3) return null
    const [ivHex, tagHex, cipherHex] = parts
    const iv = Buffer.from(ivHex, "hex")
    const tag = Buffer.from(tagHex, "hex")
    const ciphertext = Buffer.from(cipherHex, "hex")
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv)
    decipher.setAuthTag(tag)
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ])
    return decrypted.toString("utf8")
  } catch {
    return null
  }
}

export interface PublicKeyInfo {
  algorithm: "RS256"
  publicKey: string
  issuer: string
  audience: string
}

export function normalizePemKey(
  key: string,
  type: "PRIVATE KEY" | "PUBLIC KEY",
): string {
  let cleaned = key.trim().replace(/\\n/g, "\n")
  if (!cleaned.includes(`-----BEGIN ${type}-----`)) {
    const raw = cleaned.replace(/-----.*?-----|\s/g, "")
    const chunked = raw.match(/.{1,64}/g)?.join("\n") || raw
    return `-----BEGIN ${type}-----\n${chunked}\n-----END ${type}-----\n`
  }
  return cleaned.endsWith("\n") ? cleaned : `${cleaned}\n`
}

@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name)
  private readonly rsaKeyPair: { privateKey: string; publicKey: string }

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @InjectModel(RefreshSession.name)
    private readonly sessionModel: Model<RefreshSessionDocument>,
    @InjectModel(Doctor.name)
    private readonly doctorModel: Model<DoctorDocument>,
    @Optional()
    @InjectConnection()
    private readonly connection?: Connection,
  ) {
    if (this.configService.jwtPrivateKey && this.configService.jwtPublicKey) {
      this.rsaKeyPair = {
        privateKey: normalizePemKey(
          this.configService.jwtPrivateKey,
          "PRIVATE KEY",
        ),
        publicKey: normalizePemKey(
          this.configService.jwtPublicKey,
          "PUBLIC KEY",
        ),
      }
    } else {
      if (this.configService.isProduction) {
        throw new Error(
          "Production environment requires JWT_PRIVATE_KEY and JWT_PUBLIC_KEY to be configured.",
        )
      }
      this.logger.warn(
        "JWT_PRIVATE_KEY / JWT_PUBLIC_KEY not configured. Generating ephemeral RSA-2048 keypair for development.",
      )
      this.rsaKeyPair = crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      })
    }
  }

  /**
   * Generates a short-lived, signed JWT access token using backend RS256 private key.
   */
  async generateAccessToken(doctor: {
    _id: Types.ObjectId | string
    email: string
    fullName: string
    status: DoctorStatus
    phone?: string
    qualification?: string
    registrationNumber?: string
    licenseNumber?: string
  }): Promise<string> {
    const authConfig = this.configService.validateAuthConfig()

    const payload: AccessTokenPayload = {
      sub: doctor._id.toString(),
      email: doctor.email,
      fullName: doctor.fullName,
      status: doctor.status,
      phone: doctor.phone,
      qualification: doctor.qualification,
      registrationNumber: doctor.registrationNumber || doctor.licenseNumber,
      type: "access",
    }

    return this.jwtService.signAsync(payload, {
      privateKey: this.rsaKeyPair.privateKey,
      expiresIn: authConfig.jwtAccessExpiresIn as any,
      issuer: authConfig.jwtIssuer,
      audience: authConfig.jwtAudience,
      algorithm: "RS256",
    })
  }

  /**
   * Validates a JWT access token signature, issuer, audience, and type.
   * Supports backend RS256 as primary and HS256 for backward-compatible verification.
   */
  async verifyAccessToken(token: string): Promise<AccessTokenPayload> {
    const authConfig = this.configService.validateAuthConfig()

    const parts = token.split(".")
    let alg = "RS256"
    if (parts.length === 3) {
      try {
        const header = JSON.parse(
          Buffer.from(parts[0], "base64url").toString("utf8"),
        )
        if (header.alg) alg = header.alg
      } catch {
        // Handled by verifyAsync failure
      }
    }

    try {
      const verifyOptions: any = {
        issuer: authConfig.jwtIssuer,
        audience: authConfig.jwtAudience,
      }

      if (alg === "RS256") {
        verifyOptions.publicKey = this.rsaKeyPair.publicKey
        verifyOptions.algorithms = ["RS256"]
      } else if (alg === "HS256") {
        verifyOptions.secret = authConfig.jwtAccessSecret
        verifyOptions.algorithms = ["HS256"]
      } else {
        throw new UnauthorizedException(`Unsupported token algorithm: ${alg}`)
      }

      const payload = await this.jwtService.verifyAsync<AccessTokenPayload>(
        token,
        verifyOptions,
      )

      if (payload.type !== "access") {
        throw new UnauthorizedException("Invalid token type.")
      }

      return payload
    } catch {
      throw new UnauthorizedException("Invalid or expired access token.")
    }
  }

  /**
   * Exposes backend public key and algorithm metadata for desktop/client verification.
   */
  getPublicKeyInfo(): PublicKeyInfo {
    const authConfig = this.configService.validateAuthConfig()
    return {
      algorithm: "RS256",
      publicKey: this.rsaKeyPair.publicKey,
      issuer: authConfig.jwtIssuer,
      audience: authConfig.jwtAudience,
    }
  }

  /**
   * Creates a new cryptographically secure opaque refresh session.
   * Stores only the SHA-256 hash in MongoDB.
   * For DESKTOP_PERSISTENT sessions, expiresAt is null (no arbitrary expiration).
   */
  async createRefreshSession(
    doctorId: Types.ObjectId | string,
    familyId?: string,
    meta?: { userAgent?: string; ipAddress?: string },
    options?: {
      sessionType?: "WEB_STANDARD" | "DESKTOP_PERSISTENT"
      deviceId?: string
    },
  ): Promise<{ refreshToken: string; session: RefreshSessionDocument }> {
    const rawRefreshToken = crypto.randomBytes(32).toString("hex")
    const tokenHash = hashOpaqueToken(rawRefreshToken)
    const sessionFamily = familyId || crypto.randomUUID()
    const sessionType = options?.sessionType || SessionType.WEB_STANDARD
    const deviceId = options?.deviceId || null

    let expiresAt: Date | null = null
    if (sessionType !== SessionType.DESKTOP_PERSISTENT) {
      const refreshDurationMs = parseDurationMs(
        this.configService.jwtRefreshExpiresIn,
      )
      expiresAt = new Date(Date.now() + refreshDurationMs)
    }

    const session = await this.sessionModel.create({
      doctorId: new Types.ObjectId(doctorId.toString()),
      tokenHash,
      familyId: sessionFamily,
      sessionType,
      deviceId,
      isRevoked: false,
      expiresAt,
      lastUsedAt: new Date(),
      userAgent: meta?.userAgent || null,
      ipAddress: meta?.ipAddress || null,
    })

    return { refreshToken: rawRefreshToken, session }
  }

  /**
   * Rotates a refresh token session with crash-safe recovery, durable idempotency, and strict reuse detection:
   * - If an already revoked token is used, verifies exact device ID match and rotation receipt hash.
   * - Supports crash recovery beyond 60s when the successor token has not yet been consumed.
   * - If genuine replay attack detected (mismatched device, missing/invalid receipt, or already consumed successor),
   *   revokes the entire session family!
   * - If valid, uses atomic compare-and-swap (CAS) to consume the old token, links the successor with an encrypted receipt,
   *   and issues a new one in the same family.
   */
  async rotateRefreshSession(
    rawRefreshToken: string,
    meta?: { userAgent?: string; ipAddress?: string },
    options?: {
      deviceId?: string
      idempotencyKey?: string
    },
  ): Promise<{
    accessToken: string
    refreshToken: string
    tokenType: "Bearer"
    expiresIn: string
  }> {
    const tokenHash = hashOpaqueToken(rawRefreshToken)
    const session = await this.sessionModel.findOne({ tokenHash })

    if (!session) {
      throw new UnauthorizedException("Invalid or expired refresh token.")
    }

    // 1. RECOVERY / REUSE DETECTION PATH (session is already revoked)
    if (session.isRevoked) {
      // Require exact device match for persistent desktop sessions or sessions with deviceId bound
      const hasExactDeviceMatch = Boolean(
        session.deviceId &&
          options?.deviceId &&
          session.deviceId.trim() !== "" &&
          session.deviceId.trim() === options.deviceId.trim(),
      )

      const providedReceiptHash = options?.idempotencyKey
        ? hashOpaqueToken(options.idempotencyKey)
        : null

      const hasMatchingReceipt = Boolean(
        providedReceiptHash &&
          session.rotationReceiptHash &&
          providedReceiptHash === session.rotationReceiptHash,
      )

      // Path A: Durable Idempotency Receipt Recovery (works at any time, even hours/days later!)
      if (hasExactDeviceMatch && hasMatchingReceipt && session.replacedByTokenHash) {
        let recoveredRawToken: string | null = null
        if (session.encryptedSuccessorToken && options?.idempotencyKey) {
          const key = deriveReceiptKey(rawRefreshToken, options.idempotencyKey)
          recoveredRawToken = decryptSuccessorToken(session.encryptedSuccessorToken, key)
        }

        if (
          recoveredRawToken &&
          hashOpaqueToken(recoveredRawToken) === session.replacedByTokenHash
        ) {
          const successorSession = await this.sessionModel.findOne({
            tokenHash: session.replacedByTokenHash,
            familyId: session.familyId,
          })

          const doctor = await this.doctorModel.findById(session.doctorId)
          if (doctor && doctor.status === DoctorStatus.ACTIVE) {
            // Case A1: Successor session exists and is NOT revoked (client retrying after lost response / power cycle)
            if (successorSession && !successorSession.isRevoked) {
              this.logger.log(
                `Durable idempotent rotation recovery succeeded for doctor ${session.doctorId.toString()} in family ${session.familyId} on device ${session.deviceId}.`,
              )
              const accessToken = await this.generateAccessToken(doctor)
              return {
                accessToken,
                refreshToken: recoveredRawToken,
                tokenType: "Bearer",
                expiresIn: this.configService.jwtAccessExpiresIn,
              }
            }

            // Case A2: Successor document missing (crash between old-token invalidation and successor creation)
            if (!successorSession) {
              this.logger.log(
                `Recovering unpersisted successor session after crash for doctor ${session.doctorId.toString()} in family ${session.familyId}.`,
              )
              let successorExpiresAt: Date | null = null
              if (session.sessionType !== SessionType.DESKTOP_PERSISTENT) {
                const refreshDurationMs = parseDurationMs(this.configService.jwtRefreshExpiresIn)
                successorExpiresAt = new Date(Date.now() + refreshDurationMs)
              }

              await this.sessionModel.create({
                doctorId: session.doctorId,
                tokenHash: session.replacedByTokenHash,
                familyId: session.familyId,
                sessionType: session.sessionType,
                deviceId: session.deviceId,
                isRevoked: false,
                expiresAt: successorExpiresAt,
                lastUsedAt: new Date(),
                userAgent: meta?.userAgent || null,
                ipAddress: meta?.ipAddress || null,
              })

              const accessToken = await this.generateAccessToken(doctor)
              return {
                accessToken,
                refreshToken: recoveredRawToken,
                tokenType: "Bearer",
                expiresIn: this.configService.jwtAccessExpiresIn,
              }
            }
          }
        }
      }

      // Path B: Grace-window fallback within 60s if exact device ID matches
      const now = Date.now()
      const revokedTime = session.revokedAt ? session.revokedAt.getTime() : 0
      const isWithinGrace =
        now - revokedTime <=
        AUTH_DEFAULTS.ROTATION_RECOVERY_GRACE_WINDOW_SEC * 1000

      if (hasExactDeviceMatch && isWithinGrace && session.replacedByTokenHash) {
        const successorSession = await this.sessionModel.findOne({
          tokenHash: session.replacedByTokenHash,
          familyId: session.familyId,
          isRevoked: false,
        })

        if (successorSession) {
          const doctor = await this.doctorModel.findById(session.doctorId)
          if (doctor && doctor.status === DoctorStatus.ACTIVE) {
            successorSession.isRevoked = true
            successorSession.revokedAt = new Date()
            await successorSession.save()

            const { refreshToken: recoveredToken } =
              await this.createRefreshSession(
                session.doctorId,
                session.familyId,
                meta,
                {
                  sessionType:
                    (session.sessionType as any) ||
                    SessionType.DESKTOP_PERSISTENT,
                  deviceId: session.deviceId || undefined,
                },
              )

            const accessToken = await this.generateAccessToken(doctor)
            return {
              accessToken,
              refreshToken: recoveredToken,
              tokenType: "Bearer",
              expiresIn: this.configService.jwtAccessExpiresIn,
            }
          }
        }
      }

      this.logger.warn(
        `Refresh token reuse detected for doctor ${session.doctorId.toString()} in session family ${session.familyId}. Revoking entire session family.`,
      )
      await this.sessionModel.updateMany(
        { familyId: session.familyId, isRevoked: false },
        { $set: { isRevoked: true, revokedAt: new Date() } },
      )
      throw new UnauthorizedException(
        "Invalid refresh session. Potential token reuse detected. Please log in again.",
      )
    }

    // 2. NORMAL ROTATION PATH (session is currently active, isRevoked: false)

    // Check expiration (only for non-persistent sessions)
    if (
      session.sessionType !== SessionType.DESKTOP_PERSISTENT &&
      session.expiresAt &&
      session.expiresAt.getTime() <= Date.now()
    ) {
      session.isRevoked = true
      session.revokedAt = new Date()
      await session.save()
      throw new UnauthorizedException(
        "Refresh token has expired. Please log in again.",
      )
    }

    // Verify doctor account is still active
    const doctor = await this.doctorModel.findById(session.doctorId)
    if (!doctor || doctor.status !== DoctorStatus.ACTIVE) {
      session.isRevoked = true
      session.revokedAt = new Date()
      await session.save()
      throw new UnauthorizedException("Account is not active.")
    }

    // Enforce exact device ID for persistent desktop sessions
    if (session.sessionType === SessionType.DESKTOP_PERSISTENT) {
      if (!options?.deviceId || options.deviceId.trim() === "") {
        throw new UnauthorizedException("Device ID is required for persistent desktop sessions.")
      }
      if (session.deviceId && session.deviceId.trim() !== options.deviceId.trim()) {
        throw new UnauthorizedException("Device ID mismatch for persistent desktop session.")
      }
    }

    const boundDeviceId = options?.deviceId?.trim() || session.deviceId || null

    // Generate successor token
    const rawNewToken = crypto.randomBytes(32).toString("hex")
    const newHash = hashOpaqueToken(rawNewToken)

    const receiptHash = options?.idempotencyKey
      ? hashOpaqueToken(options.idempotencyKey)
      : null
    const encryptedSuccessorToken = options?.idempotencyKey
      ? encryptSuccessorToken(
          rawNewToken,
          deriveReceiptKey(rawRefreshToken, options.idempotencyKey),
        )
      : null

    const sessionType = (session.sessionType as any) || SessionType.WEB_STANDARD
    let successorExpiresAt: Date | null = null
    if (sessionType !== SessionType.DESKTOP_PERSISTENT) {
      const refreshDurationMs = parseDurationMs(this.configService.jwtRefreshExpiresIn)
      successorExpiresAt = new Date(Date.now() + refreshDurationMs)
    }

    // Atomic compare-and-swap (CAS): invalidate old session only if still active
    let updated: any = null
    if (typeof this.sessionModel.findOneAndUpdate === "function") {
      updated = await this.sessionModel.findOneAndUpdate(
        { tokenHash, isRevoked: false },
        {
          $set: {
            isRevoked: true,
            revokedAt: new Date(),
            replacedByTokenHash: newHash,
            rotationReceiptHash: receiptHash,
            encryptedSuccessorToken,
            lastUsedAt: new Date(),
            ...(session.sessionType === SessionType.DESKTOP_PERSISTENT
              ? { expiresAt: new Date(Date.now() + 30 * 86400 * 1000) }
              : {}),
          },
        },
        { new: false },
      )

      if (!updated) {
        // Another concurrent request updated it first. Re-run rotation which enters idempotent recovery
        return this.rotateRefreshSession(rawRefreshToken, meta, options)
      }
    } else {
      session.isRevoked = true
      session.revokedAt = new Date()
      session.replacedByTokenHash = newHash
      session.rotationReceiptHash = receiptHash
      session.encryptedSuccessorToken = encryptedSuccessorToken
      session.lastUsedAt = new Date()
      if (session.sessionType === SessionType.DESKTOP_PERSISTENT) {
        session.expiresAt = new Date(Date.now() + 30 * 86400 * 1000)
      }
      await session.save()
    }

    // Create successor session document
    try {
      await this.sessionModel.create({
        doctorId: session.doctorId,
        tokenHash: newHash,
        familyId: session.familyId,
        sessionType,
        deviceId: boundDeviceId,
        isRevoked: false,
        expiresAt: successorExpiresAt,
        lastUsedAt: new Date(),
        userAgent: meta?.userAgent || null,
        ipAddress: meta?.ipAddress || null,
      })
    } catch (createErr) {
      this.logger.error(
        `Failed to create successor session document: ${(createErr as Error)?.message || String(createErr)}`,
      )
      throw createErr
    }

    const accessToken = await this.generateAccessToken(doctor)

    return {
      accessToken,
      refreshToken: rawNewToken,
      tokenType: "Bearer",
      expiresIn: this.configService.jwtAccessExpiresIn,
    }
  }

  /**
   * Revokes all active refresh sessions for a specific device (e.g. lost laptop).
   */
  async revokeDeviceSessions(
    doctorId: Types.ObjectId | string,
    deviceId: string,
  ): Promise<number> {
    const result = await this.sessionModel.updateMany(
      {
        doctorId: new Types.ObjectId(doctorId.toString()),
        deviceId,
        isRevoked: false,
      },
      { $set: { isRevoked: true, revokedAt: new Date() } },
    )
    return result.modifiedCount
  }

  /**
   * Explicitly revokes a specific refresh session (e.g. on logout).
   */
  async revokeSession(rawRefreshToken: string): Promise<boolean> {
    const tokenHash = hashOpaqueToken(rawRefreshToken)
    const result = await this.sessionModel.updateOne(
      { tokenHash, isRevoked: false },
      { $set: { isRevoked: true, revokedAt: new Date() } },
    )
    return result.modifiedCount > 0
  }

  /**
   * Revokes all active refresh sessions for a doctor (e.g. on password reset or account lockout).
   */
  async revokeAllDoctorSessions(
    doctorId: Types.ObjectId | string,
  ): Promise<number> {
    const result = await this.sessionModel.updateMany(
      {
        doctorId: new Types.ObjectId(doctorId.toString()),
        isRevoked: false,
      },
      { $set: { isRevoked: true, revokedAt: new Date() } },
    )
    return result.modifiedCount
  }
}
