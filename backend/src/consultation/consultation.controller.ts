import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  Headers,
  UseGuards,
  HttpStatus,
  HttpCode,
} from "@nestjs/common"
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard.js"
import { CurrentDoctor } from "../auth/decorators/current-doctor.decorator.js"
import type { DoctorDocument } from "../auth/schemas/doctor.schema.js"
import { ClinicScopeGuard } from "../clinic/guards/clinic-scope.guard.js"
import { ClinicPermissionsGuard } from "../clinic/guards/clinic-permissions.guard.js"
import { CurrentClinic } from "../clinic/decorators/current-clinic.decorator.js"
import { CurrentMembership } from "../clinic/decorators/current-membership.decorator.js"
import { RequireClinicPermissions } from "../clinic/decorators/roles.decorator.js"
import { ClinicPermission } from "../clinic/permissions.js"
import type { ClinicDocument } from "../clinic/schemas/clinic.schema.js"
import type { ClinicMembershipDocument } from "../clinic/schemas/clinic-membership.schema.js"
import { ConsultationService } from "./consultation.service.js"
import { CreateConsultationDto } from "./dto/create-consultation.dto.js"
import { UpdateConsultationDto } from "./dto/update-consultation.dto.js"
import { FinalizeConsultationDto } from "./dto/finalize-consultation.dto.js"
import { AddAddendumDto } from "./dto/add-addendum.dto.js"
import { CancelConsultationDto } from "./dto/cancel-consultation.dto.js"
import { QueryConsultationsDto } from "./dto/query-consultations.dto.js"

@Controller("clinics/:clinicId")
@UseGuards(JwtAuthGuard, ClinicScopeGuard, ClinicPermissionsGuard)
export class ConsultationController {
  constructor(private readonly consultationService: ConsultationService) {}

  /**
   * Starts a new consultation draft for a patient.
   * Enforces at most one active draft per patient and persistent idempotency.
   */
  @Post("patients/:patientId/consultations")
  @RequireClinicPermissions(ClinicPermission.CONSULTATION_CREATE)
  @HttpCode(HttpStatus.CREATED)
  async createConsultation(
    @CurrentClinic() clinic: ClinicDocument,
    @CurrentDoctor() doctor: DoctorDocument,
    @Param("patientId") patientId: string,
    @Body() dto: CreateConsultationDto,
    @Headers("idempotency-key") headerKey1?: string,
    @Headers("x-idempotency-key") headerKey2?: string,
  ) {
    const idempotencyKey = headerKey1 || headerKey2
    return this.consultationService.createConsultation(
      clinic._id,
      patientId,
      dto,
      doctor._id,
      idempotencyKey,
    )
  }

  /**
   * Retrieves paginated consultations for a patient.
   */
  @Get("patients/:patientId/consultations")
  @RequireClinicPermissions(ClinicPermission.CONSULTATION_READ)
  async getPatientConsultations(
    @CurrentClinic() clinic: ClinicDocument,
    @Param("patientId") patientId: string,
    @Query() query: QueryConsultationsDto,
  ) {
    return this.consultationService.getPatientConsultations(
      clinic._id,
      patientId,
      query,
    )
  }

  /**
   * Retrieves recent clinic consultations for the dashboard feed.
   */
  @Get("consultations/recent")
  @RequireClinicPermissions(ClinicPermission.CONSULTATION_READ)
  async getRecentConsultations(
    @CurrentClinic() clinic: ClinicDocument,
    @Query("limit") limit?: number,
  ) {
    return this.consultationService.getRecentConsultations(
      clinic._id,
      limit ? Number(limit) : 10,
    )
  }

  /**
   * Retrieves a single consultation by ID with populated addenda.
   */
  @Get("consultations/:consultationId")
  @RequireClinicPermissions(ClinicPermission.CONSULTATION_READ)
  async getConsultationById(
    @CurrentClinic() clinic: ClinicDocument,
    @Param("consultationId") consultationId: string,
  ) {
    return this.consultationService.getConsultationById(
      clinic._id,
      consultationId,
    )
  }

  /**
   * Updates an in-progress draft consultation with mandatory optimistic version locking.
   */
  @Patch("consultations/:consultationId")
  @RequireClinicPermissions(ClinicPermission.CONSULTATION_UPDATE)
  async updateConsultation(
    @CurrentClinic() clinic: ClinicDocument,
    @CurrentDoctor() doctor: DoctorDocument,
    @Param("consultationId") consultationId: string,
    @Body() dto: UpdateConsultationDto,
  ) {
    return this.consultationService.updateConsultation(
      clinic._id,
      consultationId,
      dto,
      doctor._id,
    )
  }

  /**
   * Finalizes a consultation, permanently locking clinical records and updating Patient.lastVisitAt.
   */
  @Post("consultations/:consultationId/finalize")
  @RequireClinicPermissions(ClinicPermission.CONSULTATION_FINALIZE)
  @HttpCode(HttpStatus.OK)
  async finalizeConsultation(
    @CurrentClinic() clinic: ClinicDocument,
    @CurrentDoctor() doctor: DoctorDocument,
    @Param("consultationId") consultationId: string,
    @Body() dto: FinalizeConsultationDto,
    @Headers("idempotency-key") headerKey1?: string,
    @Headers("x-idempotency-key") headerKey2?: string,
  ) {
    const idempotencyKey = headerKey1 || headerKey2
    return this.consultationService.finalizeConsultation(
      clinic._id,
      consultationId,
      dto,
      doctor._id,
      idempotencyKey,
    )
  }

  /**
   * Appends an immutable addendum to a finalized consultation.
   */
  @Post("consultations/:consultationId/addenda")
  @RequireClinicPermissions(ClinicPermission.CONSULTATION_UPDATE)
  @HttpCode(HttpStatus.CREATED)
  async addAddendum(
    @CurrentClinic() clinic: ClinicDocument,
    @CurrentDoctor() doctor: DoctorDocument,
    @Param("consultationId") consultationId: string,
    @Body() dto: AddAddendumDto,
  ) {
    return this.consultationService.addAddendum(
      clinic._id,
      consultationId,
      dto,
      doctor._id,
    )
  }

  /**
   * Cancels a draft consultation. Enforces doctor ownership check or clinic owner override.
   */
  @Delete("consultations/:consultationId")
  @RequireClinicPermissions(ClinicPermission.CONSULTATION_CANCEL)
  async cancelDraftConsultation(
    @CurrentClinic() clinic: ClinicDocument,
    @CurrentDoctor() doctor: DoctorDocument,
    @CurrentMembership() membership: ClinicMembershipDocument,
    @Param("consultationId") consultationId: string,
    @Body() dto: CancelConsultationDto,
  ) {
    return this.consultationService.cancelDraftConsultation(
      clinic._id,
      consultationId,
      doctor._id,
      membership.role,
      dto,
    )
  }
}
