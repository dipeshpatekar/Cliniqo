import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type CatalogueGenericDocument = CatalogueGeneric &
  Document<Types.ObjectId>;

@Schema({ timestamps: true, collection: 'catalogue_generics' })
export class CatalogueGeneric {
  @Prop({ type: String, required: true, unique: true, index: true, trim: true })
  identifier: string;

  @Prop({ type: String, required: true, trim: true, index: true })
  genericName: string;

  @Prop({ type: [String], default: [] })
  substanceIdentifiers: string[];

  @Prop({ type: [String], default: [] })
  substances: string[];

  @Prop({ type: [String], default: [] })
  routeIdentifiers: string[];

  @Prop({ type: [String], default: [] })
  routes: string[];

  @Prop({ type: String, default: null })
  doseFormId?: string | null;

  @Prop({ type: String, default: null, index: true })
  doseForm?: string | null;

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
    ingredient?: string;
    rawStrength: string;
    value?: number;
    unit?: string;
  }>;

  @Prop({ type: Boolean, default: false })
  isCombination: boolean;

  @Prop({ type: Boolean, default: true, index: true })
  isStrengthVerified: boolean;

  @Prop({ type: String, default: '' })
  rawStrengthSummary: string;

  @Prop({ type: String, default: 'IMMEDIATE_RELEASE', index: true })
  releaseType: string;

  @Prop({ type: String, default: null })
  indications?: string | null;

  @Prop({ type: String, default: null })
  contraindications?: string | null;

  @Prop({ type: String, default: null })
  therapeuticRole?: string | null;

  @Prop({ type: String, default: 'CDCI_NRCES_INDIA' })
  sourceProvenance: string;

  @Prop({ type: String, default: null })
  lastUpdatedOn?: string | null;
}

export const CatalogueGenericSchema =
  SchemaFactory.createForClass(CatalogueGeneric);

// Compound & text search indexes
CatalogueGenericSchema.index({ genericName: 'text', substances: 'text' });
CatalogueGenericSchema.index({ doseForm: 1, genericName: 1 });
