import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { HealthModule } from './health/health.module.js';
import { DatabaseModule } from './database/database.module.js';
import { AuthModule } from './auth/auth.module.js';
import { ClinicModule } from './clinic/clinic.module.js';
import { PatientModule } from './patient/patient.module.js';
import { ConsultationModule } from './consultation/consultation.module.js';
import { PrescriptionModule } from './prescription/prescription.module.js';

@Module({
  imports: [
    ConfigModule,
    HealthModule,
    DatabaseModule,
    AuthModule,
    ClinicModule,
    PatientModule,
    ConsultationModule,
    PrescriptionModule,
  ],
})
export class AppModule {}
