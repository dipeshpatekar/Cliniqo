import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose"
import { Document, Types } from "mongoose"

export type IdempotencyRecordDocument = IdempotencyRecord & Document<Types.ObjectId>

@Schema({
  timestamps: true,
  collection: "idempotency_records",
})
export class IdempotencyRecord {
  @Prop({ type: Types.ObjectId, ref: "Clinic", required: true, index: true })
  clinicId: Types.ObjectId

  @Prop({ type: String, required: true, trim: true })
  key: string

  @Prop({ type: String, required: true, trim: true })
  httpMethod: string

  @Prop({ type: String, required: true, trim: true })
  normalizedRoute: string

  @Prop({ type: String, required: true })
  requestFingerprint: string

  @Prop({
    type: String,
    required: true,
    enum: ["PROCESSING", "COMPLETED", "FAILED"],
    default: "PROCESSING",
    index: true,
  })
  status: "PROCESSING" | "COMPLETED" | "FAILED"

  @Prop({ type: String, required: true })
  claimToken: string

  @Prop({ type: Date, default: null })
  lockedUntil?: Date | null

  @Prop({ type: Number, default: 0 })
  recoveryAttempts: number

  @Prop({ type: Number, default: null })
  responseCode?: number | null

  @Prop({ type: Object, default: null })
  responseBody?: Record<string, any> | null

  @Prop({ type: String, default: null })
  lastError?: string | null

  @Prop({ type: Date, required: true, index: { expireAfterSeconds: 0 } })
  expiresAt: Date

  createdAt?: Date
  updatedAt?: Date
}

export const IdempotencyRecordSchema =
  SchemaFactory.createForClass(IdempotencyRecord)

// Compound Unique Index: Strictly tenant-isolated per clinic
IdempotencyRecordSchema.index({ clinicId: 1, key: 1 }, {
  unique: true,
  name: "uniq_clinic_idempotency_key",
})
