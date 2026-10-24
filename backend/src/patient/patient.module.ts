import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ClinicModule } from '../clinic/clinic.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { Patient, PatientSchema } from './schemas/patient.schema.js';
import {
  ClinicSequenceCounter,
  ClinicSequenceCounterSchema,
} from './schemas/clinic-sequence-counter.schema.js';
import { PatientService } from './patient.service.js';
import { PatientController } from './patient.controller.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Patient.name, schema: PatientSchema },
      {
        name: ClinicSequenceCounter.name,
        schema: ClinicSequenceCounterSchema,
      },
    ]),
    ClinicModule,
    AuthModule,
  ],
  controllers: [PatientController],
  providers: [PatientService],
  exports: [PatientService, MongooseModule],
})
export class PatientModule {}
