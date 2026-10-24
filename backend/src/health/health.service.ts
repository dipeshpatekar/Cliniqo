import { Injectable, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';

export interface HealthCheckResult {
  status: 'ok' | 'error';
  timestamp: string;
  uptime: number;
}

export interface ReadinessCheckResult {
  status: 'ready' | 'not_ready';
  timestamp: string;
  checks: {
    process: 'ok';
    database: 'ok' | 'unavailable';
  };
}

@Injectable()
export class HealthService {
  private readonly startTime = Date.now();

  constructor(
    @Optional()
    @InjectConnection()
    private readonly connection?: Connection,
  ) {}

  getLiveness(): HealthCheckResult {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
    };
  }

  async getReadiness(): Promise<ReadinessCheckResult> {
    const isDbConnected = await this.checkDatabaseHealth();

    return {
      status: isDbConnected ? 'ready' : 'not_ready',
      timestamp: new Date().toISOString(),
      checks: {
        process: 'ok',
        database: isDbConnected ? 'ok' : 'unavailable',
      },
    };
  }

  private async checkDatabaseHealth(): Promise<boolean> {
    if (!this.connection || this.connection.readyState !== 1) {
      return false;
    }

    try {
      if (!this.connection.db) {
        return false;
      }

      const pingPromise = this.connection.db.admin().ping();
      let timeoutHandle: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error('Database ping timeout')),
          2000,
        );
      });

      try {
        const res = (await Promise.race([pingPromise, timeoutPromise])) as any;
        return Boolean(res && (res.ok === 1 || res.ok === true));
      } finally {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
      }
    } catch {
      // Return false safely without revealing internal errors, hosts, or traces
      return false;
    }
  }
}
