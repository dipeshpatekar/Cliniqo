import { IsString, IsNotEmpty, MinLength, MaxLength } from "class-validator"

export class CancelConsultationDto {
  @IsString()
  @IsNotEmpty({ message: "Cancellation reason is required" })
  @MinLength(5, {
    message: "Cancellation reason must be at least 5 characters",
  })
  @MaxLength(500, {
    message: "Cancellation reason must not exceed 500 characters",
  })
  reason: string
}
