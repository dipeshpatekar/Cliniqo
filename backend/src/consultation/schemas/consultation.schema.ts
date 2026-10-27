import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export enum ConsultationStatus {
  DRAFT = 'DRAFT',
  FINALIZED = 'FINALIZED',
  CANCELLED = 'CANCELLED',
}

export type ConsultationDocument = Consultation & Document<Types.ObjectId>;

@Schema({ _id: false })
export class Vitals {
  @Prop({ type: Number, min: 40, max: 300, default: null })
  systolic?: number | null; // mmHg

  @Prop({ type: Number, min: 20, max: 200, default: null })
  diastolic?: number | null; // mmHg

  @Prop({ type: Number, min: 30, max: 250, default: null })
  heartRate?: number | null; // bpm

  @Prop({ type: Number, min: 50, max: 100, default: null })
  spo2?: number | null; // %

  @Prop({ type: Number, min: 85.0, max: 110.0, default: null })
  temperature?: number | null; // °F

  @Prop({ type: Number, min: 20.0, max: 280.0, default: null })
  height?: number | null; // cm

  @Prop({ type: Number, min: 0.5, max: 500.0, default: null })
  weight?: number | null; // kg
}

export const VitalsSchema = SchemaFactory.createForClass(Vitals);

@Schema({ _id: false })
export class FollowUp {
  @Prop({ type: Date, default: null })
  date?: Date | null;

  @Prop({ type: String, trim: true, maxlength: 500, default: null })
  instructions?: string | null;
}

export const FollowUpSchema = SchemaFactory.createForClass(FollowUp);

@Schema({ _id: false })
export class ProvisionalMedicine {
  @Prop({ type: String, required: true, trim: true })
  name: string;

  @Prop({ type: String, required: true, trim: true })
  formulation: string;

  @Prop({ type: String, trim: true, default: '' })
  strength: string;

  @Prop({ type: String, trim: true, default: '' })
  dose: string;

  @Prop({ type: String, trim: true, default: '' })
  frequency: string;

  @Prop({ type: String, trim: true, default: '' })
  duration: string;

  @Prop({ type: String, trim: true, default: '' })
  route?: string;

  @Prop({ type: String, trim: true, default: '' })
  foodInstruction?: string;

  @Prop({ type: String, trim: true, default: '' })
  directions?: string;
}

export const ProvisionalMedicineSchema =
  SchemaFactory.createForClass(ProvisionalMedicine);

@Schema({
  timestamps: true,
  collection: 'consultations',
})
export class Consultation {
  @Prop({ type: Types.ObjectId, ref: 'Clinic', required: true, index: true })
  clinicId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Patient', required: true, index: true })
  patientId: Types.ObjectId;

  @Prop({ type: String, required: true, trim: true })
  patientCode: string; // e.g. "P-00101"

  @Prop({ type: Types.ObjectId, ref: 'Doctor', required: true, index: true })
  doctorId: Types.ObjectId;

  @Prop({
    type: String,
    required: true,
    enum: Object.values(ConsultationStatus),
    default: ConsultationStatus.DRAFT,
    index: true,
  })
  status: ConsultationStatus;

  @Prop({ type: Date, required: true, default: Date.now })
  consultationDate: Date;

  @Prop({ type: String, trim: true, default: null })
  consultationTime?: string | null; // "HH:mm"

  @Prop({ type: VitalsSchema, default: () => ({}) })
  vitals: Vitals;

  @Prop({ type: String, trim: true, maxlength: 1000, default: '' })
  chiefComplaint: string;

  @Prop({ type: String, trim: true, maxlength: 200, default: null })
  symptomDuration?: string | null;

  @Prop({ type: String, trim: true, maxlength: 1000, default: '' })
  diagnosis: string;

  @Prop({ type: String, trim: true, maxlength: 5000, default: null })
  clinicalNotes?: string | null;

  @Prop({ type: FollowUpSchema, default: () => ({}) })
  followUp: FollowUp;

  @Prop({ type: [ProvisionalMedicineSchema], default: [] })
  provisionalMedicines: ProvisionalMedicine[];

  @Prop({ type: Number, default: 0 })
  addendumCount: number;

  @Prop({ type: Boolean, default: false })
  hasAddenda: boolean;

  // Non-premature bridge to later Phase 3 Prescription domain
  @Prop({ type: Types.ObjectId, ref: 'Prescription', default: null })
  prescriptionId?: Types.ObjectId | null;

  @Prop({ type: Boolean, default: false })
  hasPrescription: boolean;

  @Prop({ type: Date, default: null })
  finalizedAt?: Date | null;

  @Prop({ type: Types.ObjectId, ref: 'Doctor', default: null })
  finalizedBy?: Types.ObjectId | null;

  @Prop({ type: String, trim: true, default: null })
  cancellationReason?: string | null;

  @Prop({ type: Date, default: null })
  cancelledAt?: Date | null;

  @Prop({ type: Types.ObjectId, ref: 'Doctor', default: null })
  cancelledBy?: Types.ObjectId | null;

  @Prop({ type: Number, default: 1 })
  version: number;

  @Prop({ type: Types.ObjectId, ref: 'Doctor', required: true })
  createdBy: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Doctor', required: true })
  updatedBy: Types.ObjectId;

  createdAt?: Date;
  updatedAt?: Date;
}

export const ConsultationSchema = SchemaFactory.createForClass(Consultation);

// Partial unique index: at most one active DRAFT per patient in a clinic
ConsultationSchema.index(
  { clinicId: 1, patientId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: ConsultationStatus.DRAFT },
    name: 'uniq_active_consultation_draft_per_patient',
  },
);

// Compound queries and feed indexes
ConsultationSchema.index({ clinicId: 1, patientId: 1, consultationDate: -1 });
ConsultationSchema.index({ clinicId: 1, status: 1, consultationDate: -1 });
ConsultationSchema.index({ clinicId: 1, doctorId: 1, consultationDate: -1 });
ConsultationSchema.index({ clinicId: 1, patientCode: 1 });
