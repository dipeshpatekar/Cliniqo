import {
  IsString,
  IsOptional,
  IsEnum,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PatientGender } from '../schemas/patient.schema.js';

export enum PatientSortOption {
  RECENT = 'recent',
  NAME_ASC = 'name_asc',
  NEWEST = 'newest',
}

export class QueryPatientsDto {
  @IsOptional()
  @IsString()
  query?: string;

  @IsOptional()
  @IsEnum(PatientGender)
  gender?: PatientGender;

  @IsOptional()
  @IsEnum(PatientSortOption)
  sort?: PatientSortOption = PatientSortOption.RECENT;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
