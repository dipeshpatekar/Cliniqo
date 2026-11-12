import { IsOptional, IsString, MaxLength, IsDateString } from "class-validator"

export class FollowUpDto {
  @IsOptional()
  @IsDateString({}, {
    message: "Follow-up date must be a valid ISO date string",
  })
  date?: string

  @IsOptional()
  @IsString()
  @MaxLength(500, {
    message: "Follow-up instructions must not exceed 500 characters",
  })
  instructions?: string
}
