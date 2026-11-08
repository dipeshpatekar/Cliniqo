import {
  Controller,
  Get,
  Res,
  HttpStatus,
  Headers,
  UnauthorizedException,
  Optional,
} from "@nestjs/common"
import type { Response } from "express"
import { HealthService } from "./health.service.js"
import { ConfigService } from "../config/config.service.js"

@Controller("health")
export class HealthController {
  constructor(
    private readonly healthService: HealthService,
    @Optional()
    private readonly configService?: ConfigService,
  ) {}

  @Get()
  getHealth() {
    return this.healthService.getLiveness()
  }

  @Get("live")
  getLiveness() {
    return this.healthService.getLiveness()
  }

  @Get("ready")
  async getReadiness(@Res({ passthrough: true }) res: Response) {
    const readiness = await this.healthService.getReadiness()
    if (readiness.status !== "ready") {
      res.status(HttpStatus.SERVICE_UNAVAILABLE)
    }
    return readiness
  }

  @Get("diag")
  async getDiagnostics(@Headers("x-admin-key") adminKey?: string) {
    const configuredKey = this.configService?.adminDiagnosticKey
    if (!configuredKey || !adminKey || adminKey !== configuredKey) {
      throw new UnauthorizedException("Unauthorized diagnostic access")
    }
    return this.healthService.getSanitizedDiagnostics()
  }
}
