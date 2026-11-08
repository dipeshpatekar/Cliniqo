import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose"
import { Document, Types } from "mongoose"

export enum ClinicStatus {
  ACTIVE = "ACTIVE",
  SUSPENDED = "SUSPENDED",
  ARCHIVED = "ARCHIVED",
}

export type ClinicDocument = Clinic & Document<Types.ObjectId>

@Schema({ timestamps: true, collection: "clinics" })
export class Clinic {
  @Prop({ required: true, trim: true, maxlength: 100 })
  name: string

  // Authoritative unique index declared below SchemaFactory to prevent Mongoose duplicate index warnings
  @Prop({ required: true, lowercase: true, trim: true })
  slug: string

  @Prop({ required: true, trim: true })
  phone: string

  @Prop({ required: true, lowercase: true, trim: true })
  email: string

  @Prop({ type: Object, required: true })
  address: {
    street: string
    city: string
    state: string
    postalCode: string
    country: string
  }

  @Prop({
    type: String,
    required: true,
    enum: Object.values(ClinicStatus),
    default: ClinicStatus.ACTIVE,
  })
  status: ClinicStatus

  @Prop({ type: Types.ObjectId, ref: "Doctor", required: true })
  ownerDoctorId: Types.ObjectId

  @Prop({ type: Types.ObjectId, ref: "Doctor", required: true })
  createdBy: Types.ObjectId

  createdAt?: Date
  updatedAt?: Date
}

export const ClinicSchema = SchemaFactory.createForClass(Clinic)

ClinicSchema.index({ slug: 1 }, { unique: true })
ClinicSchema.index({ ownerDoctorId: 1 })
ClinicSchema.index({ status: 1 })
