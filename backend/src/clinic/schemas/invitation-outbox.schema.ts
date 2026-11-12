import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose"
import { Document, Types } from "mongoose"

export enum OutboxStatus {
  PENDING = "PENDING",
  PROCESSING = "PROCESSING",
  SENT = "SENT",
  FAILED = "FAILED",
  CANCELLED = "CANCELLED",
}

export type InvitationOutboxDocument = InvitationOutbox & Document<Types.ObjectId>

@Schema({ timestamps: true, collection: "invitation_outbox" })
export class InvitationOutbox {
  @Prop({ type: Types.ObjectId, ref: "ClinicInvitation", required: true })
  invitationId: Types.ObjectId

  @Prop({ type: Types.ObjectId, ref: "Clinic", required: true })
  clinicId: Types.ObjectId

  @Prop({ required: true, lowercase: true, trim: true })
  recipientEmail: string

  @Prop({
    type: String,
    required: true,
    enum: Object.values(OutboxStatus),
    default: OutboxStatus.PENDING,
  })
  status: OutboxStatus

  // Encrypted delivery payload (AES-256-GCM, wiped on completion/terminal failure)
  @Prop({ type: String, default: null })
  encryptedPayload?: string | null

  @Prop({ type: String, default: null })
  iv?: string | null

  @Prop({ type: String, default: null })
  authTag?: string | null

  @Prop({ default: 0 })
  attempts: number

  @Prop({ default: 3 })
  maxAttempts: number

  @Prop({ type: Date, default: null })
  processingStartedAt?: Date | null

  @Prop({ type: Date, default: null })
  leaseExpiresAt?: Date | null

  @Prop({ type: String, default: null })
  lockedByWorkerId?: string | null

  @Prop({ default: Date.now })
  nextAttemptAt: Date

  @Prop({ type: Date, default: null })
  sentAt?: Date | null

  @Prop({ type: String, default: null })
  errorSummary?: string | null

  @Prop({ required: true })
  correlationId: string

  createdAt?: Date
  updatedAt?: Date
}

export const InvitationOutboxSchema =
  SchemaFactory.createForClass(InvitationOutbox)

InvitationOutboxSchema.index({ status: 1, nextAttemptAt: 1 })
InvitationOutboxSchema.index({ status: 1, leaseExpiresAt: 1 })
InvitationOutboxSchema.index({ invitationId: 1 })
InvitationOutboxSchema.index({ clinicId: 1, status: 1 })
