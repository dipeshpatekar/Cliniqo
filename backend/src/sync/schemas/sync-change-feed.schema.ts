import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type SyncChangeFeedDocument = SyncChangeFeed & Document<Types.ObjectId>;

export enum SyncEntityType {
  PATIENT = 'PATIENT',
  CONSULTATION = 'CONSULTATION',
  PRESCRIPTION = 'PRESCRIPTION',
  PRESCRIPTION_REVISION = 'PRESCRIPTION_REVISION',
  CONSULTATION_ADDENDUM = 'CONSULTATION_ADDENDUM',
}

export enum SyncActionType {
  CREATE = 'CREATE',
  UPDATE = 'UPDATE',
  FINALIZE = 'FINALIZE',
  CANCEL = 'CANCEL',
  DISCONTINUE = 'DISCONTINUE',
  REVISE = 'REVISE',
}

@Schema({
  timestamps: { createdAt: true, updatedAt: false },
  collection: 'sync_change_feed',
})
export class SyncChangeFeed {
  @Prop({ type: Types.ObjectId, ref: 'Clinic', required: true, index: true })
  clinicId: Types.ObjectId;

  @Prop({ type: Number, required: true })
  seq: number;

  @Prop({
    type: String,
    required: true,
    enum: Object.values(SyncEntityType),
  })
  entityType: SyncEntityType;

  @Prop({ type: String, required: true, trim: true })
  entityId: string;

  @Prop({ type: String, trim: true, default: null })
  clientEntityId?: string | null;

  @Prop({
    type: String,
    required: true,
    enum: Object.values(SyncActionType),
  })
  action: SyncActionType;

  @Prop({ type: Number, required: true })
  version: number;

  @Prop({ type: Object, required: true })
  payload: Record<string, any>;

  @Prop({ type: Date, required: true, default: Date.now })
  committedAt: Date;

  @Prop({ type: Types.ObjectId, ref: 'Doctor', required: true })
  actorDoctorId: Types.ObjectId;
}

export const SyncChangeFeedSchema = SchemaFactory.createForClass(SyncChangeFeed);

// Enforce strict uniqueness and ascending order on sequential change stream per clinic
SyncChangeFeedSchema.index(
  { clinicId: 1, seq: 1 },
  { unique: true, name: 'uniq_clinic_sync_seq' },
);

SyncChangeFeedSchema.index({ clinicId: 1, committedAt: 1 });
SyncChangeFeedSchema.index({ clinicId: 1, entityType: 1, entityId: 1 });
