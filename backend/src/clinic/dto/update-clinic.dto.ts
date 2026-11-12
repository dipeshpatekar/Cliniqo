import {
  IsString,
  IsOptional,
  MaxLength,
  IsEmail,
  IsObject,
  ValidateNested,
  Matches,
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

  @IsOptional()
  @IsString({ message: "location_link must be a string." })
  @MaxLength(500, { message: "location_link cannot exceed 500 characters." })
  @Matches(/^(https?:\/\/[^\s]+)?$/, {
    message: "location_link must be a valid HTTP or HTTPS URL or empty",
  })
  location_link?: string

  @IsOptional()
  @IsString({ message: "locationLink must be a string." })
  @MaxLength(500, { message: "locationLink cannot exceed 500 characters." })
  @Matches(/^(https?:\/\/[^\s]+)?$/, {
    message: "locationLink must be a valid HTTP or HTTPS URL or empty",
  })
  locationLink?: string
}
