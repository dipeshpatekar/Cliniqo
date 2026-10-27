import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Query,
  Headers,
  UseGuards,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CurrentDoctor } from '../auth/decorators/current-doctor.decorator.js';
import type { DoctorDocument } from '../auth/schemas/doctor.schema.js';
import { ClinicScopeGuard } from '../clinic/guards/clinic-scope.guard.js';
import { ClinicPermissionsGuard } from '../clinic/guards/clinic-permissions.guard.js';
import { CurrentClinic } from '../clinic/decorators/current-clinic.decorator.js';
import { CurrentMembership } from '../clinic/decorators/current-membership.decorator.js';
import { RequireClinicPermissions } from '../clinic/decorators/roles.decorator.js';
import { ClinicPermission } from '../clinic/permissions.js';
import type { ClinicDocument } from '../clinic/schemas/clinic.schema.js';
import type { ClinicMembershipDocument } from '../clinic/schemas/clinic-membership.schema.js';
import { PrescriptionService } from './prescription.service.js';
import { CreatePrescriptionDto } from './dto/create-prescription.dto.js';
import { RevisePrescriptionDto } from './dto/revise-prescription.dto.js';
import { DiscontinuePrescriptionDto } from './dto/discontinue-prescription.dto.js';
import { CancelPrescriptionDto } from './dto/cancel-prescription.dto.js';
import { QueryPrescriptionsDto } from './dto/query-prescriptions.dto.js';

@Controller('clinics/:clinicId')
@UseGuards(JwtAuthGuard, ClinicScopeGuard, ClinicPermissionsGuard)
export class PrescriptionController {
  constructor(private readonly prescriptionService: PrescriptionService) {}

  /**
   * Issues a new prescription or replacement prescription against a finalized consultation.
   */
  @Post('consultations/:consultationId/prescriptions')
  @RequireClinicPermissions(ClinicPermission.PRESCRIPTION_CREATE)
  @HttpCode(HttpStatus.CREATED)
  async createPrescription(
    @CurrentClinic() clinic: ClinicDocument,
    @CurrentDoctor() doctor: DoctorDocument,
    @Param('consultationId') consultationId: string,
    @Body() dto: CreatePrescriptionDto,
    @Headers('idempotency-key') headerKey1?: string,
    @Headers('x-idempotency-key') headerKey2?: string,
  ) {
    const idempotencyKey = headerKey1 || headerKey2;
    return this.prescriptionService.createPrescription(
      clinic._id,
      consultationId,
      dto,
      doctor._id,
      idempotencyKey,
    );
  }

  /**
   * Retrieves the active prescription for a consultation.
   */
  @Get('consultations/:consultationId/prescription')
  @RequireClinicPermissions(ClinicPermission.PRESCRIPTION_READ)
  async getConsultationPrescription(
    @CurrentClinic() clinic: ClinicDocument,
    @Param('consultationId') consultationId: string,
  ) {
    return this.prescriptionService.getConsultationPrescription(
      clinic._id,
      consultationId,
    );
  }

  /**
   * Lists paginated prescriptions for clinic or patient.
   */
  @Get('prescriptions')
  @RequireClinicPermissions(ClinicPermission.PRESCRIPTION_READ)
  async queryPrescriptions(
    @CurrentClinic() clinic: ClinicDocument,
    @Query() query: QueryPrescriptionsDto,
  ) {
    return this.prescriptionService.queryPrescriptions(clinic._id, query);
  }

  /**
   * Retrieves a single prescription by ID (latest revision by default, or specific revision).
   */
  @Get('prescriptions/:prescriptionId')
  @RequireClinicPermissions(ClinicPermission.PRESCRIPTION_READ)
  async getPrescriptionById(
    @CurrentClinic() clinic: ClinicDocument,
    @Param('prescriptionId') prescriptionId: string,
    @Query('revision') revision?: number,
  ) {
    return this.prescriptionService.getPrescriptionById(
      clinic._id,
      prescriptionId,
      revision ? Number(revision) : undefined,
    );
  }

  /**
   * Lists all historical revisions for a prescription.
   */
  @Get('prescriptions/:prescriptionId/revisions')
  @RequireClinicPermissions(ClinicPermission.PRESCRIPTION_READ)
  async getPrescriptionRevisions(
    @CurrentClinic() clinic: ClinicDocument,
    @Param('prescriptionId') prescriptionId: string,
  ) {
    return this.prescriptionService.getPrescriptionRevisions(
      clinic._id,
      prescriptionId,
    );
  }

  /**
   * Retrieves a specific revision for a prescription.
   */
  @Get('prescriptions/:prescriptionId/revisions/:revisionNumber')
  @RequireClinicPermissions(ClinicPermission.PRESCRIPTION_READ)
  async getPrescriptionRevisionByNumber(
    @CurrentClinic() clinic: ClinicDocument,
    @Param('prescriptionId') prescriptionId: string,
    @Param('revisionNumber') revisionNumber: number,
  ) {
    return this.prescriptionService.getPrescriptionById(
      clinic._id,
      prescriptionId,
      Number(revisionNumber),
    );
  }

  /**
   * Appends an immutable revision to an active prescription with mandatory optimistic locking.
   */
  @Post('prescriptions/:prescriptionId/revisions')
  @RequireClinicPermissions(ClinicPermission.PRESCRIPTION_UPDATE)
  @HttpCode(HttpStatus.CREATED)
  async revisePrescription(
    @CurrentClinic() clinic: ClinicDocument,
    @CurrentDoctor() doctor: DoctorDocument,
    @Param('prescriptionId') prescriptionId: string,
    @Body() dto: RevisePrescriptionDto,
    @Headers('idempotency-key') headerKey1?: string,
    @Headers('x-idempotency-key') headerKey2?: string,
  ) {
    const idempotencyKey = headerKey1 || headerKey2;
    return this.prescriptionService.revisePrescription(
      clinic._id,
      prescriptionId,
      dto,
      doctor._id,
      idempotencyKey,
    );
  }

  /**
   * Discontinues an active prescription (treatment course halted).
   */
  @Post('prescriptions/:prescriptionId/discontinue')
  @RequireClinicPermissions(ClinicPermission.PRESCRIPTION_UPDATE)
  @HttpCode(HttpStatus.OK)
  async discontinuePrescription(
    @CurrentClinic() clinic: ClinicDocument,
    @CurrentDoctor() doctor: DoctorDocument,
    @Param('prescriptionId') prescriptionId: string,
    @Body() dto: DiscontinuePrescriptionDto,
    @Headers('idempotency-key') headerKey1?: string,
    @Headers('x-idempotency-key') headerKey2?: string,
  ) {
    const idempotencyKey = headerKey1 || headerKey2;
    return this.prescriptionService.discontinuePrescription(
      clinic._id,
      prescriptionId,
      dto,
      doctor._id,
      idempotencyKey,
    );
  }

  /**
   * Cancels a prescription.
   * Authorized strictly for the issuing doctor or a clinic OWNER.
   */
  @Post('prescriptions/:prescriptionId/cancel')
  @RequireClinicPermissions(ClinicPermission.PRESCRIPTION_CANCEL)
  @HttpCode(HttpStatus.OK)
  async cancelPrescription(
    @CurrentClinic() clinic: ClinicDocument,
    @CurrentDoctor() doctor: DoctorDocument,
    @CurrentMembership() membership: ClinicMembershipDocument,
    @Param('prescriptionId') prescriptionId: string,
    @Body() dto: CancelPrescriptionDto,
  ) {
    return this.prescriptionService.cancelPrescription(
      clinic._id,
      prescriptionId,
      doctor._id,
      membership.role,
      dto,
    );
  }
}
