import { IsString, IsOptional, IsBoolean } from "class-validator"

export class TriggerImportDto {
  @IsOptional()
  @IsString()
  sourcePath?: string

  @IsOptional()
  @IsBoolean()
  dryRun?: boolean
}
