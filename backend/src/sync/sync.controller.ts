import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
  ForbiddenException,
} from "@nestjs/common"
import type { Request } from "express"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard.js"
import { ClinicScopeGuard } from "../clinic/guards/clinic-scope.guard.js"
import { SyncService } from "./sync.service.js"
import { SyncPushDto } from "./dto/sync-push.dto.js"
import { SyncPullQueryDto } from "./dto/sync-pull.dto.js"

@Controller("sync")
@UseGuards(JwtAuthGuard, ClinicScopeGuard)
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  /**
   * Pushes a batch of client mutations to the cloud backend.
   * Doctor identity and clinic tenancy are derived strictly from the server-verified session.
   */
  @Post("push")
  @HttpCode(HttpStatus.OK)
  async push(@Body() dto: SyncPushDto, @Req() req: Request) {
    const clinic = (req as any).clinic
    const doctor = (req as any).doctor || (req as any).user

    if (!clinic || !clinic._id || !doctor || !doctor._id) {
      throw new ForbiddenException("Invalid clinic or doctor session context.")
    }

    return this.syncService.push(clinic._id, doctor._id, dto)
  }

  /**
   * Pulls incremental change events since a monotonic sequence cursor.
   * Ensures gapless, ordered stream of committed domain mutations.
   */
  @Get("pull")
  @HttpCode(HttpStatus.OK)
  async pull(@Query() query: SyncPullQueryDto, @Req() req: Request) {
    const clinic = (req as any).clinic

    if (!clinic || !clinic._id) {
      throw new ForbiddenException("Invalid clinic session context.")
    }

    return this.syncService.pull(clinic._id, query)
  }
}
