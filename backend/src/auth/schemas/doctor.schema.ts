import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose"
import type { HydratedDocument } from "mongoose"
import { DoctorStatus } from "../auth.constants.js"

export type DoctorDocument = HydratedDocument<Doctor>

@Schema({
  collection: "doctors",
  timestamps: true,
  toJSON: {
    transform: (_doc, ret: Record<string, any>) => {
      delete ret.passwordHash
      delete ret.__v
      return ret
    },
  },
  toObject: {
    transform: (_doc, ret: Record<string, any>) => {
      delete ret.passwordHash
      delete ret.__v
      return ret
    },
  },
})
export class Doctor {
  @Prop({
    required: true,
    trim: true,
    lowercase: true,
    maxlength: 254,
  })
  email: string

  @Prop({
    required: true,
    select: false, // Never select passwordHash by default in normal queries
  })
  passwordHash: string

  @Prop({
    required: true,
    trim: true,
    maxlength: 120,
  })
  fullName: string

  @Prop({
    trim: true,
    default: null,
  })
  phone?: string

  @Prop({
    trim: true,
    default: null,
  })
  licenseNumber?: string

  @Prop({
    trim: true,
    default: null,
  })
  qualification?: string

  @Prop({
    trim: true,
    default: null,
  })
  registrationNumber?: string

  @Prop({
    trim: true,
    default: null,
  })
  gender?: string

  @Prop({
    type: String,
    enum: Object.values(DoctorStatus),
    default: DoctorStatus.PENDING_VERIFICATION,
  })
  status: DoctorStatus

  @Prop({
    type: Number,
    default: 0,
    min: 0,
  })
  failedLoginAttempts: number

  @Prop({
    type: Date,
    default: null,
  })
  lockUntil?: Date | null

  @Prop({
    type: Date,
    default: null,
  })
  lastLoginAt?: Date | null

  @Prop({
    type: Date,
    default: null,
  })
  passwordChangedAt?: Date | null

  createdAt?: Date
  updatedAt?: Date
}

export const DoctorSchema = SchemaFactory.createForClass(Doctor)

// Explicit database indexes
DoctorSchema.index({ email: 1 }, { unique: true })
DoctorSchema.index({ status: 1 })
