import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';
import { AuthService } from './auth.service.js';
import { ConfigService } from '../config/config.service.js';
import { DoctorStatus } from './auth.constants.js';

describe('AuthService', () => {
  let authService: AuthService;
  let mockDoctorModel: any;
  let mockResetModel: any;
  let mockPasswordService: any;
  let mockTokenService: any;
  let mockMailService: any;
  let mockRateLimiter: any;
  let configService: ConfigService;

  beforeEach(() => {
    configService = new ConfigService({
      JWT_ACCESS_EXPIRES_IN: '15m',
      JWT_REFRESH_EXPIRES_IN: '7d',
      RATE_LIMIT_LOGIN_MAX: '5',
      RATE_LIMIT_LOGIN_WINDOW_SEC: '60',
      RATE_LIMIT_RECOVERY_MAX: '3',
      RATE_LIMIT_RECOVERY_WINDOW_SEC: '300',
    });

    mockDoctorModel = {
      findOne: vi.fn(),
      findById: vi.fn(),
    };

    mockResetModel = {
      create: vi.fn(),
      findOne: vi.fn(),
      updateMany: vi.fn(),
    };

    mockPasswordService = {
      hashPassword: vi.fn(),
      verifyPassword: vi.fn(),
      needsRehash: vi.fn(),
    };

    mockTokenService = {
      generateAccessToken: vi.fn(),
      createRefreshSession: vi.fn(),
      rotateRefreshSession: vi.fn(),
      revokeSession: vi.fn(),
      revokeAllDoctorSessions: vi.fn(),
    };

    mockMailService = {
      sendPasswordResetEmail: vi.fn(),
    };

    mockRateLimiter = {
      assertRateLimit: vi.fn(),
      resetLimit: vi.fn(),
    };

    authService = new AuthService(
      mockDoctorModel,
      mockResetModel,
      mockPasswordService,
      mockTokenService,
      mockMailService,
      mockRateLimiter,
      configService,
    );
  });

  describe('login', () => {
    const doctorId = new Types.ObjectId();
    const mockDoctor = {
      _id: doctorId,
      email: 'dr.jane@clinic.com',
      fullName: 'Dr. Jane Doe',
      status: DoctorStatus.ACTIVE,
      passwordHash: '$argon2id$v=19$valid_hash',
      failedLoginAttempts: 0,
      lockUntil: null,
      lastLoginAt: null,
      save: vi.fn(),
    };

    it('should authenticate active doctor with valid credentials and return tokens', async () => {
      mockDoctorModel.findOne.mockReturnValue({
        select: vi.fn().mockResolvedValue(mockDoctor),
      });
      mockPasswordService.verifyPassword.mockResolvedValue(true);
      mockPasswordService.needsRehash.mockReturnValue(false);
      mockTokenService.generateAccessToken.mockResolvedValue(
        'valid-access-jwt',
      );
      mockTokenService.createRefreshSession.mockResolvedValue({
        refreshToken: 'a'.repeat(64),
      });

      const result = await authService.login({
        email: '  DR.JANE@CLINIC.COM  ',
        password: 'ValidPassword123!',
      });

      expect(result.accessToken).toBe('valid-access-jwt');
      expect(result.refreshToken).toBe('a'.repeat(64));
      expect(result.tokenType).toBe('Bearer');
      expect(result.doctor.email).toBe('dr.jane@clinic.com');
      expect(mockDoctor.failedLoginAttempts).toBe(0);
      expect(mockDoctor.save).toHaveBeenCalled();
      expect(mockRateLimiter.resetLimit).toHaveBeenCalled();
    });

    it('should run dummy verify and throw generic UnauthorizedException if account does not exist', async () => {
      mockDoctorModel.findOne.mockReturnValue({
        select: vi.fn().mockResolvedValue(null),
      });
      mockPasswordService.verifyPassword.mockResolvedValue(false);

      await expect(
        authService.login({
          email: 'nonexistent@clinic.com',
          password: 'Password123!',
        }),
      ).rejects.toThrow('Invalid email or password.');

      // Timing defense check
      expect(mockPasswordService.verifyPassword).toHaveBeenCalled();
    });

    it('should increment failedLoginAttempts and throw UnauthorizedException on wrong password', async () => {
      const doc = { ...mockDoctor, failedLoginAttempts: 2, save: vi.fn() };
      mockDoctorModel.findOne.mockReturnValue({
        select: vi.fn().mockResolvedValue(doc),
      });
      mockPasswordService.verifyPassword.mockResolvedValue(false);

      await expect(
        authService.login({
          email: 'dr.jane@clinic.com',
          password: 'WrongPassword!',
        }),
      ).rejects.toThrow('Invalid email or password.');

      expect(doc.failedLoginAttempts).toBe(3);
      expect(doc.save).toHaveBeenCalled();
    });

    it('should lock account after 5 failed login attempts', async () => {
      const doc = {
        ...mockDoctor,
        failedLoginAttempts: 4,
        status: DoctorStatus.ACTIVE,
        save: vi.fn(),
      };
      mockDoctorModel.findOne.mockReturnValue({
        select: vi.fn().mockResolvedValue(doc),
      });
      mockPasswordService.verifyPassword.mockResolvedValue(false);

      await expect(
        authService.login({
          email: 'dr.jane@clinic.com',
          password: 'WrongPassword!',
        }),
      ).rejects.toThrow('Invalid email or password.');

      expect(doc.failedLoginAttempts).toBe(5);
      expect(doc.status).toBe(DoctorStatus.LOCKED);
      expect(doc.lockUntil).toBeDefined();
    });

    it('should reject login if account is locked and cool-down period has not expired', async () => {
      const lockedDoc = {
        ...mockDoctor,
        status: DoctorStatus.LOCKED,
        lockUntil: new Date(Date.now() + 10 * 60 * 1000), // Locked for 10 more minutes
      };
      mockDoctorModel.findOne.mockReturnValue({
        select: vi.fn().mockResolvedValue(lockedDoc),
      });

      await expect(
        authService.login({
          email: 'dr.jane@clinic.com',
          password: 'ValidPassword123!',
        }),
      ).rejects.toThrow('Account is temporarily locked');
    });

    it('should auto-unlock account when lockout period has elapsed', async () => {
      const expiredLockDoc = {
        ...mockDoctor,
        status: DoctorStatus.LOCKED,
        lockUntil: new Date(Date.now() - 1000), // Expired!
        save: vi.fn(),
      };
      mockDoctorModel.findOne.mockReturnValue({
        select: vi.fn().mockResolvedValue(expiredLockDoc),
      });
      mockPasswordService.verifyPassword.mockResolvedValue(true);
      mockPasswordService.needsRehash.mockReturnValue(false);
      mockTokenService.generateAccessToken.mockResolvedValue('new-token');
      mockTokenService.createRefreshSession.mockResolvedValue({
        refreshToken: 'b'.repeat(64),
      });

      const result = await authService.login({
        email: 'dr.jane@clinic.com',
        password: 'ValidPassword123!',
      });

      expect(result.accessToken).toBe('new-token');
      expect(expiredLockDoc.status).toBe(DoctorStatus.ACTIVE);
      expect(expiredLockDoc.failedLoginAttempts).toBe(0);
      expect(expiredLockDoc.lockUntil).toBeNull();
    });

    it('should reject login if account is disabled', async () => {
      const disabledDoc = { ...mockDoctor, status: DoctorStatus.DISABLED };
      mockDoctorModel.findOne.mockReturnValue({
        select: vi.fn().mockResolvedValue(disabledDoc),
      });

      await expect(
        authService.login({
          email: 'dr.jane@clinic.com',
          password: 'ValidPassword123!',
        }),
      ).rejects.toThrow('Account is disabled');
    });

    it('should reject login if account verification is pending', async () => {
      const pendingDoc = {
        ...mockDoctor,
        status: DoctorStatus.PENDING_VERIFICATION,
      };
      mockDoctorModel.findOne.mockReturnValue({
        select: vi.fn().mockResolvedValue(pendingDoc),
      });

      await expect(
        authService.login({
          email: 'dr.jane@clinic.com',
          password: 'ValidPassword123!',
        }),
      ).rejects.toThrow('Account verification is pending');
    });
  });

  describe('forgotPassword', () => {
    it('should generate single-use token, save hash, send mail, and return generic response for active doctor', async () => {
      const doctorId = new Types.ObjectId();
      mockDoctorModel.findOne.mockResolvedValue({
        _id: doctorId,
        email: 'doctor@clinic.com',
        status: DoctorStatus.ACTIVE,
      });
      mockResetModel.updateMany.mockResolvedValue({ modifiedCount: 0 });
      mockResetModel.create.mockResolvedValue({});
      mockMailService.sendPasswordResetEmail.mockResolvedValue(true);

      const result = await authService.forgotPassword({
        email: 'doctor@clinic.com',
      });

      expect(result.message).toContain(
        'If an account exists with this email address',
      );
      expect(mockResetModel.create).toHaveBeenCalled();
      expect(mockMailService.sendPasswordResetEmail).toHaveBeenCalled();
    });

    it('should return identical generic response for nonexistent doctor without sending email', async () => {
      mockDoctorModel.findOne.mockResolvedValue(null);

      const result = await authService.forgotPassword({
        email: 'ghost@clinic.com',
      });

      expect(result.message).toContain(
        'If an account exists with this email address',
      );
      expect(mockResetModel.create).not.toHaveBeenCalled();
      expect(mockMailService.sendPasswordResetEmail).not.toHaveBeenCalled();
    });
  });

  describe('resetPassword', () => {
    const doctorId = new Types.ObjectId();

    it('should reset password, mark token used, update hash with Argon2id, and invalidate all doctor sessions', async () => {
      const resetRecord = {
        _id: new Types.ObjectId(),
        doctorId,
        tokenHash: 'hash-abc',
        used: false,
        expiresAt: new Date(Date.now() + 600000),
        save: vi.fn(),
      };

      const doctorDoc = {
        _id: doctorId,
        status: DoctorStatus.LOCKED,
        passwordHash: 'old-hash',
        failedLoginAttempts: 5,
        lockUntil: new Date(),
        save: vi.fn(),
      };

      mockResetModel.findOne.mockResolvedValue(resetRecord);
      mockDoctorModel.findById.mockResolvedValue(doctorDoc);
      mockPasswordService.hashPassword.mockResolvedValue(
        '$argon2id$new_secure_hash',
      );
      mockTokenService.revokeAllDoctorSessions.mockResolvedValue(3);

      const result = await authService.resetPassword({
        token: 'a'.repeat(64),
        newPassword: 'BrandNewStrongPassword2026!',
      });

      expect(result.message).toContain('Password has been reset successfully');
      expect(resetRecord.used).toBe(true);
      expect(resetRecord.save).toHaveBeenCalled();
      expect(doctorDoc.passwordHash).toBe('$argon2id$new_secure_hash');
      expect(doctorDoc.status).toBe(DoctorStatus.ACTIVE);
      expect(doctorDoc.failedLoginAttempts).toBe(0);
      expect(doctorDoc.lockUntil).toBeNull();
      expect(doctorDoc.save).toHaveBeenCalled();

      // Ensure all active sessions were revoked
      expect(mockTokenService.revokeAllDoctorSessions).toHaveBeenCalledWith(
        doctorId,
      );
    });

    it('should reject reset if token is expired', async () => {
      mockResetModel.findOne.mockResolvedValue({
        used: false,
        expiresAt: new Date(Date.now() - 10000), // Expired!
      });

      await expect(
        authService.resetPassword({
          token: 'b'.repeat(64),
          newPassword: 'StrongPassword123!',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject reset if token was already used (replay attack)', async () => {
      mockResetModel.findOne.mockResolvedValue({
        used: true, // Already used!
        expiresAt: new Date(Date.now() + 100000),
      });

      await expect(
        authService.resetPassword({
          token: 'c'.repeat(64),
          newPassword: 'StrongPassword123!',
        }),
      ).rejects.toThrow('Invalid or expired password reset token.');
    });

    it('should reject reset if new password does not meet complexity requirements', async () => {
      mockResetModel.findOne.mockResolvedValue({
        used: false,
        expiresAt: new Date(Date.now() + 100000),
      });
      mockDoctorModel.findById.mockResolvedValue({
        status: DoctorStatus.ACTIVE,
      });

      await expect(
        authService.resetPassword({
          token: 'd'.repeat(64),
          newPassword: 'weak',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
