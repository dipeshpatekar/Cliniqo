import { IsString, IsNotEmpty, IsOptional, MaxLength } from "class-validator"

export class ProvisionalMedicineDto {
  @IsString()
  @IsNotEmpty({ message: "Medicine name is required" })
  @MaxLength(200)
  name: string

  @IsString()
  @IsNotEmpty({ message: "Formulation is required" })
  @MaxLength(100)
  formulation: string

  @IsOptional()
  @IsString()
  @MaxLength(100)
  strength?: string

  @IsOptional()
  @IsString()
  @MaxLength(100)
  dose?: string

  @IsOptional()
  @IsString()
  @MaxLength(100)
  frequency?: string

  @IsOptional()
  @IsString()
  @MaxLength(100)
  duration?: string

  @IsOptional()
  @IsString()
  @MaxLength(100)
  route?: string

  @IsOptional()
  @IsString()
  @MaxLength(100)
  foodInstruction?: string

  @IsOptional()
  @IsString()
  @MaxLength(500)
  directions?: string
}
