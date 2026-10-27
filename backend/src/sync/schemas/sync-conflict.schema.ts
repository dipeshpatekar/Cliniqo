import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type SyncConflictDocument = SyncConflict & Document<Types.ObjectId>;

export enum SyncConflictStatus {
  OPEN = 'OPEN',
  RESOLVED = 'RESOLVED',
}

@Schema({
  timestamps: true,
  collection: 'sync_conflicts',
})
export class SyncConflict {
  @Prop({ type: Types.ObjectId, ref: 'Clinic', required: true, index: true })
  clinicId: Types.ObjectId;

  @Prop({ type: String, required: true, trim: true })
  outboxId: string;

  @Prop({ type: String, required: true, trim: true })
  entityType: string;

  @Prop({ type: String, required: true, trim: true })
  entityId: string;

  @Prop({ type: Number, required: true })
  serverVersion: number;

  @Prop({ type: Number, required: true })
  clientVersion: number;

  @Prop({ type: String, required: true, trim: true })
  conflictReason: string;

  @Prop({ type: Object, default: null })
  serverPayload?: Record<string, any> | null;

  @Prop({ type: Object, required: true })
  clientPayload: Record<string, any>;

  @Prop({ type: [String], default: [] })
  conflictFields: string[];

  @Prop({
    type: String,
    required: true,
    enum: Object.values(SyncConflictStatus),
    default: SyncConflictStatus.OPEN,
    index: true,
  })
  status: SyncConflictStatus;

  @Prop({ type: Date, default: null })
  resolvedAt?: Date | null;

  @Prop({ type: Types.ObjectId, ref: 'Doctor', default: null })
  resolvedBy?: Types.ObjectId | null;

  createdAt?: Date;
  updatedAt?: Date;
}

export const SyncConflictSchema = SchemaFactory.createForClass(SyncConflict);

SyncConflictSchema.index({ clinicId: 1, status: 1, createdAt: -1 });
SyncConflictSchema.index({ clinicId: 1, outboxId: 1 });
