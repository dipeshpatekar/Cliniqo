import { IsOptional, IsString, IsEnum, IsInt, Min, Max } from "class-validator"
import { Type } from "class-transformer"
import { PrescriptionStatus } from "../schemas/prescription.schema.js"

export class QueryPrescriptionsDto {
  @IsOptional()
  @IsString()
  patientId?: string

  @IsOptional()
  @IsString()
  consultationId?: string

  @IsOptional()
  @IsEnum(PrescriptionStatus)
  status?: PrescriptionStatus

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
  limit?: number = 20
}
