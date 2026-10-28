import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ClinicModule } from '../clinic/clinic.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { PatientModule } from '../patient/patient.module.js';
import {
  Invoice,
  InvoiceSchema,
} from './schemas/invoice.schema.js';
import {
  Patient,
  PatientSchema,
} from '../patient/schemas/patient.schema.js';
import {
  IdempotencyRecord,
  IdempotencyRecordSchema,
} from '../common/schemas/idempotency-record.schema.js';
import { BillingService } from './billing.service.js';
import { BillingController } from './billing.controller.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Invoice.name, schema: InvoiceSchema },
      { name: Patient.name, schema: PatientSchema },
      { name: IdempotencyRecord.name, schema: IdempotencyRecordSchema },
    ]),
    ClinicModule,
    AuthModule,
    PatientModule,
  ],
  controllers: [BillingController],
  providers: [BillingService],
  exports: [BillingService, MongooseModule],
})
export class BillingModule {}
