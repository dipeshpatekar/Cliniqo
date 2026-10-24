import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import crypto from 'node:crypto';
import { Doctor, type DoctorDocument } from './schemas/doctor.schema.js';
import {
  PasswordResetToken,
  type PasswordResetTokenDocument,
} from './schemas/password-reset.schema.js';
import { PasswordService } from './password.service.js';
import { TokenService, hashOpaqueToken } from './token.service.js';
import { MailService } from './mail.service.js';
import { RateLimiterService } from './rate-limiter.service.js';
import { ConfigService } from '../config/config.service.js';
import { DoctorStatus, AUTH_DEFAULTS } from './auth.constants.js';
import {
  LoginDto,
  RefreshTokenDto,
  ForgotPasswordDto,
  ResetPasswordDto,
} from './dto/auth.dto.js';
import { validatePasswordPolicy } from './dto/doctor.dto.js';

// Constant dummy hash used to mitigate timing attacks when email does not exist
const DUMMY_ARGON2_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$dummySalt1234567890$dummyHash123456789012345678901234567890';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectModel(Doctor.name)
    private readonly doctorModel: Model<DoctorDocument>,
    @InjectModel(PasswordResetToken.name)
    private readonly resetModel: Model<PasswordResetTokenDocument>,
    private readonly passwordService: PasswordService,
    private readonly tokenService: TokenService,
    private readonly mailService: MailService,
    private readonly rateLimiter: RateLimiterService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Authenticates a doctor and issues an access token and an opaque refresh session.
   * Returns generic unauthorized responses to prevent account enumeration.
   */
  async login(
    dto: LoginDto,
    meta?: { ipAddress?: string; userAgent?: string },
  ) {
    const rateLimitConfig = this.configService.rateLimitConfig;
    const clientIp = meta?.ipAddress || 'unknown-client';
    const rateLimitKey = `login:ip:${clientIp}`;

    // 1. Rate limiting check
    await this.rateLimiter.assertRateLimit(
      rateLimitKey,
      rateLimitConfig.loginMax,
      rateLimitConfig.loginWindowSec,
    );

    const email = dto.email.trim().toLowerCase();

    // 2. Fetch doctor by normalized email, including passwordHash
    const doctor = await this.doctorModel
      .findOne({ email })
      .select('+passwordHash');

    if (!doctor) {
      // Execute dummy argon2 verification to prevent timing attack enumeration
      await this.passwordService.verifyPassword(
        DUMMY_ARGON2_HASH,
        dto.password,
      );
      throw new UnauthorizedException('Invalid email or password.');
    }

    // 3. Account status and lockout checks
    if (doctor.status === DoctorStatus.LOCKED) {
      if (doctor.lockUntil && doctor.lockUntil.getTime() > Date.now()) {
        throw new UnauthorizedException(
          'Account is temporarily locked due to excessive failed attempts. Please try again later or reset your password.',
        );
      }
      // Lockout duration has expired: auto-unlock
      doctor.status = DoctorStatus.ACTIVE;
      doctor.failedLoginAttempts = 0;
      doctor.lockUntil = null;
    }

    if (doctor.status === DoctorStatus.DISABLED) {
      throw new UnauthorizedException(
        'Account is disabled. Please contact clinic administrator.',
      );
    }

    if (doctor.status === DoctorStatus.PENDING_VERIFICATION) {
      throw new UnauthorizedException(
        'Account verification is pending. Please verify your account before logging in.',
      );
    }

    // 4. Verify password
    const isPasswordValid = await this.passwordService.verifyPassword(
      doctor.passwordHash,
      dto.password,
    );

    if (!isPasswordValid) {
      // Increment failed attempts and trigger lockout if threshold is exceeded
      const attempts = (doctor.failedLoginAttempts || 0) + 1;
      doctor.failedLoginAttempts = attempts;

      if (attempts >= AUTH_DEFAULTS.MAX_FAILED_LOGIN_ATTEMPTS) {
        doctor.status = DoctorStatus.LOCKED;
        doctor.lockUntil = new Date(
          Date.now() + AUTH_DEFAULTS.LOCKOUT_DURATION_MINUTES * 60 * 1000,
        );
        this.logger.warn(
          `Doctor account ${doctor._id.toString()} locked due to ${attempts} failed login attempts.`,
        );
      }

      await doctor.save();
      throw new UnauthorizedException('Invalid email or password.');
    }

    // 5. Successful authentication
    doctor.failedLoginAttempts = 0;
    doctor.lockUntil = null;
    doctor.lastLoginAt = new Date();

    // Transparent parameter upgrade if cost settings changed
    if (this.passwordService.needsRehash(doctor.passwordHash)) {
      doctor.passwordHash = await this.passwordService.hashPassword(
        dto.password,
      );
    }

    await doctor.save();
    await this.rateLimiter.resetLimit(rateLimitKey);

    // 6. Issue access and refresh tokens
    const accessToken = await this.tokenService.generateAccessToken(doctor);
    const { refreshToken } = await this.tokenService.createRefreshSession(
      doctor._id,
      undefined,
      meta,
    );

    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer' as const,
      expiresIn: this.configService.jwtAccessExpiresIn,
      doctor: {
        id: doctor._id.toString(),
        email: doctor.email,
        fullName: doctor.fullName,
        status: doctor.status,
      },
    };
  }

  /**
   * Rotates a refresh token session and issues a fresh access token.
   */
  async refreshToken(
    dto: RefreshTokenDto,
    meta?: { ipAddress?: string; userAgent?: string },
  ) {
    return this.tokenService.rotateRefreshSession(dto.refreshToken, meta);
  }

  /**
   * Revokes the presented refresh token session (logout).
   */
  async logout(dto: RefreshTokenDto) {
    await this.tokenService.revokeSession(dto.refreshToken);
    return { message: 'Successfully logged out.' };
  }

  /**
   * Initiates password recovery.
   * Returns a generic response to prevent account enumeration regardless of whether the account exists.
   */
  async forgotPassword(dto: ForgotPasswordDto, meta?: { ipAddress?: string }) {
    const rateLimitConfig = this.configService.rateLimitConfig;
    const clientIp = meta?.ipAddress || 'unknown-client';
    const rateLimitKey = `recovery:ip:${clientIp}`;

    await this.rateLimiter.assertRateLimit(
      rateLimitKey,
      rateLimitConfig.recoveryMax,
      rateLimitConfig.recoveryWindowSec,
    );

    const genericResponse = {
      message:
        'If an account exists with this email address, password reset instructions have been sent.',
    };

    const email = dto.email.trim().toLowerCase();
    const doctor = await this.doctorModel.findOne({ email });

    if (!doctor || doctor.status === DoctorStatus.DISABLED) {
      return genericResponse;
    }

    // Invalidate any previously issued unused reset tokens for this doctor
    await this.resetModel.updateMany(
      { doctorId: doctor._id, used: false },
      { $set: { used: true, usedAt: new Date() } },
    );

    // Generate single-use, 256-bit cryptographically secure reset token
    const rawResetToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashOpaqueToken(rawResetToken);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes TTL

    await this.resetModel.create({
      doctorId: doctor._id,
      tokenHash,
      expiresAt,
      used: false,
    });

    // Send email delivery safely
    await this.mailService.sendPasswordResetEmail(doctor.email, rawResetToken);

    return genericResponse;
  }

  /**
   * Completes password reset, marks token used, updates Argon2id password hash,
   * unlocks account if locked, and invalidates all existing refresh sessions.
   */
  async resetPassword(dto: ResetPasswordDto, meta?: { ipAddress?: string }) {
    const rateLimitConfig = this.configService.rateLimitConfig;
    const clientIp = meta?.ipAddress || 'unknown-client';
    const rateLimitKey = `reset:ip:${clientIp}`;

    await this.rateLimiter.assertRateLimit(
      rateLimitKey,
      rateLimitConfig.recoveryMax,
      rateLimitConfig.recoveryWindowSec,
    );

    const tokenHash = hashOpaqueToken(dto.token);
    const resetRecord = await this.resetModel.findOne({ tokenHash });

    if (
      !resetRecord ||
      resetRecord.used ||
      resetRecord.expiresAt.getTime() <= Date.now()
    ) {
      throw new BadRequestException('Invalid or expired password reset token.');
    }

    const doctor = await this.doctorModel.findById(resetRecord.doctorId);
    if (!doctor || doctor.status === DoctorStatus.DISABLED) {
      throw new BadRequestException('Invalid or expired password reset token.');
    }

    // Validate new password against policy
    const policyResult = validatePasswordPolicy(dto.newPassword);
    if (!policyResult.isValid) {
      throw new BadRequestException(policyResult.errors);
    }

    // Mark reset token used immediately
    resetRecord.used = true;
    resetRecord.usedAt = new Date();
    await resetRecord.save();

    // Hash new password using Argon2id
    doctor.passwordHash = await this.passwordService.hashPassword(
      dto.newPassword,
    );
    doctor.passwordChangedAt = new Date();
    doctor.failedLoginAttempts = 0;
    doctor.lockUntil = null;

    if (doctor.status === DoctorStatus.LOCKED) {
      doctor.status = DoctorStatus.ACTIVE;
    }

    await doctor.save();

    // CRITICAL: Invalidate all existing refresh sessions for this doctor
    await this.tokenService.revokeAllDoctorSessions(doctor._id);

    return {
      message:
        'Password has been reset successfully. Please log in with your new password.',
    };
  }
}
