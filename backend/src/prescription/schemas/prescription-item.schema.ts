import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types } from 'mongoose';

export enum MedicineFormulation {
  TABLET = 'TABLET',
  CAPSULE = 'CAPSULE',
  SYRUP = 'SYRUP',
  SUSPENSION = 'SUSPENSION',
  INJECTION = 'INJECTION',
  INHALER = 'INHALER',
  DROPS = 'DROPS',
  CREAM = 'CREAM',
  OINTMENT = 'OINTMENT',
  GEL = 'GEL',
  LOTION = 'LOTION',
  PATCH = 'PATCH',
  POWDER = 'POWDER',
  SPRAY = 'SPRAY',
  SUPPOSITORY = 'SUPPOSITORY',
  OTHER = 'OTHER',
}

export enum DoseUnit {
  TABLET = 'TABLET',
  CAPSULE = 'CAPSULE',
  ML = 'ML',
  MG = 'MG',
  MCG = 'MCG',
  G = 'G',
  PUFF = 'PUFF',
  ACTUATION = 'ACTUATION',
  DROP = 'DROP',
  APPLICATION = 'APPLICATION',
  PATCH = 'PATCH',
  SACHET = 'SACHET',
  VIAL = 'VIAL',
  AMPOULE = 'AMPOULE',
  TEASPOON = 'TEASPOON',
  TABLESPOON = 'TABLESPOON',
  SUPPOSITORY = 'SUPPOSITORY',
  INTERNATIONAL_UNIT = 'IU',
}

export enum MedicineRoute {
  ORAL = 'ORAL',
  TOPICAL = 'TOPICAL',
  INHALATION = 'INHALATION',
  INTRAMUSCULAR = 'INTRAMUSCULAR',
  INTRAVENOUS = 'INTRAVENOUS',
  SUBCUTANEOUS = 'SUBCUTANEOUS',
  OPHTHALMIC = 'OPHTHALMIC',
  OTIC = 'OTIC',
  NASAL = 'NASAL',
  RECTAL = 'RECTAL',
  SUBLINGUAL = 'SUBLINGUAL',
  TRANSDERMAL = 'TRANSDERMAL',
}

export enum TimingType {
  STANDARD = 'STANDARD',
  INTERVAL = 'INTERVAL',
  PRN_AS_NEEDED = 'PRN_AS_NEEDED',
  STAT = 'STAT',
}

export enum FrequencyCode {
  OD = 'OD',           // Once daily (1-0-0)
  BD = 'BD',           // Twice daily (1-0-1)
  TID = 'TID',         // Thrice daily (1-1-1)
  QID = 'QID',         // Four times daily (1-1-1-1)
  Q4H = 'Q4H',         // Every 4 hours
  Q6H = 'Q6H',         // Every 6 hours
  Q8H = 'Q8H',         // Every 8 hours
  Q12H = 'Q12H',       // Every 12 hours
  BEDTIME = 'BEDTIME', // At bedtime (0-0-1)
  WEEKLY = 'WEEKLY',   // Once weekly
}

export enum FoodInstruction {
  BEFORE_MEALS = 'BEFORE_MEALS',
  AFTER_MEALS = 'AFTER_MEALS',
  WITH_MEALS = 'WITH_MEALS',
  EMPTY_STOMACH = 'EMPTY_STOMACH',
  IRRELEVANT = 'IRRELEVANT',
  AS_DIRECTED = 'AS_DIRECTED',
}

@Schema({ _id: false })
export class IngredientComponent {
  @Prop({ type: String, required: true, trim: true, maxlength: 200 })
  ingredientName: string;

  @Prop({
    type: Number,
    default: null,
    validate: {
      validator: (val: any) => {
        if (val === null || val === undefined) return true;
        return typeof val === 'number' && Number.isFinite(val) && val > 0;
      },
      message: 'Ingredient amount must be a finite positive number (> 0) when provided.',
    },
  })
  amount?: number | null;

  @Prop({ type: String, required: true, trim: true, maxlength: 50 })
  unit: string;
}

export const IngredientComponentSchema =
  SchemaFactory.createForClass(IngredientComponent);

@Schema({ _id: false })
export class ProductStrength {
  @Prop({
    type: [IngredientComponentSchema],
    required: true,
    validate: [
      (val: any[]) => Array.isArray(val) && val.length > 0,
      'At least one ingredient component is required',
    ],
  })
  components: IngredientComponent[];

  @Prop({ type: String, trim: true, default: null, maxlength: 50 })
  perDenominator?: string | null;

  @Prop({ type: String, required: true, trim: true, maxlength: 300 })
  display: string;
}

export const ProductStrengthSchema =
  SchemaFactory.createForClass(ProductStrength);

@Schema({ _id: false })
export class AdministeredDose {
  @Prop({
    type: Number,
    required: true,
    validate: {
      validator: (val: any) => typeof val === 'number' && Number.isFinite(val) && val > 0,
      message: 'Administered dose magnitude must be a finite positive number (> 0).',
    },
  })
  magnitude: number;

  @Prop({ type: String, required: true, enum: Object.values(DoseUnit) })
  unit: DoseUnit;
}

export const AdministeredDoseSchema =
  SchemaFactory.createForClass(AdministeredDose);

@Schema({ _id: false })
export class DosageFrequency {
  @Prop({ type: String, required: true, enum: Object.values(TimingType) })
  timingType: TimingType;

  @Prop({ type: String, enum: Object.values(FrequencyCode), default: null })
  frequencyCode?: FrequencyCode | null;

  @Prop({ type: Number, min: 1, max: 168, default: null })
  intervalHours?: number | null;

  @Prop({ type: String, trim: true, maxlength: 200, default: null })
  prnIndication?: string | null;

  @Prop({ type: String, trim: true, maxlength: 200, default: null })
  scheduleLabel?: string | null;
}

export const DosageFrequencySchema =
  SchemaFactory.createForClass(DosageFrequency);

@Schema({ _id: false })
export class PrescriptionDuration {
  @Prop({ type: Number, required: true, min: 1, max: 365 })
  value: number;

  @Prop({
    type: String,
    required: true,
    enum: ['DAYS', 'WEEKS', 'MONTHS', 'STAT'],
  })
  unit: 'DAYS' | 'WEEKS' | 'MONTHS' | 'STAT';
}

export const PrescriptionDurationSchema =
  SchemaFactory.createForClass(PrescriptionDuration);

@Schema({ _id: false })
export class DispenseQuantity {
  @Prop({
    type: Number,
    required: true,
    validate: {
      validator: (val: any) => typeof val === 'number' && Number.isFinite(val) && val > 0,
      message: 'Dispense quantity count must be a finite positive number (> 0).',
    },
  })
  count: number;

  @Prop({ type: String, required: true, trim: true, maxlength: 100 })
  packageDescription: string;
}

export const DispenseQuantitySchema =
  SchemaFactory.createForClass(DispenseQuantity);

@Schema({ _id: false })
export class PrescriptionItem {
  @Prop({ type: Types.ObjectId, default: null })
  catalogueMedicineId?: Types.ObjectId | null;

  @Prop({ type: Boolean, required: true, default: false })
  isCustom: boolean;

  @Prop({ type: String, required: true, trim: true, maxlength: 200 })
  name: string;

  @Prop({ type: String, trim: true, maxlength: 200, default: null })
  genericName?: string | null;

  @Prop({
    type: String,
    required: true,
    enum: Object.values(MedicineFormulation),
  })
  formulation: MedicineFormulation;

  @Prop({ type: ProductStrengthSchema, required: true })
  strength: ProductStrength;

  @Prop({ type: AdministeredDoseSchema, required: true })
  administeredDose: AdministeredDose;

  @Prop({ type: String, required: true, enum: Object.values(MedicineRoute) })
  route: MedicineRoute;

  @Prop({ type: DosageFrequencySchema, required: true })
  frequency: DosageFrequency;

  @Prop({ type: PrescriptionDurationSchema, required: true })
  duration: PrescriptionDuration;

  @Prop({ type: DispenseQuantitySchema, required: true })
  dispenseQuantity: DispenseQuantity;

  @Prop({
    type: String,
    required: true,
    enum: Object.values(FoodInstruction),
    default: FoodInstruction.AFTER_MEALS,
  })
  foodInstruction: FoodInstruction;

  @Prop({ type: String, trim: true, maxlength: 500, default: null })
  instructions?: string | null;
}

export const PrescriptionItemSchema =
  SchemaFactory.createForClass(PrescriptionItem);
