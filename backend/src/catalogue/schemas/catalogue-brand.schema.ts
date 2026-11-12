import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose"
import { Document, Types } from "mongoose"

export type CatalogueBrandDocument = CatalogueBrand & Document<Types.ObjectId>

@Schema({ timestamps: true, collection: "catalogue_brands" })
export class CatalogueBrand {
  @Prop({ type: String, required: true, unique: true, index: true, trim: true })
  identifier: string

  @Prop({ type: String, required: true, trim: true, index: true })
  brandName: string

  @Prop({ type: String, default: null, index: true })
  productIdentifier?: string | null

  @Prop({ type: String, default: null, index: true })
  productName?: string | null

  @Prop({ type: String, default: null })
  supplierIdentifier?: string | null

  @Prop({ type: String, default: null })
  supplierName?: string | null

  @Prop({ type: String, default: null, index: true })
  genericIdentifier?: string | null

  @Prop({ type: String, default: null, index: true })
  genericName?: string | null

  @Prop({ type: String, default: null, index: true })
  dosageForm?: string | null

  @Prop({ type: String, default: null })
  route?: string | null

  @Prop({
    type: [
      {
        ingredient: { type: String, required: false },
        rawStrength: { type: String, required: true },
        value: { type: Number, required: false },
        unit: { type: String, required: false },
      },
    ],
    default: [],
  })
  strengths: Array<{
    ingredient?: string
    rawStrength: string
    value?: number
    unit?: string
  }>

  @Prop({ type: Boolean, default: false })
  isCombination: boolean

  @Prop({ type: Boolean, default: true, index: true })
  isStrengthVerified: boolean

  @Prop({ type: String, default: "" })
  rawStrengthSummary: string

  @Prop({ type: String, default: "IMMEDIATE_RELEASE", index: true })
  releaseType: string

  @Prop({ type: String, default: "UNKNOWN" })
  licenseStatus: string

  @Prop({ type: String, default: null })
  excipient?: string | null

  @Prop({ type: String, default: "CDCI_NRCES_INDIA" })
  sourceProvenance: string

  @Prop({ type: String, default: null })
  lastUpdatedOn?: string | null
}

export const CatalogueBrandSchema = SchemaFactory.createForClass(CatalogueBrand)

// Search indexes
CatalogueBrandSchema.index({
  brandName: "text",
  productName: "text",
  genericName: "text",
})
CatalogueBrandSchema.index({ productName: 1, dosageForm: 1 })
