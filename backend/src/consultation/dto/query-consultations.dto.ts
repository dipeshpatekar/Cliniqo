import { IsOptional, IsInt, Min, Max, IsEnum, IsString } from "class-validator"
import { Type } from "class-transformer"
import { ConsultationStatus } from "../schemas/consultation.schema.js"

export class QueryConsultationsDto {
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

  @IsOptional()
  @IsEnum(ConsultationStatus, {
    message: "Status must be DRAFT, FINALIZED, or CANCELLED",
  })
  status?: ConsultationStatus

  @IsOptional()
  @IsString()
  doctorId?: string
}
