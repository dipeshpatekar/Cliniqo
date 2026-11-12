import { IsString, IsOptional, IsEnum, IsInt, Min, Max } from "class-validator"
import { Type } from "class-transformer"

export enum CatalogueSearchType {
  ALL = "all",
  BRAND = "brand",
  GENERIC = "generic",
}

export class SearchCatalogueDto {
  @IsString()
  q: string

  @IsOptional()
  @IsEnum(CatalogueSearchType)
  type?: CatalogueSearchType = CatalogueSearchType.ALL

  @IsOptional()
  @IsString()
  formulation?: string

  @IsOptional()
  @IsString()
  releaseType?: string

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1
}

export class GetStrengthsQueryDto {
  @IsString()
  name: string

  @IsOptional()
  @IsString()
  formulation?: string
}

export class CatalogueFeedQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number = 100
}
