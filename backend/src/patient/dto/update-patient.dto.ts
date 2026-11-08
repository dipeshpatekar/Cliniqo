import {
  IsString,
  MaxLength,
  IsEnum,
  IsNumber,
  Min,
  Max,
  IsOptional,
  IsArray,
  IsDateString,
  Matches,
} from "class-validator"
import { Type } from "class-transformer"
import { PatientGender } from "../schemas/patient.schema.js"

export class UpdatePatientDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(150)
  age?: number

  @IsOptional()
  @IsEnum(PatientGender, {
    message: "Gender must be MALE, FEMALE, or OTHER",
  })
  gender?: PatientGender

  @IsOptional()
  @IsString()
  @Matches(/^[+]?[0-9\s-]{10,15}$/, {
    message:
      "Phone number must contain between 10 and 15 valid digits/characters",
  })
  phone?: string

  @IsOptional()
  @IsDateString()
  dateOfBirth?: string

  @IsOptional()
  @IsString()
  @MaxLength(20)
  alternatePhone?: string

  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allergies?: string[]

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  conditions?: string[]
}
