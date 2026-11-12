import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose"
import { Document, Types } from "mongoose"

export enum PrescriptionStatus {
  ACTIVE = "ACTIVE",
  DISCONTINUED = "DISCONTINUED",
  CANCELLED = "CANCELLED",
}

export type PrescriptionDocument = Prescription & Document<Types.ObjectId>

@Schema({ timestamps: true, collection: "prescriptions" })
export class Prescription {
  @Prop({ type: Types.ObjectId, ref: "Clinic", required: true, index: true })
  clinicId: Types.ObjectId

  @Prop({ type: Types.ObjectId, ref: "Patient", required: true, index: true })
  patientId: Types.ObjectId

  @Prop({ type: String, required: true, trim: true })
  patientCode: string

  @Prop({
    type: Types.ObjectId,
    ref: "Consultation",
    required: true,
    index: true,
  })
  consultationId: Types.ObjectId

  @Prop({ type: String, required: true, trim: true })
  prescriptionNumber: string

  @Prop({
    type: String,
    required: true,
    enum: Object.values(PrescriptionStatus),
    default: PrescriptionStatus.ACTIVE,
    index: true,
  })
  status: PrescriptionStatus

  @Prop({ type: Number, required: true, default: 1 })
  currentRevisionNumber: number

  @Prop({ type: Types.ObjectId, ref: "PrescriptionRevision", default: null })
  latestRevisionId?: Types.ObjectId | null

  @Prop({ type: Types.ObjectId, ref: "Doctor", required: true })
  prescribedBy: Types.ObjectId

  @Prop({ type: Types.ObjectId, ref: "Prescription", default: null })
  replacesPrescriptionId?: Types.ObjectId | null

  @Prop({ type: Types.ObjectId, ref: "Prescription", default: null })
  replacedByPrescriptionId?: Types.ObjectId | null

  @Prop({ type: String, default: null, trim: true })
  discontinuationReason?: string | null

  @Prop({ type: Date, default: null })
  discontinuedAt?: Date | null

  @Prop({ type: Types.ObjectId, ref: "Doctor", default: null })
  discontinuedBy?: Types.ObjectId | null

  @Prop({ type: String, default: null, trim: true })
  cancellationReason?: string | null

  @Prop({ type: Date, default: null })
  cancelledAt?: Date | null

  @Prop({ type: Types.ObjectId, ref: "Doctor", default: null })
  cancelledBy?: Types.ObjectId | null

  @Prop({ type: Number, default: 0 })
  printCount: number

  @Prop({ type: Date, default: null })
  lastPrintedAt?: Date | null

  @Prop({ type: Types.ObjectId, ref: "Doctor", default: null })
  lastPrintedBy?: Types.ObjectId | null

  @Prop({ type: Number, default: 1 })
  version: number

  createdAt?: Date
  updatedAt?: Date
}

export const PrescriptionSchema = SchemaFactory.createForClass(Prescription)

// Database Indexes
// At most one ACTIVE prescription per consultation
PrescriptionSchema.index({ clinicId: 1, consultationId: 1 }, {
  unique: true,
  partialFilterExpression: { status: PrescriptionStatus.ACTIVE },
  name: "uniq_active_prescription_per_consultation",
})

// Sequential number uniqueness within clinic
PrescriptionSchema.index({ clinicId: 1, prescriptionNumber: 1 }, {
  unique: true,
  name: "uniq_clinic_prescription_number",
})

PrescriptionSchema.index({ clinicId: 1, patientId: 1, createdAt: -1 })
PrescriptionSchema.index({ clinicId: 1, status: 1, createdAt: -1 })
