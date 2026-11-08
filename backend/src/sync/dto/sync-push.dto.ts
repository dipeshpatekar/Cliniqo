import {
  IsString,
  IsNotEmpty,
  IsEnum,
  IsOptional,
  IsInt,
  Min,
  IsObject,
  IsArray,
  ValidateNested,
} from "class-validator"
import { Type } from "class-transformer"
import {
  SyncEntityType,
  SyncActionType,
} from "../schemas/sync-change-feed.schema.js"

export class SyncMutationDto {
  @IsString()
  @IsNotEmpty()
  outboxId: string

  @IsEnum(SyncEntityType)
  entityType: SyncEntityType

  @IsEnum(SyncActionType)
  action: SyncActionType

  @IsString()
  @IsNotEmpty()
  idempotencyKey: string

  @IsString()
  @IsNotEmpty()
  entityId: string

  @IsOptional()
  @IsString()
  serverId?: string | null

  @IsInt()
  @Min(0)
  clientVersion: number

  @IsObject()
  payload: Record<string, any>
}

export class SyncPushDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SyncMutationDto)
  mutations: SyncMutationDto[]
}

export interface SyncMutationResult {
  outboxId: string
  status: "APPLIED" | "CONFLICT" | "REJECTED"
  entityType: string
  entityId: string
  serverId?: string
  serverVersion?: number
  error?: string
  conflictDetails?: {
    conflictReason: string
    serverVersion: number
    clientVersion: number
    reason?: string
    conflictFields?: string[]
    serverState?: any
    clientPayload?: any
  } | null
}

export interface SyncPushResponse {
  processedAt: string
  clinicId: string
  results: SyncMutationResult[]
}
