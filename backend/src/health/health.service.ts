import { Injectable, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { DatabaseDiagnostics } from '../database/database.module.js';

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

  async getDiagnostics() {
    let egressIp: string | null = null;
    try {
      const res = await fetch('https://api.ipify.org?format=json', {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const data = (await res.json()) as any;
        egressIp = data.ip || null;
      }
    } catch (e: any) {
      egressIp = `Lookup error: ${e.message}`;
    }

    const stateMap = ['disconnected', 'connected', 'connecting', 'disconnecting'];
    const readyState = this.connection?.readyState ?? 0;

    return {
      status: readyState === 1 ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      database: {
        readyState,
        readyStateText: stateMap[readyState] || 'unknown',
        isConnected: readyState === 1,
        lastError: DatabaseDiagnostics.lastError,
        lastErrorTime: DatabaseDiagnostics.lastErrorTime,
        reconnectAttempts: DatabaseDiagnostics.reconnectAttempts,
        lastReconnectAttempt: DatabaseDiagnostics.lastReconnectAttempt,
      },
      network: {
        egressIp,
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

      const pingPromise =
        typeof (this.connection.db as any).command === 'function'
          ? (this.connection.db as any).command({ ping: 1 })
          : this.connection.db.admin().ping();
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
