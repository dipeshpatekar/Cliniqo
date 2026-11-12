import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose"
import { Document, Types } from "mongoose"

export type CatalogueImportJobDocument = CatalogueImportJob & Document<Types.ObjectId>

@Schema({ timestamps: true, collection: "catalogue_import_jobs" })
export class CatalogueImportJob {
  @Prop({ type: String, required: true, unique: true, index: true })
  jobId: string

  @Prop({ type: Boolean, default: false })
  isDryRun: boolean

  @Prop({ type: String, required: true })
  sourcePath: string

  @Prop({ type: Number, default: 0 })
  totalGenericProcessed: number

  @Prop({ type: Number, default: 0 })
  totalGenericInserted: number

  @Prop({ type: Number, default: 0 })
  totalBrandProcessed: number

  @Prop({ type: Number, default: 0 })
  totalBrandInserted: number

  @Prop({ type: Number, default: 0 })
  totalRejected: number

  @Prop({
    type: [
      {
        file: { type: String, required: true },
        line: { type: Number, required: true },
        identifier: { type: String, required: false },
        reason: { type: String, required: true },
      },
    ],
    default: [],
  })
  rejectedDetails: Array<{
    file: string
    line: number
    identifier?: string
    reason: string
  }>

  @Prop({
    type: String,
    enum: ["PENDING", "IN_PROGRESS", "COMPLETED", "FAILED"],
    default: "PENDING",
    index: true,
  })
  status: string

  @Prop({
    type: String,
    default:
      "National Resource Centre for EHR Standards (NRCeS) at C-DAC Pune under CC BY 4.0; SNOMED CT® International Release terms apply within India.",
  })
  attribution: string

  @Prop({ type: Number, default: 0 })
  durationMs: number

  @Prop({ type: String, default: null })
  error?: string | null

  @Prop({ type: Date, default: Date.now })
  startedAt: Date

  @Prop({ type: Date, default: null })
  completedAt?: Date | null
}

export const CatalogueImportJobSchema =
  SchemaFactory.createForClass(CatalogueImportJob)
