import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import {
  PrescriptionItem,
  PrescriptionItemSchema,
} from './prescription-item.schema.js';
import {
  ProvisionalMedicine,
  ProvisionalMedicineSchema,
} from '../../consultation/schemas/consultation.schema.js';

export type PrescriptionRevisionDocument = PrescriptionRevision &
  Document<Types.ObjectId>;

@Schema({ _id: false })
export class PrescriptionClinicalSnapshot {
  @Prop({ type: Types.ObjectId, required: true })
  consultationId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true })
  patientId: Types.ObjectId;

  @Prop({ type: String, required: true, trim: true })
  patientCode: string;

  @Prop({ type: Types.ObjectId, required: true })
  doctorId: Types.ObjectId;

  @Prop({ type: Date, required: true })
  consultationDate: Date;

  @Prop({ type: String, required: true, trim: true })
  chiefComplaint: string;

  @Prop({ type: String, required: true, trim: true })
  diagnosis: string;

  @Prop({ type: Object, default: () => ({}) })
  vitals: Record<string, any>;

  @Prop({ type: [ProvisionalMedicineSchema], default: [] })
  provisionalMedicines: ProvisionalMedicine[];
}

export const PrescriptionClinicalSnapshotSchema =
  SchemaFactory.createForClass(PrescriptionClinicalSnapshot);

@Schema({
  timestamps: { createdAt: true, updatedAt: false },
  collection: 'prescription_revisions',
})
export class PrescriptionRevision {
  @Prop({ type: Types.ObjectId, ref: 'Clinic', required: true, index: true })
  clinicId: Types.ObjectId;

  @Prop({
    type: Types.ObjectId,
    ref: 'Prescription',
    required: true,
    index: true,
  })
  prescriptionId: Types.ObjectId;

  @Prop({
    type: Types.ObjectId,
    ref: 'Consultation',
    required: true,
    index: true,
  })
  consultationId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Patient', required: true, index: true })
  patientId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Doctor', required: true })
  prescribedBy: Types.ObjectId;

  @Prop({ type: Number, required: true })
  revisionNumber: number;

  @Prop({ type: String, required: true, trim: true, maxlength: 500 })
  reasonForRevision: string;

  @Prop({
    type: [PrescriptionItemSchema],
    required: true,
    validate: [
      (val: any[]) => Array.isArray(val) && val.length > 0,
      'At least one medicine is required',
    ],
  })
  items: PrescriptionItem[];

  @Prop({ type: String, trim: true, maxlength: 2000, default: null })
  generalAdvice?: string | null;

  @Prop({ type: PrescriptionClinicalSnapshotSchema, required: true })
  clinicalSnapshot: PrescriptionClinicalSnapshot;

  @Prop({ default: Date.now })
  createdAt: Date;
}

export const PrescriptionRevisionSchema =
  SchemaFactory.createForClass(PrescriptionRevision);

// Compound Unique Index for strict sequence enforcement
PrescriptionRevisionSchema.index(
  { prescriptionId: 1, revisionNumber: 1 },
  { unique: true, name: 'uniq_prescription_revision_sequence' },
);
PrescriptionRevisionSchema.index({ clinicId: 1, createdAt: -1 });

// Mongoose Pre-Hook Guard Defense: disallow updates or deletes
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
  PrescriptionRevisionSchema.pre(method as any, function () {
    throw new Error(
      'PrescriptionRevision records are append-only and strictly immutable.',
    );
  });
}

PrescriptionRevisionSchema.pre('save', function (this: any) {
  if (!this.isNew) {
    throw new Error(
      'PrescriptionRevision records cannot be mutated once saved.',
    );
  }
});
