import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import crypto from 'node:crypto';
import { ConfigService } from '../config/config.service.js';
import {
  RefreshSession,
  type RefreshSessionDocument,
} from './schemas/refresh-session.schema.js';
import { Doctor, type DoctorDocument } from './schemas/doctor.schema.js';
import { DoctorStatus } from './auth.constants.js';

export interface AccessTokenPayload {
  sub: string;
  email: string;
  fullName: string;
  status: DoctorStatus;
  phone?: string;
  qualification?: string;
  registrationNumber?: string;
  type: 'access';
  iat?: number;
  exp?: number;
  iss?: string;
  aud?: string;
}

export function parseDurationMs(durationStr: string): number {
  const match = durationStr.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return 15 * 60 * 1000;
  const val = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case 's':
      return val * 1000;
    case 'm':
      return val * 60 * 1000;
    case 'h':
      return val * 60 * 60 * 1000;
    case 'd':
      return val * 24 * 60 * 60 * 1000;
    default:
      return 15 * 60 * 1000;
  }
}

export function hashOpaqueToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export interface PublicKeyInfo {
  algorithm: 'RS256';
  publicKey: string;
  issuer: string;
  audience: string;
}

export function normalizePemKey(
  key: string,
  type: 'PRIVATE KEY' | 'PUBLIC KEY',
): string {
  let cleaned = key.trim().replace(/\\n/g, '\n');
  if (!cleaned.includes(`-----BEGIN ${type}-----`)) {
    const raw = cleaned.replace(/-----.*?-----|\s/g, '');
    const chunked = raw.match(/.{1,64}/g)?.join('\n') || raw;
    return `-----BEGIN ${type}-----\n${chunked}\n-----END ${type}-----\n`;
  }
  return cleaned.endsWith('\n') ? cleaned : `${cleaned}\n`;
}

@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);
  private readonly rsaKeyPair: { privateKey: string; publicKey: string };

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @InjectModel(RefreshSession.name)
    private readonly sessionModel: Model<RefreshSessionDocument>,
    @InjectModel(Doctor.name)
    private readonly doctorModel: Model<DoctorDocument>,
  ) {
    if (this.configService.jwtPrivateKey && this.configService.jwtPublicKey) {
      this.rsaKeyPair = {
        privateKey: normalizePemKey(
          this.configService.jwtPrivateKey,
          'PRIVATE KEY',
        ),
        publicKey: normalizePemKey(
          this.configService.jwtPublicKey,
          'PUBLIC KEY',
        ),
      };
    } else {
      if (this.configService.isProduction) {
        throw new Error(
          'Production environment requires JWT_PRIVATE_KEY and JWT_PUBLIC_KEY to be configured.',
        );
      }
      this.logger.warn(
        'JWT_PRIVATE_KEY / JWT_PUBLIC_KEY not configured. Generating ephemeral RSA-2048 keypair for development.',
      );
      this.rsaKeyPair = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
    }
  }

  /**
   * Generates a short-lived, signed JWT access token using backend RS256 private key.
   */
  async generateAccessToken(doctor: {
    _id: Types.ObjectId | string;
    email: string;
    fullName: string;
    status: DoctorStatus;
    phone?: string;
    qualification?: string;
    registrationNumber?: string;
    licenseNumber?: string;
  }): Promise<string> {
    const authConfig = this.configService.validateAuthConfig();

    const payload: AccessTokenPayload = {
      sub: doctor._id.toString(),
      email: doctor.email,
      fullName: doctor.fullName,
      status: doctor.status,
      phone: doctor.phone,
      qualification: doctor.qualification,
      registrationNumber: doctor.registrationNumber || doctor.licenseNumber,
      type: 'access',
    };

    return this.jwtService.signAsync(payload, {
      privateKey: this.rsaKeyPair.privateKey,
      expiresIn: authConfig.jwtAccessExpiresIn as any,
      issuer: authConfig.jwtIssuer,
      audience: authConfig.jwtAudience,
      algorithm: 'RS256',
    });
  }

  /**
   * Validates a JWT access token signature, issuer, audience, and type.
   * Supports backend RS256 as primary and HS256 for backward-compatible verification.
   */
  async verifyAccessToken(token: string): Promise<AccessTokenPayload> {
    const authConfig = this.configService.validateAuthConfig();

    const parts = token.split('.');
    let alg = 'RS256';
    if (parts.length === 3) {
      try {
        const header = JSON.parse(
          Buffer.from(parts[0], 'base64url').toString('utf8'),
        );
        if (header.alg) alg = header.alg;
      } catch {
        // Handled by verifyAsync failure
      }
    }

    try {
      const verifyOptions: any = {
        issuer: authConfig.jwtIssuer,
        audience: authConfig.jwtAudience,
      };

      if (alg === 'RS256') {
        verifyOptions.publicKey = this.rsaKeyPair.publicKey;
        verifyOptions.algorithms = ['RS256'];
      } else if (alg === 'HS256') {
        verifyOptions.secret = authConfig.jwtAccessSecret;
        verifyOptions.algorithms = ['HS256'];
      } else {
        throw new UnauthorizedException(`Unsupported token algorithm: ${alg}`);
      }

      const payload = await this.jwtService.verifyAsync<AccessTokenPayload>(
        token,
        verifyOptions,
      );

      if (payload.type !== 'access') {
        throw new UnauthorizedException('Invalid token type.');
      }

      return payload;
    } catch {
      throw new UnauthorizedException('Invalid or expired access token.');
    }
  }

  /**
   * Exposes backend public key and algorithm metadata for desktop/client verification.
   */
  getPublicKeyInfo(): PublicKeyInfo {
    const authConfig = this.configService.validateAuthConfig();
    return {
      algorithm: 'RS256',
      publicKey: this.rsaKeyPair.publicKey,
      issuer: authConfig.jwtIssuer,
      audience: authConfig.jwtAudience,
    };
  }

  /**
   * Creates a new cryptographically secure opaque refresh session.
   * Stores only the SHA-256 hash in MongoDB.
   */
  async createRefreshSession(
    doctorId: Types.ObjectId | string,
    familyId?: string,
    meta?: { userAgent?: string; ipAddress?: string },
  ): Promise<{ refreshToken: string; session: RefreshSessionDocument }> {
    const rawRefreshToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashOpaqueToken(rawRefreshToken);
    const sessionFamily = familyId || crypto.randomUUID();

    const refreshDurationMs = parseDurationMs(
      this.configService.jwtRefreshExpiresIn,
    );
    const expiresAt = new Date(Date.now() + refreshDurationMs);

    const session = await this.sessionModel.create({
      doctorId: new Types.ObjectId(doctorId.toString()),
      tokenHash,
      familyId: sessionFamily,
      isRevoked: false,
      expiresAt,
      userAgent: meta?.userAgent || null,
      ipAddress: meta?.ipAddress || null,
    });

    return { refreshToken: rawRefreshToken, session };
  }

  /**
   * Rotates a refresh token session with strict reuse detection:
   * - If an already revoked token is used, revokes the entire session family!
   * - If valid, consumes the old token and issues a new one in the same family.
   */
  async rotateRefreshSession(
    rawRefreshToken: string,
    meta?: { userAgent?: string; ipAddress?: string },
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    tokenType: 'Bearer';
    expiresIn: string;
  }> {
    const tokenHash = hashOpaqueToken(rawRefreshToken);
    const session = await this.sessionModel.findOne({ tokenHash });

    if (!session) {
      throw new UnauthorizedException('Invalid or expired refresh token.');
    }

    // Reuse detection: If the session was already revoked, a replay attack has occurred!
    if (session.isRevoked) {
      this.logger.warn(
        `Refresh token reuse detected for doctor ${session.doctorId.toString()} in session family ${session.familyId}. Revoking entire session family.`,
      );
      await this.sessionModel.updateMany(
        { familyId: session.familyId, isRevoked: false },
        { $set: { isRevoked: true, revokedAt: new Date() } },
      );
      throw new UnauthorizedException(
        'Invalid refresh session. Potential token reuse detected. Please log in again.',
      );
    }

    // Check expiration
    if (session.expiresAt.getTime() <= Date.now()) {
      session.isRevoked = true;
      session.revokedAt = new Date();
      await session.save();
      throw new UnauthorizedException(
        'Refresh token has expired. Please log in again.',
      );
    }

    // Verify doctor account is still active
    const doctor = await this.doctorModel.findById(session.doctorId);
    if (!doctor || doctor.status !== DoctorStatus.ACTIVE) {
      session.isRevoked = true;
      session.revokedAt = new Date();
      await session.save();
      throw new UnauthorizedException('Account is not active.');
    }

    // Invalidate old session (rotation)
    session.isRevoked = true;
    session.revokedAt = new Date();
    await session.save();

    // Create new session in same family
    const { refreshToken: newRawToken } = await this.createRefreshSession(
      session.doctorId,
      session.familyId,
      meta,
    );

    // Generate fresh access token
    const accessToken = await this.generateAccessToken(doctor);

    return {
      accessToken,
      refreshToken: newRawToken,
      tokenType: 'Bearer',
      expiresIn: this.configService.jwtAccessExpiresIn,
    };
  }

  /**
   * Explicitly revokes a specific refresh session (e.g. on logout).
   */
  async revokeSession(rawRefreshToken: string): Promise<boolean> {
    const tokenHash = hashOpaqueToken(rawRefreshToken);
    const result = await this.sessionModel.updateOne(
      { tokenHash, isRevoked: false },
      { $set: { isRevoked: true, revokedAt: new Date() } },
    );
    return result.modifiedCount > 0;
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
    );
    return result.modifiedCount;
  }
}
