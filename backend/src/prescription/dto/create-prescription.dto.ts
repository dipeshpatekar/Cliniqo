import {
  IsString,
  IsOptional,
  MaxLength,
  ValidateNested,
  ArrayMinSize,
} from "class-validator"
import { Type } from "class-transformer"
import { PrescriptionItemDto } from "./prescription-item.dto.js"

export class CreatePrescriptionDto {
  @ValidateNested({ each: true })
  @Type(() => PrescriptionItemDto)
  @ArrayMinSize(1, {
    message: "Prescription must contain at least one medicine item",
  })
  items: PrescriptionItemDto[]

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  generalAdvice?: string | null

  @IsOptional()
  @IsString()
  replacesPrescriptionId?: string | null
}
