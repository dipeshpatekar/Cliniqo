import {
  IsString,
  IsOptional,
  MaxLength,
  IsEmail,
  IsObject,
  ValidateNested,
} from "class-validator"
import { Type } from "class-transformer"
import { ClinicAddressDto } from "./create-clinic.dto.js"

export class UpdateClinicDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string

  @IsOptional()
  @IsString()
  phone?: string

  @IsOptional()
  @IsEmail()
  email?: string

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ClinicAddressDto)
  address?: ClinicAddressDto
}
