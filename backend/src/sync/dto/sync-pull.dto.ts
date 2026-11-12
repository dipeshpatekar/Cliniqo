import { IsOptional, IsInt, Min, Max } from "class-validator"
import { Type } from "class-transformer"

export class SyncPullQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sinceSeq?: number = 0

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number = 50
}

export interface SyncFeedItem {
  seq: number
  entityType: string
  entityId: string
  clientEntityId?: string | null
  action: string
  version: number
  payload: Record<string, any>
  committedAt: string
  actorDoctorId: string
}

export interface SyncPullResponse {
  clinicId: string
  sinceSeq: number
  currentSeq: number
  hasMore: boolean
  changes: SyncFeedItem[]
}
