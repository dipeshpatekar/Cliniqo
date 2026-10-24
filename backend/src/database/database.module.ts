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

@Module({
  imports: [
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const { uri, dbName } = configService.validateDatabaseConfig();
        return {
          uri,
          dbName,
          serverSelectionTimeoutMS: 5000,
          connectTimeoutMS: 5000,
          socketTimeoutMS: 45000,
          autoIndex: !configService.isProduction,
          // lazyConnection ensures the HTTP server boots immediately and remains accessible
          // even if MongoDB is initially down/unreachable.
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

  constructor(
    @Optional()
    @InjectConnection()
    private readonly connection?: Connection,
  ) {
    if (this.connection) {
      this.registerConnectionEventListeners(this.connection);
    }
  }

  private registerConnectionEventListeners(conn: Connection) {
    conn.on('connected', () => {
      this.logger.log('MongoDB connection established successfully');
    });

    conn.on('reconnected', () => {
      this.logger.log('MongoDB connection re-established successfully');
    });

    conn.on('error', (err) => {
      const sanitized = redactString(
        err?.message || 'Database connection error',
      );
      this.logger.error(`MongoDB connection error: ${sanitized}`);
    });

    conn.on('disconnected', () => {
      this.logger.warn('MongoDB connection lost / disconnected');
    });
  }

  async onApplicationShutdown(signal?: string) {
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
