import {
  IsString,
  IsOptional,
  IsEnum,
  MaxLength,
  IsBoolean,
} from 'class-validator';
import {
  MedicineFormulation,
  MedicineRoute,
  FoodInstruction,
} from '../../prescription/schemas/prescription-item.schema.js';

export class UpdateFormularyItemDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  activeIngredient?: string;

  @IsOptional()
  @IsEnum(MedicineFormulation)
  formulation?: MedicineFormulation;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  strength?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  defaultDose?: string;

  @IsOptional()
  @IsEnum(MedicineRoute)
  defaultRoute?: MedicineRoute;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  defaultFrequency?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  defaultDuration?: string;

  @IsOptional()
  @IsEnum(FoodInstruction)
  defaultFoodInstruction?: FoodInstruction;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  defaultDirections?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
