import {
  Module,
  OnApplicationShutdown,
  Logger,
  Optional,
} from '@nestjs/common';
import { MongooseModule, InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { ConfigModule } from '../config/config.module.js';
import { ConfigService } from '../config/config.service.js';
import { redactString } from '../common/logging/app-logger.service.js';

export class DatabaseDiagnostics {
  static readyState = 0;
  static isConnected = false;
  static lastError: string | null = null;
  static lastErrorTime: string | null = null;
  static reconnectAttempts = 0;
  static lastReconnectAttempt: string | null = null;
}

@Module({
  imports: [
    ConfigModule,
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const { uri, dbName } = configService.validateDatabaseConfig();
        return {
          uri,
          dbName,
          serverSelectionTimeoutMS: 30000,
          connectTimeoutMS: 30000,
          socketTimeoutMS: 45000,
          autoIndex: !configService.isProduction,
          // lazyConnection ensures the HTTP server boots immediately and remains accessible
          // while initial or background connections establish.
          lazyConnection: true,
          connectionErrorFactory: (err) =>
            new Error(redactString(err?.message || 'Database error')),
        };
      },
    }),
  ],
  exports: [MongooseModule],
})
export class DatabaseModule implements OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseModule.name);
  private reconnectTimer?: NodeJS.Timeout;
  private isShuttingDown = false;

  constructor(
    @Optional()
    @InjectConnection()
    private readonly connection?: Connection,
    @Optional()
    private readonly configService?: ConfigService,
  ) {
    if (this.connection) {
      this.registerConnectionEventListeners(this.connection);
    }
  }

  private registerConnectionEventListeners(conn: Connection) {
    conn.on('connected', () => {
      DatabaseDiagnostics.isConnected = true;
      DatabaseDiagnostics.readyState = conn.readyState;
      DatabaseDiagnostics.lastError = null;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
      }
      this.logger.log('MongoDB connection established successfully');
      const topologyType = (conn.getClient() as any)?.topology?.description?.type;
      if (topologyType) {
        this.logger.log(`MongoDB topology verified: ${topologyType}`);
      }
    });

    conn.on('reconnected', () => {
      DatabaseDiagnostics.isConnected = true;
      DatabaseDiagnostics.readyState = conn.readyState;
      DatabaseDiagnostics.lastError = null;
      this.logger.log('MongoDB connection re-established successfully');
    });

    conn.on('error', (err) => {
      DatabaseDiagnostics.isConnected = false;
      DatabaseDiagnostics.readyState = conn.readyState;
      const sanitized = redactString(
        err?.message || 'Database connection error',
      );
      DatabaseDiagnostics.lastError = sanitized;
      DatabaseDiagnostics.lastErrorTime = new Date().toISOString();
      this.logger.error(`MongoDB connection error: ${sanitized}`);
      this.scheduleReconnect(conn);
    });

    conn.on('disconnected', () => {
      DatabaseDiagnostics.isConnected = false;
      DatabaseDiagnostics.readyState = conn.readyState;
      this.logger.warn('MongoDB connection lost / disconnected');
      this.scheduleReconnect(conn);
    });
  }

  private scheduleReconnect(conn: Connection) {
    if (this.isShuttingDown || !this.configService || conn.readyState === 1 || conn.readyState === 2) {
      return;
    }
    if (this.reconnectTimer) return;

    DatabaseDiagnostics.reconnectAttempts++;
    DatabaseDiagnostics.lastReconnectAttempt = new Date().toISOString();
    const delay = Math.min(3000 * Math.min(DatabaseDiagnostics.reconnectAttempts, 4), 15000);
    this.logger.log(`Scheduling MongoDB reconnect attempt #${DatabaseDiagnostics.reconnectAttempts} in ${delay}ms...`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = undefined;
      if (this.isShuttingDown || !this.configService || conn.readyState === 1 || conn.readyState === 2) {
        return;
      }
      const configService = this.configService;
      try {
        const { uri, dbName } = configService.validateDatabaseConfig();
        this.logger.log(`Attempting MongoDB reconnection #${DatabaseDiagnostics.reconnectAttempts} (db: ${dbName})...`);
        await conn.openUri(uri, {
          dbName,
          serverSelectionTimeoutMS: 30000,
          connectTimeoutMS: 30000,
          socketTimeoutMS: 45000,
        });
        this.logger.log('MongoDB reconnected successfully via openUri.');
      } catch (err: any) {
        const sanitized = redactString(err?.message || 'Reconnection error');
        DatabaseDiagnostics.lastError = sanitized;
        DatabaseDiagnostics.lastErrorTime = new Date().toISOString();
        this.logger.error(`MongoDB reconnection attempt failed: ${sanitized}`);
        this.scheduleReconnect(conn);
      }
    }, delay);
  }

  async onApplicationShutdown(signal?: string) {
    this.isShuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.logger.log(
      `Closing MongoDB connection gracefully on signal: ${signal || 'shutdown'}`,
    );
    if (this.connection && this.connection.readyState !== 0) {
      try {
        await this.connection.close(false);
        this.logger.log('MongoDB connection closed successfully');
      } catch (err) {
        const sanitized = redactString(
          (err as Error)?.message || 'Error closing MongoDB connection',
        );
        this.logger.error(`Error during MongoDB shutdown: ${sanitized}`);
      }
    }
  }
}
