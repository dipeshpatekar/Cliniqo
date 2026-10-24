import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { HealthModule } from './health/health.module.js';
import { DatabaseModule } from './database/database.module.js';

@Module({
  imports: [ConfigModule, HealthModule, DatabaseModule],
})
export class AppModule {}
