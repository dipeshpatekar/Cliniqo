import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export enum ClinicAuditAction {
  CLINIC_CREATED = 'CLINIC_CREATED',
  CLINIC_SUSPENDED = 'CLINIC_SUSPENDED',
  CLINIC_REACTIVATED = 'CLINIC_REACTIVATED',
  CLINIC_ARCHIVED = 'CLINIC_ARCHIVED',
  OWNERSHIP_TRANSFERRED = 'OWNERSHIP_TRANSFERRED',
  MEMBER_INVITED = 'MEMBER_INVITED',
  MEMBER_INVITATION_ACCEPTED = 'MEMBER_INVITATION_ACCEPTED',
  MEMBER_INVITATION_DECLINED = 'MEMBER_INVITATION_DECLINED',
  MEMBER_INVITATION_CANCELLED = 'MEMBER_INVITATION_CANCELLED',
  MEMBER_REVOKED = 'MEMBER_REVOKED',
  PATIENT_CREATED = 'PATIENT_CREATED',
  PATIENT_UPDATED = 'PATIENT_UPDATED',
  PATIENT_ARCHIVED = 'PATIENT_ARCHIVED',
}

export type ClinicAuditLogDocument = ClinicAuditLog & Document<Types.ObjectId>;

@Schema({
  timestamps: { createdAt: true, updatedAt: false },
  collection: 'clinic_audit_logs',
})
export class ClinicAuditLog {
  @Prop({ type: Types.ObjectId, ref: 'Clinic', required: true })
  clinicId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Doctor', required: true })
  actorDoctorId: Types.ObjectId;

  @Prop({
    type: String,
    required: true,
    enum: Object.values(ClinicAuditAction),
  })
  action: ClinicAuditAction;

  @Prop({ type: Types.ObjectId, ref: 'Doctor', default: null })
  targetDoctorId?: Types.ObjectId | null;

  @Prop({ type: String, default: null, lowercase: true, trim: true })
  targetEmail?: string | null;

  @Prop({ type: String, default: null })
  role?: string | null;

  @Prop({ type: String, default: null })
  reason?: string | null;

  @Prop({ type: Object, default: null })
  metadata?: Record<string, any> | null;

  @Prop({ default: Date.now })
  timestamp: Date;
}

export const ClinicAuditLogSchema =
  SchemaFactory.createForClass(ClinicAuditLog);

ClinicAuditLogSchema.index({ clinicId: 1, timestamp: -1 });
ClinicAuditLogSchema.index({ actorDoctorId: 1, timestamp: -1 });
ClinicAuditLogSchema.index({ action: 1, timestamp: -1 });

// Application-layer immutability guard: disallow updates or deletes
const immutableMethods = [
  'updateOne',
  'updateMany',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
  'findOneAndReplace',
  'findOneAndUpdate',
];

for (const method of immutableMethods) {
  ClinicAuditLogSchema.pre(method as any, function () {
    throw new Error(
      'ClinicAuditLog records are append-only and strictly immutable.',
    );
  });
}
