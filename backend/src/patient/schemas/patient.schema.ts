import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose"
import { Document, Types } from "mongoose"

export enum PatientGender {
  MALE = "MALE",
  FEMALE = "FEMALE",
  OTHER = "OTHER",
}

export enum PatientStatus {
  ACTIVE = "ACTIVE",
  ARCHIVED = "ARCHIVED",
}

export type PatientDocument = Patient & Document<Types.ObjectId>

@Schema({
  timestamps: true,
  collection: "patients",
})
export class Patient {
  @Prop({ type: Types.ObjectId, ref: "Clinic", required: true, index: true })
  clinicId: Types.ObjectId

  @Prop({ type: String, required: true, trim: true })
  patientId: string

  @Prop({ type: String, required: true, trim: true })
  name: string

  @Prop({ type: String, required: true, trim: true, uppercase: true })
  initials: string

  @Prop({ type: Number, required: true, min: 0, max: 150 })
  age: number

  @Prop({
    type: String,
    required: true,
    enum: Object.values(PatientGender),
  })
  gender: PatientGender

  @Prop({ type: String, required: true, trim: true })
  phone: string

  @Prop({ type: String, required: true, trim: true })
  normalizedPhone: string

  @Prop({ type: Date, default: null })
  dateOfBirth?: Date | null

  @Prop({ type: String, default: null, trim: true })
  alternatePhone?: string | null

  @Prop({ type: String, default: null, trim: true })
  address?: string | null

  @Prop({ type: [String], default: [] })
  allergies: string[]

  @Prop({ type: [String], default: [] })
  conditions: string[]

  @Prop({
    type: String,
    required: true,
    enum: Object.values(PatientStatus),
    default: PatientStatus.ACTIVE,
  })
  status: PatientStatus

  @Prop({ type: Types.ObjectId, ref: "Doctor", required: true })
  createdBy: Types.ObjectId

  @Prop({ type: Types.ObjectId, ref: "Doctor", required: true })
  updatedBy: Types.ObjectId

  @Prop({ type: Date, default: null })
  lastVisitAt?: Date | null

  @Prop({ type: Number, default: 1 })
  version: number

  createdAt?: Date
  updatedAt?: Date
}

export const PatientSchema = SchemaFactory.createForClass(Patient)

// Enforce compound uniqueness per clinic
PatientSchema.index({ clinicId: 1, patientId: 1 }, { unique: true })
// Search & filter indexes
PatientSchema.index({ clinicId: 1, normalizedPhone: 1, status: 1 })
PatientSchema.index({ clinicId: 1, status: 1, name: 1 })
PatientSchema.index({ clinicId: 1, status: 1, createdAt: -1 })
