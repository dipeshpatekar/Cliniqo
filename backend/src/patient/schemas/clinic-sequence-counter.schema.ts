import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ClinicSequenceCounterDocument = ClinicSequenceCounter &
  Document<Types.ObjectId>;

@Schema({
  timestamps: true,
  collection: 'clinic_counters',
})
export class ClinicSequenceCounter {
  @Prop({ type: Types.ObjectId, ref: 'Clinic', required: true, index: true })
  clinicId: Types.ObjectId;

  @Prop({ type: String, required: true, trim: true })
  sequenceName: string;

  @Prop({ type: Number, required: true, default: 100 })
  seq: number;

  createdAt?: Date;
  updatedAt?: Date;
}

export const ClinicSequenceCounterSchema =
  SchemaFactory.createForClass(ClinicSequenceCounter);

ClinicSequenceCounterSchema.index(
  { clinicId: 1, sequenceName: 1 },
  { unique: true },
);
