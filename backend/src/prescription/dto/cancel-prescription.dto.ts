import { IsString, IsNotEmpty, IsOptional, IsInt, Min, MinLength, MaxLength } from 'class-validator';

export class CancelPrescriptionDto {
  @IsString()
  @IsNotEmpty({ message: 'Cancellation reason is required' })
  @MinLength(5, { message: 'Cancellation reason must be at least 5 characters long' })
  @MaxLength(500)
  cancellationReason: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}
