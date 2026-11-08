import { Module } from "@nestjs/common"
import { MongooseModule } from "@nestjs/mongoose"
import { ClinicModule } from "../clinic/clinic.module.js"
import { AuthModule } from "../auth/auth.module.js"
import { PatientModule } from "../patient/patient.module.js"
import {
  Consultation,
  ConsultationSchema,
} from "./schemas/consultation.schema.js"
import {
  ConsultationAddendum,
  ConsultationAddendumSchema,
} from "./schemas/consultation-addendum.schema.js"
import {
  IdempotencyRecord,
  IdempotencyRecordSchema,
} from "../common/schemas/idempotency-record.schema.js"
import { Patient, PatientSchema } from "../patient/schemas/patient.schema.js"
import {
  ClinicAuditLog,
  ClinicAuditLogSchema,
} from "../clinic/schemas/clinic-audit-log.schema.js"
import { ConsultationService } from "./consultation.service.js"
import { ConsultationController } from "./consultation.controller.js"

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Consultation.name, schema: ConsultationSchema },
      { name: ConsultationAddendum.name, schema: ConsultationAddendumSchema },
      { name: IdempotencyRecord.name, schema: IdempotencyRecordSchema },
      { name: Patient.name, schema: PatientSchema },
      { name: ClinicAuditLog.name, schema: ClinicAuditLogSchema },
    ]),
    ClinicModule,
    AuthModule,
    PatientModule,
  ],
  controllers: [ConsultationController],
  providers: [ConsultationService],
  exports: [ConsultationService, MongooseModule],
})
export class ConsultationModule {}
