import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose"
import { Document, Types } from "mongoose"

export enum ClinicRole {
  OWNER = "OWNER",
  DOCTOR = "DOCTOR",
  STAFF = "STAFF",
}

export enum ClinicMembershipStatus {
  ACTIVE = "ACTIVE",
  REVOKED = "REVOKED",
  SUSPENDED = "SUSPENDED",
}

export type ClinicMembershipDocument = ClinicMembership & Document<Types.ObjectId>

@Schema({ timestamps: true, collection: "clinic_memberships" })
export class ClinicMembership {
  @Prop({ type: Types.ObjectId, ref: "Clinic", required: true })
  clinicId: Types.ObjectId

  @Prop({ type: Types.ObjectId, ref: "Doctor", required: true })
  doctorId: Types.ObjectId

  @Prop({ type: String, required: true, enum: Object.values(ClinicRole) })
  role: ClinicRole

  @Prop({
    type: String,
    required: true,
    enum: Object.values(ClinicMembershipStatus),
    default: ClinicMembershipStatus.ACTIVE,
  })
  status: ClinicMembershipStatus

  @Prop({ type: Types.ObjectId, ref: "Doctor" })
  invitedBy?: Types.ObjectId

  @Prop({ default: Date.now })
  joinedAt: Date

  @Prop({ type: Date, default: null })
  revokedAt?: Date | null

  @Prop({ type: Types.ObjectId, ref: "Doctor", default: null })
  revokedBy?: Types.ObjectId | null

  createdAt?: Date
  updatedAt?: Date
}

export const ClinicMembershipSchema =
  SchemaFactory.createForClass(ClinicMembership)

ClinicMembershipSchema.index({ clinicId: 1, doctorId: 1 }, { unique: true })
ClinicMembershipSchema.index({ doctorId: 1, status: 1 })
ClinicMembershipSchema.index({ clinicId: 1, role: 1, status: 1 })
