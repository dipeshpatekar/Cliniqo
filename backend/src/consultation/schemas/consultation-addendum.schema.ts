import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ConsultationAddendumDocument = ConsultationAddendum &
  Document<Types.ObjectId>;

@Schema({
  timestamps: { createdAt: true, updatedAt: false },
  collection: 'consultation_addenda',
})
export class ConsultationAddendum {
  @Prop({ type: Types.ObjectId, ref: 'Clinic', required: true, index: true })
  clinicId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Consultation', required: true, index: true })
  consultationId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Patient', required: true, index: true })
  patientId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Doctor', required: true })
  authorDoctorId: Types.ObjectId;

  @Prop({ type: String, required: true, trim: true, maxlength: 2000 })
  note: string;

  @Prop({ type: String, required: true, trim: true, maxlength: 500 })
  reasonForAddendum: string;

  @Prop({ type: Number, required: true })
  sequenceNumber: number;

  @Prop({ default: Date.now })
  createdAt: Date;
}

export const ConsultationAddendumSchema =
  SchemaFactory.createForClass(ConsultationAddendum);

// Hard compound unique index for sequential ordering per consultation
ConsultationAddendumSchema.index(
  { consultationId: 1, sequenceNumber: 1 },
  { unique: true, name: 'uniq_consultation_addendum_sequence' },
);

ConsultationAddendumSchema.index({ clinicId: 1, createdAt: -1 });

// Application-layer pre-hook defense: disallow updates or deletes
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
  ConsultationAddendumSchema.pre(method as any, function () {
    throw new Error(
      'ConsultationAddendum records are append-only and strictly immutable.',
    );
  });
}
