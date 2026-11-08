import {
  IsString,
  IsNotEmpty,
  MaxLength,
  IsEmail,
  IsObject,
  ValidateNested,
  IsOptional,
  Matches,
} from "class-validator"
import { Type } from "class-transformer"

export class ClinicAddressDto {
  @IsString()
  @IsNotEmpty()
  street: string

  @IsString()
  @IsNotEmpty()
  city: string

  @IsString()
  @IsNotEmpty()
  state: string

  @IsString()
  @IsNotEmpty()
  postalCode: string

  @IsString()
  @IsNotEmpty()
  country: string
}

export class CreateClinicDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string

  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9-]+$/, {
    message: "Slug must contain only lowercase letters, numbers, and hyphens",
  })
  slug?: string

  @IsString()
  @IsNotEmpty()
  phone: string

  @IsEmail()
  email: string

  @IsObject()
  @ValidateNested()
  @Type(() => ClinicAddressDto)
  address: ClinicAddressDto
}
