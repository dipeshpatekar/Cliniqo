import { IsString, IsOptional, IsEnum, IsInt, Min, Max } from "class-validator"
import { Type } from "class-transformer"
import { MedicineFormulation } from "../../prescription/schemas/prescription-item.schema.js"

export class QueryFormularyDto {
  @IsOptional()
  @IsString()
  search?: string

  @IsOptional()
  @IsEnum(MedicineFormulation)
  formulation?: MedicineFormulation

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 50
}
