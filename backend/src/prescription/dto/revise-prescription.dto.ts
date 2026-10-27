import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsInt,
  Min,
  MinLength,
  MaxLength,
  ValidateNested,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PrescriptionItemDto } from './prescription-item.dto.js';

export class RevisePrescriptionDto {
  @IsInt({ message: 'expectedRevisionNumber must be an integer' })
  @Min(1, { message: 'expectedRevisionNumber must be at least 1' })
  expectedRevisionNumber: number;

  @IsInt({ message: 'expectedVersion must be an integer' })
  @Min(1, { message: 'expectedVersion must be at least 1' })
  expectedVersion: number;

  @IsString()
  @IsNotEmpty({ message: 'Reason for revision is required' })
  @MinLength(5, { message: 'Reason for revision must be at least 5 characters long' })
  @MaxLength(500)
  reasonForRevision: string;

  @ValidateNested({ each: true })
  @Type(() => PrescriptionItemDto)
  @ArrayMinSize(1, { message: 'Revised prescription must contain at least one medicine item' })
  items: PrescriptionItemDto[];

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  generalAdvice?: string | null;
}
