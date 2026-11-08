import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose"
import { Document, Types } from "mongoose"

export enum InvoiceStatus {
  DRAFT = "DRAFT",
  FINALIZED = "FINALIZED",
  CANCELLED = "CANCELLED",
}

export enum PaymentStatus {
  UNPAID = "UNPAID",
  PAID = "PAID",
}

export type InvoiceDocument = Invoice & Document<Types.ObjectId>

@Schema({ _id: false })
export class InvoiceItem {
  @Prop({ type: String, required: true, trim: true, maxlength: 300 })
  description: string

  @Prop({ type: Number, required: true, min: 1, validate: Number.isInteger })
  quantity: number

  @Prop({ type: Number, required: true, min: 0, validate: Number.isInteger })
  unitPricePaise: number

  @Prop({ type: Number, required: true, min: 0, validate: Number.isInteger })
  totalPaise: number
}

export const InvoiceItemSchema = SchemaFactory.createForClass(InvoiceItem)

@Schema({ timestamps: true, collection: "invoices" })
export class Invoice {
  @Prop({ type: Types.ObjectId, ref: "Clinic", required: true, index: true })
  clinicId: Types.ObjectId

  @Prop({ type: Types.ObjectId, ref: "Patient", required: true, index: true })
  patientId: Types.ObjectId

  @Prop({
    type: Types.ObjectId,
    ref: "Consultation",
    default: null,
    index: true,
  })
  consultationId?: Types.ObjectId | null

  @Prop({ type: String, required: true, trim: true })
  invoiceNumber: string

  @Prop({ type: Date, required: true, default: Date.now })
  invoiceDate: Date

  @Prop({
    type: String,
    required: true,
    enum: Object.values(InvoiceStatus),
    default: InvoiceStatus.DRAFT,
    index: true,
  })
  status: InvoiceStatus

  @Prop({
    type: String,
    required: true,
    enum: Object.values(PaymentStatus),
    default: PaymentStatus.UNPAID,
    index: true,
  })
  paymentStatus: PaymentStatus

  @Prop({
    type: [InvoiceItemSchema],
    required: true,
    validate: [
      (val: any[]) => val.length > 0,
      "At least one invoice item is required",
    ],
  })
  items: InvoiceItem[]

  @Prop({ type: Number, required: true, min: 0, validate: Number.isInteger })
  subtotalPaise: number

  @Prop({
    type: Number,
    required: true,
    min: 0,
    default: 0,
    validate: Number.isInteger,
  })
  discountPaise: number

  @Prop({ type: Number, required: true, min: 0, max: 100, default: 0 })
  taxRatePercent: number

  @Prop({
    type: Number,
    required: true,
    min: 0,
    default: 0,
    validate: Number.isInteger,
  })
  taxPaise: number

  @Prop({ type: Number, required: true, min: 0, validate: Number.isInteger })
  totalPaise: number

  @Prop({ type: String, trim: true, default: null, maxlength: 500 })
  notes?: string | null

  @Prop({ type: Types.ObjectId, ref: "Doctor", required: true })
  createdBy: Types.ObjectId

  @Prop({ type: Date, default: null })
  finalizedAt?: Date | null

  @Prop({ type: Types.ObjectId, ref: "Doctor", default: null })
  finalizedBy?: Types.ObjectId | null

  @Prop({ type: Date, default: null })
  cancelledAt?: Date | null

  @Prop({ type: Types.ObjectId, ref: "Doctor", default: null })
  cancelledBy?: Types.ObjectId | null

  @Prop({ type: String, trim: true, default: null, maxlength: 500 })
  cancellationReason?: string | null

  @Prop({ type: Number, default: 1 })
  version: number

  createdAt?: Date
  updatedAt?: Date
}

export const InvoiceSchema = SchemaFactory.createForClass(Invoice)

// Unique invoice number per clinic
InvoiceSchema.index({ clinicId: 1, invoiceNumber: 1 }, { unique: true })
InvoiceSchema.index({ clinicId: 1, patientId: 1 })
InvoiceSchema.index({ clinicId: 1, status: 1 })
