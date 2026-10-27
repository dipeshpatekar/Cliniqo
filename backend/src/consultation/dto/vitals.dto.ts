import {
  IsInt,
  IsNumber,
  IsOptional,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';

export class VitalsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Systolic blood pressure must be an integer' })
  @Min(40, { message: 'Systolic blood pressure must be at least 40 mmHg' })
  @Max(300, { message: 'Systolic blood pressure must not exceed 300 mmHg' })
  systolic?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Diastolic blood pressure must be an integer' })
  @Min(20, { message: 'Diastolic blood pressure must be at least 20 mmHg' })
  @Max(200, { message: 'Diastolic blood pressure must not exceed 200 mmHg' })
  diastolic?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Heart rate must be an integer' })
  @Min(30, { message: 'Heart rate must be at least 30 bpm' })
  @Max(250, { message: 'Heart rate must not exceed 250 bpm' })
  heartRate?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'SpO2 must be a number' })
  @Min(50, { message: 'SpO2 must be at least 50%' })
  @Max(100, { message: 'SpO2 must not exceed 100%' })
  spo2?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'Temperature must be a number' })
  @Min(85.0, { message: 'Temperature must be at least 85.0 °F' })
  @Max(110.0, { message: 'Temperature must not exceed 110.0 °F' })
  temperature?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'Height must be a number' })
  @Min(20.0, { message: 'Height must be at least 20.0 cm' })
  @Max(280.0, { message: 'Height must not exceed 280.0 cm' })
  height?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'Weight must be a number' })
  @Min(0.5, { message: 'Weight must be at least 0.5 kg' })
  @Max(500.0, { message: 'Weight must not exceed 500.0 kg' })
  weight?: number;
}
