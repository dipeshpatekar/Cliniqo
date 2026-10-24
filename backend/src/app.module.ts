import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { HealthModule } from './health/health.module.js';
import { DatabaseModule } from './database/database.module.js';
import { AuthModule } from './auth/auth.module.js';
import { ClinicModule } from './clinic/clinic.module.js';

@Module({
  imports: [ConfigModule, HealthModule, DatabaseModule, AuthModule, ClinicModule],
})
export class AppModule {}
