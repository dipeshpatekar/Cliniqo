import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ClinicModule } from '../clinic/clinic.module.js';
import { AuthModule } from '../auth/auth.module.js';
import {
  Prescription,
  PrescriptionSchema,
} from './schemas/prescription.schema.js';
import {
  PrescriptionRevision,
  PrescriptionRevisionSchema,
} from './schemas/prescription-revision.schema.js';
import {
  Consultation,
  ConsultationSchema,
} from '../consultation/schemas/consultation.schema.js';
import {
  Patient,
  PatientSchema,
} from '../patient/schemas/patient.schema.js';
import {
  ClinicSequenceCounter,
  ClinicSequenceCounterSchema,
} from '../patient/schemas/clinic-sequence-counter.schema.js';
import {
  ClinicAuditLog,
  ClinicAuditLogSchema,
} from '../clinic/schemas/clinic-audit-log.schema.js';
import {
  IdempotencyRecord,
  IdempotencyRecordSchema,
} from '../common/schemas/idempotency-record.schema.js';
import {
  ClinicMembership,
  ClinicMembershipSchema,
} from '../clinic/schemas/clinic-membership.schema.js';
import {
  Clinic,
  ClinicSchema,
} from '../clinic/schemas/clinic.schema.js';
import { PrescriptionService } from './prescription.service.js';
import { PrescriptionController } from './prescription.controller.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Prescription.name, schema: PrescriptionSchema },
      { name: PrescriptionRevision.name, schema: PrescriptionRevisionSchema },
      { name: Consultation.name, schema: ConsultationSchema },
      { name: Patient.name, schema: PatientSchema },
      { name: ClinicSequenceCounter.name, schema: ClinicSequenceCounterSchema },
      { name: ClinicAuditLog.name, schema: ClinicAuditLogSchema },
      { name: IdempotencyRecord.name, schema: IdempotencyRecordSchema },
      { name: ClinicMembership.name, schema: ClinicMembershipSchema },
      { name: Clinic.name, schema: ClinicSchema },
    ]),
    ClinicModule,
    AuthModule,
  ],
  controllers: [PrescriptionController],
  providers: [PrescriptionService],
  exports: [PrescriptionService, MongooseModule],
})
export class PrescriptionModule {}
