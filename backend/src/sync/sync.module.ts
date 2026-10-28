import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ClinicModule } from '../clinic/clinic.module.js';
import { AuthModule } from '../auth/auth.module.js';
import {
  SyncChangeFeed,
  SyncChangeFeedSchema,
} from './schemas/sync-change-feed.schema.js';
import {
  ClinicSyncCounter,
  ClinicSyncCounterSchema,
} from './schemas/clinic-sync-counter.schema.js';
import {
  SyncConflict,
  SyncConflictSchema,
} from './schemas/sync-conflict.schema.js';
import {
  IdempotencyRecord,
  IdempotencyRecordSchema,
} from '../common/schemas/idempotency-record.schema.js';
import {
  Patient,
  PatientSchema,
} from '../patient/schemas/patient.schema.js';
import {
  Consultation,
  ConsultationSchema,
} from '../consultation/schemas/consultation.schema.js';
import {
  Prescription,
  PrescriptionSchema,
} from '../prescription/schemas/prescription.schema.js';
import {
  PrescriptionRevision,
  PrescriptionRevisionSchema,
} from '../prescription/schemas/prescription-revision.schema.js';
import {
  ClinicSequenceCounter,
  ClinicSequenceCounterSchema,
} from '../patient/schemas/clinic-sequence-counter.schema.js';
import {
  ClinicMembership,
  ClinicMembershipSchema,
} from '../clinic/schemas/clinic-membership.schema.js';
import {
  Clinic,
  ClinicSchema,
} from '../clinic/schemas/clinic.schema.js';
import {
  Invoice,
  InvoiceSchema,
} from '../billing/schemas/invoice.schema.js';
import { SyncService } from './sync.service.js';
import { SyncController } from './sync.controller.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SyncChangeFeed.name, schema: SyncChangeFeedSchema },
      { name: ClinicSyncCounter.name, schema: ClinicSyncCounterSchema },
      { name: SyncConflict.name, schema: SyncConflictSchema },
      { name: IdempotencyRecord.name, schema: IdempotencyRecordSchema },
      { name: Patient.name, schema: PatientSchema },
      { name: Consultation.name, schema: ConsultationSchema },
      { name: Prescription.name, schema: PrescriptionSchema },
      { name: PrescriptionRevision.name, schema: PrescriptionRevisionSchema },
      { name: ClinicSequenceCounter.name, schema: ClinicSequenceCounterSchema },
      { name: ClinicMembership.name, schema: ClinicMembershipSchema },
      { name: Clinic.name, schema: ClinicSchema },
      { name: Invoice.name, schema: InvoiceSchema },
    ]),
    ClinicModule,
    AuthModule,
  ],
  controllers: [SyncController],
  providers: [SyncService],
  exports: [SyncService],
})
export class SyncModule {}
