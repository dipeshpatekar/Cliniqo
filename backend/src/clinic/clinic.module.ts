import { Module } from "@nestjs/common"
import { MongooseModule } from "@nestjs/mongoose"
import { AuthModule } from "../auth/auth.module.js"
import { Clinic, ClinicSchema } from "./schemas/clinic.schema.js"
import {
  ClinicMembership,
  ClinicMembershipSchema,
} from "./schemas/clinic-membership.schema.js"
import {
  ClinicInvitation,
  ClinicInvitationSchema,
} from "./schemas/clinic-invitation.schema.js"
import {
  InvitationOutbox,
  InvitationOutboxSchema,
} from "./schemas/invitation-outbox.schema.js"
import {
  ClinicAuditLog,
  ClinicAuditLogSchema,
} from "./schemas/clinic-audit-log.schema.js"
import { ClinicService } from "./clinic.service.js"
import { ClinicAuditService } from "./clinic-audit.service.js"
import { ClinicOutboxService } from "./clinic-outbox.service.js"
import { ClinicScopeGuard } from "./guards/clinic-scope.guard.js"
import { ClinicPermissionsGuard } from "./guards/clinic-permissions.guard.js"
import { ClinicController } from "./clinic.controller.js"

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Clinic.name, schema: ClinicSchema },
      { name: ClinicMembership.name, schema: ClinicMembershipSchema },
      { name: ClinicInvitation.name, schema: ClinicInvitationSchema },
      { name: InvitationOutbox.name, schema: InvitationOutboxSchema },
      { name: ClinicAuditLog.name, schema: ClinicAuditLogSchema },
    ]),
    AuthModule,
  ],
  controllers: [ClinicController],
  providers: [
    ClinicService,
    ClinicAuditService,
    ClinicOutboxService,
    ClinicScopeGuard,
    ClinicPermissionsGuard,
  ],
  exports: [
    ClinicService,
    ClinicAuditService,
    ClinicOutboxService,
    ClinicScopeGuard,
    ClinicPermissionsGuard,
    MongooseModule,
  ],
})
export class ClinicModule {}
