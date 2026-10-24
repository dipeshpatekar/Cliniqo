import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export enum ClinicInvitationStatus {
  PENDING = 'PENDING',
  ACCEPTED = 'ACCEPTED',
  DECLINED = 'DECLINED',
  CANCELLED = 'CANCELLED',
  EXPIRED = 'EXPIRED',
}

export type ClinicInvitationDocument = ClinicInvitation &
  Document<Types.ObjectId>;

@Schema({ timestamps: true, collection: 'clinic_invitations' })
export class ClinicInvitation {
  @Prop({ type: Types.ObjectId, ref: 'Clinic', required: true })
  clinicId: Types.ObjectId;

  @Prop({ required: true, lowercase: true, trim: true })
  inviteeEmail: string;

  // Role is strictly restricted to DOCTOR or STAFF. Invitations can never grant OWNER privileges.
  @Prop({ type: String, required: true, enum: ['DOCTOR', 'STAFF'] })
  role: string;

  @Prop({
    type: String,
    required: true,
    enum: Object.values(ClinicInvitationStatus),
    default: ClinicInvitationStatus.PENDING,
  })
  status: ClinicInvitationStatus;

  @Prop({ type: Types.ObjectId, ref: 'Doctor', required: true })
  invitedBy: Types.ObjectId;

  @Prop({ required: true })
  invitationTokenHash: string;

  @Prop({ required: true })
  expiresAt: Date;

  @Prop({ type: Date, default: null })
  respondedAt?: Date | null;

  @Prop({ type: Types.ObjectId, ref: 'Doctor', default: null })
  respondedByDoctorId?: Types.ObjectId | null;

  // Dedicated retention timestamp for TTL background cleanup; expiresAt is NEVER used for TTL.
  @Prop({ type: Date, default: null })
  retentionExpiresAt?: Date | null;

  createdAt?: Date;
  updatedAt?: Date;
}

export const ClinicInvitationSchema =
  SchemaFactory.createForClass(ClinicInvitation);

// 1. Concurrency-safe deduplication: at most ONE pending invitation per email per clinic
ClinicInvitationSchema.index(
  { clinicId: 1, inviteeEmail: 1 },
  { unique: true, partialFilterExpression: { status: 'PENDING' } },
);

// 2. Token lookup
ClinicInvitationSchema.index({ invitationTokenHash: 1 }, { unique: true });

// 3. Application query optimizations
ClinicInvitationSchema.index({ inviteeEmail: 1, status: 1, expiresAt: 1 });
ClinicInvitationSchema.index({ clinicId: 1, status: 1 });

// 4. Background TTL retention cleanup
ClinicInvitationSchema.index(
  { retentionExpiresAt: 1 },
  { expireAfterSeconds: 0, sparse: true },
);
