import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import crypto from 'node:crypto';
import os from 'node:os';
import { ConfigService } from '../config/config.service.js';
import { MailService } from '../auth/mail.service.js';
import {
  InvitationOutbox,
  type InvitationOutboxDocument,
  OutboxStatus,
} from './schemas/invitation-outbox.schema.js';
import {
  ClinicInvitation,
  type ClinicInvitationDocument,
  ClinicInvitationStatus,
} from './schemas/clinic-invitation.schema.js';

export interface OutboxPayload {
  rawToken: string;
  recipientEmail: string;
  clinicName: string;
  role: string;
}

@Injectable()
export class ClinicOutboxService {
  private readonly logger = new Logger(ClinicOutboxService.name);
  readonly workerId: string;
  private readonly leaseDurationMs = 5 * 60 * 1000; // 5-minute lease duration

  constructor(
    @InjectModel(InvitationOutbox.name)
    private readonly outboxModel: Model<InvitationOutboxDocument>,
    @InjectModel(ClinicInvitation.name)
    private readonly invitationModel: Model<ClinicInvitationDocument>,
    private readonly mailService: MailService,
    private readonly configService: ConfigService,
  ) {
    this.workerId = `${os.hostname()}-${process.pid}-${crypto.randomUUID()}`;
  }

  /**
   * Encrypts an outbox delivery payload using AES-256-GCM at rest.
   */
  encryptPayload(payload: OutboxPayload): {
    encryptedPayload: string;
    iv: string;
    authTag: string;
  } {
    const key = this.configService.validateOutboxConfig();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    const serialized = JSON.stringify(payload);
    let encrypted = cipher.update(serialized, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');

    return {
      encryptedPayload: encrypted,
      iv: iv.toString('hex'),
      authTag,
    };
  }

  /**
   * Decrypts an encrypted outbox payload in memory.
   */
  decryptPayload(
    encryptedPayload: string,
    ivHex: string,
    authTagHex: string,
  ): OutboxPayload {
    const key = this.configService.validateOutboxConfig();
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedPayload, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return JSON.parse(decrypted) as OutboxPayload;
  }

  /**
   * Claims and dispatches a specific outbox job atomically.
   */
  async dispatchJob(outboxId: Types.ObjectId): Promise<boolean> {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + this.leaseDurationMs);

    // 1. Atomic lease acquisition
    const job = await this.outboxModel.findOneAndUpdate(
      {
        _id: outboxId,
        status: { $in: [OutboxStatus.PENDING, OutboxStatus.PROCESSING] },
        $or: [
          { status: OutboxStatus.PENDING },
          { leaseExpiresAt: { $lte: now } }, // Reclaim expired lease
        ],
      },
      {
        $set: {
          status: OutboxStatus.PROCESSING,
          processingStartedAt: now,
          leaseExpiresAt,
          lockedByWorkerId: this.workerId,
        },
      },
      { new: true },
    );

    if (!job) {
      // Job already claimed by another worker or in terminal state
      return false;
    }

    return this.executeClaimedJob(job);
  }

  /**
   * Executes email delivery for an acquired outbox job.
   */
  private async executeClaimedJob(
    job: InvitationOutboxDocument,
  ): Promise<boolean> {
    // 2. Pre-dispatch validity checks
    const invitation = await this.invitationModel.findById(job.invitationId);
    if (!invitation) {
      await this.cancelJob(job._id, 'Associated invitation no longer exists');
      return false;
    }

    if (
      invitation.status !== ClinicInvitationStatus.PENDING ||
      invitation.expiresAt <= new Date()
    ) {
      await this.cancelJob(
        job._id,
        `Invitation is in state ${invitation.status} or expired; delivery cancelled`,
      );
      return false;
    }

    if (!job.encryptedPayload || !job.iv || !job.authTag) {
      await this.failJob(job._id, 'Missing encrypted payload components');
      return false;
    }

    // 3. Decrypt payload in memory
    let payload: OutboxPayload;
    try {
      payload = this.decryptPayload(job.encryptedPayload, job.iv, job.authTag);
    } catch (err: any) {
      this.logger.error(
        `[${job.correlationId}] Failed to decrypt outbox payload: ${err?.message}`,
      );
      await this.failJob(
        job._id,
        'Decryption failed: outbox encryption key may have been rotated',
      );
      return false;
    }

    // 4. Pre-dispatch lease ownership check
    const isStillOwner = await this.outboxModel.exists({
      _id: job._id,
      status: OutboxStatus.PROCESSING,
      lockedByWorkerId: this.workerId,
      leaseExpiresAt: { $gt: new Date() },
    });

    if (!isStillOwner) {
      this.logger.warn(
        `[${job.correlationId}] Lost processing lease for job ${job._id.toString()} before dispatch. Aborting email send.`,
      );
      return false;
    }

    // 5. Dispatch email via MailService (Bounded SMTP timeout strictly < lease duration)
    const delivered = await this.mailService.sendClinicInvitationEmail(
      payload.recipientEmail,
      payload.clinicName,
      payload.role,
      payload.rawToken,
    );

    if (delivered) {
      // 6. Conditional completion update matching workerId
      const completed = await this.outboxModel.findOneAndUpdate(
        {
          _id: job._id,
          status: OutboxStatus.PROCESSING,
          lockedByWorkerId: this.workerId,
        },
        {
          $set: {
            status: OutboxStatus.SENT,
            sentAt: new Date(),
            encryptedPayload: null, // Forward secrecy: destroy encrypted token
            iv: null,
            authTag: null,
            lockedByWorkerId: null,
            leaseExpiresAt: null,
            errorSummary: null,
          },
        },
        { new: true },
      );

      if (!completed) {
        this.logger.warn(
          `[${job.correlationId}] Job ${job._id.toString()} sent via SMTP but lease was lost during transmission.`,
        );
      }
      return true;
    }

    // 7. Delivery failed: handle retry with exponential backoff
    const nextAttemptCount = job.attempts + 1;
    const isExhausted = nextAttemptCount >= job.maxAttempts;

    if (isExhausted) {
      await this.outboxModel.findOneAndUpdate(
        {
          _id: job._id,
          status: OutboxStatus.PROCESSING,
          lockedByWorkerId: this.workerId,
        },
        {
          $set: {
            status: OutboxStatus.FAILED,
            attempts: nextAttemptCount,
            encryptedPayload: null, // Wipe payload on terminal failure
            iv: null,
            authTag: null,
            lockedByWorkerId: null,
            leaseExpiresAt: null,
            errorSummary: 'Maximum SMTP delivery attempts exhausted',
          },
        },
      );
    } else {
      const backoffMinutes = Math.pow(2, nextAttemptCount); // 2m, 4m...
      const nextAttemptAt = new Date(Date.now() + backoffMinutes * 60 * 1000);

      await this.outboxModel.findOneAndUpdate(
        {
          _id: job._id,
          status: OutboxStatus.PROCESSING,
          lockedByWorkerId: this.workerId,
        },
        {
          $set: {
            status: OutboxStatus.PENDING,
            attempts: nextAttemptCount,
            nextAttemptAt,
            lockedByWorkerId: null,
            leaseExpiresAt: null,
            errorSummary: 'SMTP delivery failed; scheduled for retry',
          },
        },
      );
    }

    return false;
  }

  private async cancelJob(
    jobId: Types.ObjectId,
    reason: string,
  ): Promise<void> {
    await this.outboxModel.updateOne(
      { _id: jobId },
      {
        $set: {
          status: OutboxStatus.CANCELLED,
          encryptedPayload: null,
          iv: null,
          authTag: null,
          lockedByWorkerId: null,
          leaseExpiresAt: null,
          errorSummary: reason,
        },
      },
    );
  }

  private async failJob(jobId: Types.ObjectId, reason: string): Promise<void> {
    await this.outboxModel.updateOne(
      { _id: jobId },
      {
        $set: {
          status: OutboxStatus.FAILED,
          encryptedPayload: null,
          iv: null,
          authTag: null,
          lockedByWorkerId: null,
          leaseExpiresAt: null,
          errorSummary: reason,
        },
      },
    );
  }

  /**
   * Sweeps pending outbox jobs that are due for delivery.
   */
  async processPendingOutboxSweep(): Promise<number> {
    const now = new Date();
    const pendingJobs = await this.outboxModel
      .find({
        status: OutboxStatus.PENDING,
        nextAttemptAt: { $lte: now },
      })
      .sort({ nextAttemptAt: 1 })
      .limit(10)
      .lean();

    let processedCount = 0;
    for (const job of pendingJobs) {
      const success = await this.dispatchJob(job._id as Types.ObjectId);
      if (success) processedCount++;
    }

    return processedCount;
  }

  /**
   * Reclaims stale PROCESSING jobs whose lease has expired.
   */
  async reclaimStaleJobsSweep(): Promise<number> {
    const now = new Date();
    const staleJobs = await this.outboxModel
      .find({
        status: OutboxStatus.PROCESSING,
        leaseExpiresAt: { $lte: now },
        attempts: { $lt: 3 },
      })
      .sort({ processingStartedAt: 1 })
      .limit(10)
      .lean();

    let reclaimedCount = 0;
    for (const job of staleJobs) {
      const success = await this.dispatchJob(job._id as Types.ObjectId);
      if (success) reclaimedCount++;
    }

    return reclaimedCount;
  }
}
