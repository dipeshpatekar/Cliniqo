import {
  IsInt,
  Min,
  IsString,
  MaxLength,
  IsOptional,
  ValidateNested,
  IsArray,
} from "class-validator"
import { Type } from "class-transformer"
import { VitalsDto } from "./vitals.dto.js"
import { FollowUpDto } from "./follow-up.dto.js"
import { ProvisionalMedicineDto } from "./provisional-medicine.dto.js"

export class FinalizeConsultationDto {
  @Type(() => Number)
  @IsInt({ message: "expectedVersion must be an integer" })
  @Min(1, { message: "expectedVersion must be at least 1" })
  expectedVersion: number

  @IsOptional()
  @IsString()
  @MaxLength(1000, {
    message: "Chief complaint must not exceed 1000 characters",
  })
  chiefComplaint?: string

  @IsOptional()
  @IsString()
  @MaxLength(1000, { message: "Diagnosis must not exceed 1000 characters" })
  diagnosis?: string

  @IsOptional()
  @IsString()
  @MaxLength(200, {
    message: "Symptom duration must not exceed 200 characters",
  })
  symptomDuration?: string

  @IsOptional()
  @IsString()
  @MaxLength(5000, {
    message: "Clinical notes must not exceed 5000 characters",
  })
  clinicalNotes?: string

  @IsOptional()
  @ValidateNested()
  @Type(() => VitalsDto)
  vitals?: VitalsDto

  @IsOptional()
  @ValidateNested()
  @Type(() => FollowUpDto)
  followUp?: FollowUpDto

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProvisionalMedicineDto)
  provisionalMedicines?: ProvisionalMedicineDto[]
}
