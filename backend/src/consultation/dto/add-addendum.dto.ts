import { IsString, IsNotEmpty, MaxLength } from "class-validator"

export class AddAddendumDto {
  @IsString()
  @IsNotEmpty({ message: "Addendum note is required" })
  @MaxLength(2000, { message: "Addendum note must not exceed 2000 characters" })
  note: string

  @IsString()
  @IsNotEmpty({ message: "Reason for addendum is required" })
  @MaxLength(500, {
    message: "Reason for addendum must not exceed 500 characters",
  })
  reasonForAddendum: string
}
