import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose"
import {
  Schema as MongooseSchema,
  type HydratedDocument,
  type Types,
} from "mongoose"

export type PasswordResetTokenDocument = HydratedDocument<PasswordResetToken>

@Schema({
  collection: "password_resets",
  timestamps: true,
})
export class PasswordResetToken {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: "Doctor",
    required: true,
  })
  doctorId: Types.ObjectId

  @Prop({
    type: String,
    lowercase: true,
    trim: true,
    required: false,
  })
  email?: string

  @Prop({
    type: String,
    required: false,
  })
  otpHash?: string

  @Prop({
    required: true,
  })
  tokenHash: string

  @Prop({
    type: Number,
    default: 0,
  })
  attempts: number

  @Prop({
    type: Number,
    default: 5,
  })
  maxAttempts: number

  @Prop({
    type: Date,
    default: null,
  })
  resendCooldownUntil?: Date | null

  @Prop({
    type: Date,
    default: null,
  })
  verifiedAt?: Date | null

  @Prop({
    type: Date,
    required: true,
  })
  expiresAt: Date

  @Prop({
    type: Boolean,
    default: false,
  })
  used: boolean

  @Prop({
    type: Date,
    default: null,
  })
  usedAt?: Date | null

  createdAt?: Date
  updatedAt?: Date
}

export const PasswordResetTokenSchema =
  SchemaFactory.createForClass(PasswordResetToken)

// Explicit database indexes
PasswordResetTokenSchema.index({ tokenHash: 1 }, { unique: false })
PasswordResetTokenSchema.index({ doctorId: 1, used: 1 })
PasswordResetTokenSchema.index({ email: 1, used: 1 })
PasswordResetTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })
