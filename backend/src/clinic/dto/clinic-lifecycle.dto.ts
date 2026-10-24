import { IsNotEmpty, IsString, Length } from 'class-validator';

export class ClinicLifecycleDto {
  @IsString()
  @IsNotEmpty({ message: 'Reason is required for clinic status transitions' })
  @Length(10, 500, {
    message: 'Reason must be between 10 and 500 characters',
  })
  reason: string;
}
