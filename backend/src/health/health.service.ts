import { Injectable } from '@nestjs/common';

export interface HealthCheckResult {
  status: 'ok' | 'error';
  timestamp: string;
  uptime: number;
}

export interface ReadinessCheckResult {
  status: 'ready' | 'not_ready';
  timestamp: string;
  checks: Record<string, 'ok' | 'degraded' | 'unavailable'>;
}

@Injectable()
export class HealthService {
  private readonly startTime = Date.now();

  getLiveness(): HealthCheckResult {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
    };
  }

  getReadiness(): ReadinessCheckResult {
    // In Milestone 2A, the process itself is ready.
    // In Milestone 2B, this will check MongoDB connectivity via registered indicator.
    return {
      status: 'ready',
      timestamp: new Date().toISOString(),
      checks: {
        process: 'ok',
      },
    };
  }
}
