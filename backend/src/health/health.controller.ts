import { Controller, Get, Res, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { HealthService } from './health.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  getHealth() {
    return this.healthService.getLiveness();
  }

  @Get('live')
  getLiveness() {
    return this.healthService.getLiveness();
  }

  @Get('ready')
  async getReadiness(@Res({ passthrough: true }) res: Response) {
    const readiness = await this.healthService.getReadiness();
    if (readiness.status !== 'ready') {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return readiness;
  }
}
