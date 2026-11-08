import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsInt,
  Min,
  MinLength,
  MaxLength,
} from "class-validator"

export class DiscontinuePrescriptionDto {
  @IsString()
  @IsNotEmpty({ message: "Discontinuation reason is required" })
  @MinLength(5, {
    message: "Discontinuation reason must be at least 5 characters long",
  })
  @MaxLength(500)
  discontinuationReason: string

  @IsOptional()
  @IsInt()
  @Min(1)
  expectedVersion?: number
}
