import {
  IsInt,
  Min,
  IsOptional,
  IsString,
  MaxLength,
  IsDateString,
  Matches,
  ValidateNested,
  IsArray,
} from "class-validator"
import { Type } from "class-transformer"
import { VitalsDto } from "./vitals.dto.js"
import { FollowUpDto } from "./follow-up.dto.js"
import { ProvisionalMedicineDto } from "./provisional-medicine.dto.js"

export class UpdateConsultationDto {
  @Type(() => Number)
  @IsInt({ message: "expectedVersion must be an integer" })
  @Min(1, { message: "expectedVersion must be at least 1" })
  expectedVersion: number

  @IsOptional()
  @IsDateString({}, {
    message: "Consultation date must be a valid ISO date string",
  })
  consultationDate?: string

  @IsOptional()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, {
    message: "Consultation time must be in HH:mm 24-hour format (e.g. 11:20)",
  })
  consultationTime?: string

  @IsOptional()
  @ValidateNested()
  @Type(() => VitalsDto)
  vitals?: VitalsDto

  @IsOptional()
  @IsString()
  @MaxLength(1000, {
    message: "Chief complaint must not exceed 1000 characters",
  })
  chiefComplaint?: string

  @IsOptional()
  @IsString()
  @MaxLength(200, {
    message: "Symptom duration must not exceed 200 characters",
  })
  symptomDuration?: string

  @IsOptional()
  @IsString()
  @MaxLength(1000, { message: "Diagnosis must not exceed 1000 characters" })
  diagnosis?: string

  @IsOptional()
  @IsString()
  @MaxLength(5000, {
    message: "Clinical notes must not exceed 5000 characters",
  })
  clinicalNotes?: string

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
