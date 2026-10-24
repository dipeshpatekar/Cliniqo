import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Types } from 'mongoose';
import { ClinicOutboxService } from './clinic-outbox.service.js';
import { OutboxStatus } from './schemas/invitation-outbox.schema.js';
import { ClinicInvitationStatus } from './schemas/clinic-invitation.schema.js';

describe('ClinicOutboxService (Unit)', () => {
  let outboxService: ClinicOutboxService;
  let mockOutboxModel: any;
  let mockInvitationModel: any;
  let mockMailService: any;
  let mockConfigService: any;

  const validKeyHex =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const validKeyBuffer = Buffer.from(validKeyHex, 'hex');

  beforeEach(() => {
    mockConfigService = {
      validateOutboxConfig: vi.fn().mockReturnValue(validKeyBuffer),
    };

    mockMailService = {
      sendClinicInvitationEmail: vi.fn().mockResolvedValue(true),
    };

    mockOutboxModel = {
      findOneAndUpdate: vi.fn(),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
      exists: vi.fn().mockResolvedValue(true),
      find: vi.fn().mockReturnValue({
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            lean: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    };

    mockInvitationModel = {
      findById: vi.fn().mockResolvedValue({
        _id: new Types.ObjectId(),
        status: ClinicInvitationStatus.PENDING,
        expiresAt: new Date(Date.now() + 86400000),
      }),
    };

    outboxService = new ClinicOutboxService(
      mockOutboxModel,
      mockInvitationModel,
      mockMailService,
      mockConfigService,
    );
  });

  describe('Payload Encryption & Decryption (AES-256-GCM)', () => {
    it('encrypts and decrypts payload faithfully with authentication tag', () => {
      const payload = {
        rawToken: 'secure-token-1234567890abcdef',
        recipientEmail: 'dr.smith@example.com',
        clinicName: 'Alpha Medical Care',
        role: 'DOCTOR',
      };

      const encrypted = outboxService.encryptPayload(payload);
      expect(encrypted.encryptedPayload).toBeDefined();
      expect(encrypted.iv).toHaveLength(24); // 12 bytes = 24 hex chars
      expect(encrypted.authTag).toHaveLength(32); // 16 bytes = 32 hex chars

      const decrypted = outboxService.decryptPayload(
        encrypted.encryptedPayload,
        encrypted.iv,
        encrypted.authTag,
      );

      expect(decrypted).toEqual(payload);
    });

    it('fails safely and throws error if ciphertext or tag was tampered with', () => {
      const payload = {
        rawToken: 'token-to-tamper',
        recipientEmail: 'tamper@example.com',
        clinicName: 'Beta Medical',
        role: 'STAFF',
      };

      const encrypted = outboxService.encryptPayload(payload);

      // Alter authTag to simulate tampering or wrong key
      const tamperedTag = '00000000000000000000000000000000';

      expect(() =>
        outboxService.decryptPayload(
          encrypted.encryptedPayload,
          encrypted.iv,
          tamperedTag,
        ),
      ).toThrow();
    });
  });

  describe('Outbox Claiming & Dispatch Flow', () => {
    it('claims lease and marks job SENT with forward secrecy payload wipe on success', async () => {
      const outboxId = new Types.ObjectId();
      const payload = {
        rawToken: 'test-raw-token',
        recipientEmail: 'doc@example.com',
        clinicName: 'Test Clinic',
        role: 'DOCTOR',
      };
      const encrypted = outboxService.encryptPayload(payload);

      const mockJob: any = {
        _id: outboxId,
        invitationId: new Types.ObjectId(),
        correlationId: 'test-correlation-id',
        status: OutboxStatus.PROCESSING,
        attempts: 0,
        maxAttempts: 3,
        encryptedPayload: encrypted.encryptedPayload,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
      };

      mockOutboxModel.findOneAndUpdate
        .mockResolvedValueOnce(mockJob) // First call: claim lease
        .mockResolvedValueOnce({ ...mockJob, status: OutboxStatus.SENT }); // Second call: mark SENT

      const dispatched = await outboxService.dispatchJob(outboxId);

      expect(dispatched).toBe(true);
      expect(mockMailService.sendClinicInvitationEmail).toHaveBeenCalledWith(
        payload.recipientEmail,
        payload.clinicName,
        payload.role,
        payload.rawToken,
      );

      // Verify forward secrecy wipe: encryptedPayload, iv, authTag set to null
      expect(mockOutboxModel.findOneAndUpdate).toHaveBeenCalledWith(
        {
          _id: outboxId,
          status: OutboxStatus.PROCESSING,
          lockedByWorkerId: outboxService.workerId,
        },
        expect.objectContaining({
          $set: expect.objectContaining({
            status: OutboxStatus.SENT,
            encryptedPayload: null,
            iv: null,
            authTag: null,
            lockedByWorkerId: null,
          }),
        }),
        expect.anything(),
      );
    });

    it('cancels outbox job without sending email if associated invitation was already accepted or expired', async () => {
      const outboxId = new Types.ObjectId();
      mockInvitationModel.findById.mockResolvedValue({
        status: ClinicInvitationStatus.ACCEPTED, // Already accepted!
        expiresAt: new Date(Date.now() + 86400000),
      });

      const mockJob: any = {
        _id: outboxId,
        invitationId: new Types.ObjectId(),
        correlationId: 'test-correlation-id',
        status: OutboxStatus.PROCESSING,
        attempts: 0,
        maxAttempts: 3,
      };

      mockOutboxModel.findOneAndUpdate.mockResolvedValue(mockJob);

      const dispatched = await outboxService.dispatchJob(outboxId);

      expect(dispatched).toBe(false);
      expect(mockMailService.sendClinicInvitationEmail).not.toHaveBeenCalled();
      expect(mockOutboxModel.updateOne).toHaveBeenCalledWith(
        { _id: outboxId },
        expect.objectContaining({
          $set: expect.objectContaining({
            status: OutboxStatus.CANCELLED,
            encryptedPayload: null,
          }),
        }),
      );
    });

    it('aborts dispatch if worker lease is lost before transmission', async () => {
      const outboxId = new Types.ObjectId();
      const payload = {
        rawToken: 'token',
        recipientEmail: 'doc@example.com',
        clinicName: 'Clinic',
        role: 'DOCTOR',
      };
      const encrypted = outboxService.encryptPayload(payload);

      const mockJob: any = {
        _id: outboxId,
        invitationId: new Types.ObjectId(),
        correlationId: 'test-correlation-id',
        status: OutboxStatus.PROCESSING,
        attempts: 0,
        maxAttempts: 3,
        encryptedPayload: encrypted.encryptedPayload,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
      };

      mockOutboxModel.findOneAndUpdate.mockResolvedValue(mockJob);
      mockOutboxModel.exists.mockResolvedValue(false); // Lease lost!

      const dispatched = await outboxService.dispatchJob(outboxId);

      expect(dispatched).toBe(false);
      expect(mockMailService.sendClinicInvitationEmail).not.toHaveBeenCalled();
    });
  });
});
