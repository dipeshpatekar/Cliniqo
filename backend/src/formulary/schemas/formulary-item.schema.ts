import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose"
import { Document, Types } from "mongoose"
import {
  MedicineFormulation,
  MedicineRoute,
  FoodInstruction,
} from "../../prescription/schemas/prescription-item.schema.js"

export type FormularyItemDocument = FormularyItem & Document<Types.ObjectId>

@Schema({ timestamps: true, collection: "formulary_items" })
export class FormularyItem {
  @Prop({ type: Types.ObjectId, ref: "Clinic", required: true, index: true })
  clinicId: Types.ObjectId

  @Prop({ type: String, required: true, trim: true, maxlength: 200 })
  name: string

  @Prop({ type: String, trim: true, default: null, maxlength: 200 })
  activeIngredient?: string | null

  @Prop({
    type: String,
    required: true,
    enum: Object.values(MedicineFormulation),
    index: true,
  })
  formulation: MedicineFormulation

  @Prop({ type: String, required: true, trim: true, maxlength: 100 })
  strength: string

  @Prop({ type: String, trim: true, default: null, maxlength: 100 })
  defaultDose?: string | null

  @Prop({
    type: String,
    enum: Object.values(MedicineRoute),
    default: null,
  })
  defaultRoute?: MedicineRoute | null

  @Prop({ type: String, trim: true, default: null, maxlength: 100 })
  defaultFrequency?: string | null

  @Prop({ type: String, trim: true, default: null, maxlength: 100 })
  defaultDuration?: string | null

  @Prop({
    type: String,
    enum: Object.values(FoodInstruction),
    default: FoodInstruction.IRRELEVANT,
  })
  defaultFoodInstruction?: FoodInstruction

  @Prop({ type: String, trim: true, default: null, maxlength: 500 })
  defaultDirections?: string | null

  @Prop({ type: Boolean, default: true, index: true })
  isActive: boolean

  @Prop({ type: Types.ObjectId, ref: "Doctor", required: true })
  createdBy: Types.ObjectId

  @Prop({ type: Number, default: 1 })
  version: number

  createdAt?: Date
  updatedAt?: Date
}

export const FormularyItemSchema = SchemaFactory.createForClass(FormularyItem)

// Index for tenant isolation and search
FormularyItemSchema.index({ clinicId: 1, name: 1, formulation: 1 })
FormularyItemSchema.index({ clinicId: 1, activeIngredient: 1 })
