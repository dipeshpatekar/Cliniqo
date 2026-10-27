import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession } from 'mongoose';
import { Model, Types } from 'mongoose';
import {
  ClinicAuditLog,
  type ClinicAuditLogDocument,
  ClinicAuditAction,
} from './schemas/clinic-audit-log.schema.js';

export interface AuditLogInput {
  clinicId: Types.ObjectId;
  actorDoctorId: Types.ObjectId;
  action: ClinicAuditAction;
  targetDoctorId?: Types.ObjectId | null;
  targetEmail?: string | null;
  role?: string | null;
  reason?: string | null;
  metadata?: Record<string, any> | null;
}

@Injectable()
export class ClinicAuditService {
  private readonly logger = new Logger(ClinicAuditService.name);

  constructor(
    @InjectModel(ClinicAuditLog.name)
    private readonly auditLogModel: Model<ClinicAuditLogDocument>,
  ) {}

  /**
   * Appends an immutable audit log entry.
   * If a transaction session is provided, the insert is atomic with the business operation.
   */
  async logEvent(
    data: AuditLogInput,
    session?: ClientSession,
  ): Promise<ClinicAuditLogDocument> {
    const docs = await this.auditLogModel.create(
      [
        {
          clinicId: data.clinicId,
          actorDoctorId: data.actorDoctorId,
          action: data.action,
          targetDoctorId: data.targetDoctorId || null,
          targetEmail: data.targetEmail ? data.targetEmail.toLowerCase().trim() : null,
          role: data.role || null,
          reason: data.reason || null,
          metadata: data.metadata || null,
          timestamp: new Date(),
        },
      ],
      session ? { session } : undefined,
    );
    return docs[0];
  }

  /**
   * Retrieves paginated audit logs for a clinic.
   * Read-only access for clinic owners.
   */
  async listClinicAuditLogs(
    clinicId: Types.ObjectId,
    page: number = 1,
    limit: number = 50,
  ): Promise<{ logs: ClinicAuditLogDocument[]; total: number; page: number; limit: number }> {
    const skip = (Math.max(1, page) - 1) * limit;

    const [logs, total] = await Promise.all([
      this.auditLogModel
        .find({ clinicId })
        .populate('actorDoctorId', 'firstName lastName email')
        .populate('targetDoctorId', 'firstName lastName email')
        .sort({ timestamp: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      this.auditLogModel.countDocuments({ clinicId }),
    ]);

    return {
      logs: logs as any,
      total,
      page,
      limit,
    };
  }
}
