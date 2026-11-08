import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  IsPositive,
  IsEnum,
  IsBoolean,
  IsInt,
  Min,
  Max,
  MaxLength,
  ValidateNested,
  ArrayMinSize,
} from "class-validator"
import { Type } from "class-transformer"
import {
  MedicineFormulation,
  DoseUnit,
  MedicineRoute,
  TimingType,
  FrequencyCode,
  FoodInstruction,
} from "../schemas/prescription-item.schema.js"

export class IngredientComponentDto {
  @IsString()
  @IsNotEmpty({ message: "Ingredient name is required" })
  @MaxLength(200)
  ingredientName: string

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false }, {
    message: "Ingredient amount must be a finite number",
  })
  @IsPositive({ message: "Ingredient amount must be strictly greater than 0" })
  amount?: number | null

  @IsString()
  @IsNotEmpty({ message: "Ingredient unit is required" })
  @MaxLength(50)
  unit: string
}

export class ProductStrengthDto {
  @ValidateNested({ each: true })
  @Type(() => IngredientComponentDto)
  @ArrayMinSize(1, {
    message: "At least one ingredient component is required",
  })
  components: IngredientComponentDto[]

  @IsOptional()
  @IsString()
  @MaxLength(50)
  perDenominator?: string | null

  @IsString()
  @IsNotEmpty({ message: "Strength display string is required" })
  @MaxLength(300)
  display: string
}

export class AdministeredDoseDto {
  @IsNumber({ allowNaN: false, allowInfinity: false }, {
    message: "Administered dose magnitude must be a finite number",
  })
  @IsPositive({
    message: "Administered dose magnitude must be strictly greater than 0",
  })
  magnitude: number

  @IsEnum(DoseUnit, {
    message: `Dose unit must be a valid DoseUnit enum value`,
  })
  unit: DoseUnit
}

export class DosageFrequencyDto {
  @IsEnum(TimingType, {
    message: `Timing type must be STANDARD, INTERVAL, PRN_AS_NEEDED, or STAT`,
  })
  timingType: TimingType

  @IsOptional()
  @IsEnum(FrequencyCode, {
    message: `Frequency code must be a valid FrequencyCode enum value`,
  })
  frequencyCode?: FrequencyCode | null

  @IsOptional()
  @IsInt({ message: "Interval hours must be an integer" })
  @Min(1, { message: "Interval hours must be at least 1" })
  @Max(168, { message: "Interval hours cannot exceed 168 (7 days)" })
  intervalHours?: number | null

  @IsOptional()
  @IsString()
  @MaxLength(200)
  prnIndication?: string | null

  @IsOptional()
  @IsString()
  @MaxLength(200)
  scheduleLabel?: string | null
}

export class PrescriptionDurationDto {
  @IsInt({ message: "Duration value must be an integer" })
  @Min(1, { message: "Duration value must be at least 1" })
  @Max(365, { message: "Duration value cannot exceed 365" })
  value: number

  @IsString()
  @IsNotEmpty()
  unit: "DAYS" | "WEEKS" | "MONTHS" | "STAT"
}

export class DispenseQuantityDto {
  @IsNumber({ allowNaN: false, allowInfinity: false }, {
    message: "Dispense quantity count must be a finite number",
  })
  @IsPositive({
    message: "Dispense quantity count must be strictly greater than 0",
  })
  count: number

  @IsString()
  @IsNotEmpty({ message: "Package description is required" })
  @MaxLength(100)
  packageDescription: string
}

export class PrescriptionItemDto {
  @IsOptional()
  @IsString()
  catalogueMedicineId?: string | null

  @IsOptional()
  @IsBoolean()
  isCustom?: boolean

  @IsString()
  @IsNotEmpty({ message: "Medicine name is required" })
  @MaxLength(200)
  name: string

  @IsOptional()
  @IsString()
  @MaxLength(200)
  genericName?: string | null

  @IsEnum(MedicineFormulation, {
    message: "Invalid medicine formulation",
  })
  formulation: MedicineFormulation

  @ValidateNested()
  @Type(() => ProductStrengthDto)
  strength: ProductStrengthDto

  @ValidateNested()
  @Type(() => AdministeredDoseDto)
  administeredDose: AdministeredDoseDto

  @IsEnum(MedicineRoute, {
    message: "Invalid medicine route",
  })
  route: MedicineRoute

  @ValidateNested()
  @Type(() => DosageFrequencyDto)
  frequency: DosageFrequencyDto

  @ValidateNested()
  @Type(() => PrescriptionDurationDto)
  duration: PrescriptionDurationDto

  @ValidateNested()
  @Type(() => DispenseQuantityDto)
  dispenseQuantity: DispenseQuantityDto

  @IsOptional()
  @IsEnum(FoodInstruction, {
    message: "Invalid food instruction",
  })
  foodInstruction?: FoodInstruction

  @IsOptional()
  @IsString()
  @MaxLength(500)
  instructions?: string | null
}
