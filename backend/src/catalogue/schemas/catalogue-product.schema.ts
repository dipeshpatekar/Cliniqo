import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose"
import { Document, Types } from "mongoose"

export type CatalogueProductDocument = CatalogueProduct & Document<Types.ObjectId>

@Schema({ timestamps: true, collection: "catalogue_products" })
export class CatalogueProduct {
  @Prop({ type: String, required: true, unique: true, index: true, trim: true })
  identifier: string

  @Prop({ type: String, required: true, trim: true, index: true })
  productName: string

  @Prop({ type: String, default: "CDCI_NRCES_INDIA" })
  sourceProvenance: string
}

export const CatalogueProductSchema =
  SchemaFactory.createForClass(CatalogueProduct)

CatalogueProductSchema.index({ productName: "text" })
