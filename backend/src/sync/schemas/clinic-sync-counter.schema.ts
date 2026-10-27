import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ClinicSyncCounterDocument = ClinicSyncCounter &
  Document<Types.ObjectId>;

@Schema({
  timestamps: true,
  collection: 'clinic_sync_counters',
})
export class ClinicSyncCounter {
  @Prop({ type: Types.ObjectId, ref: 'Clinic', required: true, unique: true })
  clinicId: Types.ObjectId;

  @Prop({ type: Number, required: true, default: 0 })
  lastSeq: number;

  createdAt?: Date;
  updatedAt?: Date;
}

export const ClinicSyncCounterSchema =
  SchemaFactory.createForClass(ClinicSyncCounter);
