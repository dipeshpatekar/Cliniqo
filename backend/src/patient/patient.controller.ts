import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Param,
  Body,
  Query,
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
import { RequireClinicPermissions } from '../clinic/decorators/roles.decorator.js';
import { ClinicPermission } from '../clinic/permissions.js';
import type { ClinicDocument } from '../clinic/schemas/clinic.schema.js';
import { PatientService } from './patient.service.js';
import { CreatePatientDto } from './dto/create-patient.dto.js';
import { UpdatePatientDto } from './dto/update-patient.dto.js';
import { QueryPatientsDto } from './dto/query-patients.dto.js';

@Controller('clinics/:clinicId/patients')
@UseGuards(JwtAuthGuard, ClinicScopeGuard, ClinicPermissionsGuard)
export class PatientController {
  constructor(private readonly patientService: PatientService) {}

  /**
   * Registers a new patient in the scoped clinic.
   * Atomic transaction: Monotonic sequence assignment + patient doc + audit log.
   */
  @Post()
  @RequireClinicPermissions(ClinicPermission.PATIENT_CREATE)
  @HttpCode(HttpStatus.CREATED)
  async createPatient(
    @CurrentClinic() clinic: ClinicDocument,
    @CurrentDoctor() doctor: DoctorDocument,
    @Body() dto: CreatePatientDto,
  ) {
    return this.patientService.createPatient(clinic._id, dto, doctor._id);
  }

  /**
   * Pre-flight duplicate mobile check for active patients in the clinic.
   * Placed before :patientId route to prevent route collision.
   */
  @Get('check-duplicate')
  @RequireClinicPermissions(ClinicPermission.PATIENT_READ)
  async checkDuplicatePhone(
    @CurrentClinic() clinic: ClinicDocument,
    @Query('phone') phone: string,
  ) {
    return this.patientService.checkDuplicatePhone(clinic._id, phone);
  }

  /**
   * Search and list patients in the clinic with filtering, sorting, and pagination.
   */
  @Get()
  @RequireClinicPermissions(ClinicPermission.PATIENT_READ)
  async searchPatients(
    @CurrentClinic() clinic: ClinicDocument,
    @Query() queryDto: QueryPatientsDto,
  ) {
    return this.patientService.searchPatients(clinic._id, queryDto);
  }

  /**
   * Retrieves single patient by human-readable patientId (e.g. 'P-00101') or ObjectId.
   */
  @Get(':patientId')
  @RequireClinicPermissions(ClinicPermission.PATIENT_READ)
  async getPatientById(
    @CurrentClinic() clinic: ClinicDocument,
    @Param('patientId') patientId: string,
  ) {
    return this.patientService.getPatientById(clinic._id, patientId);
  }

  /**
   * Updates patient demographics or medical notes with audit logging.
   */
  @Patch(':patientId')
  @RequireClinicPermissions(ClinicPermission.PATIENT_UPDATE)
  async updatePatient(
    @CurrentClinic() clinic: ClinicDocument,
    @CurrentDoctor() doctor: DoctorDocument,
    @Param('patientId') patientId: string,
    @Body() dto: UpdatePatientDto,
  ) {
    return this.patientService.updatePatient(
      clinic._id,
      patientId,
      dto,
      doctor._id,
    );
  }

  /**
   * Soft-archives a patient. Blocks hard deletion to protect clinical audit history.
   */
  @Delete(':patientId')
  @RequireClinicPermissions(ClinicPermission.PATIENT_ARCHIVE)
  async archivePatient(
    @CurrentClinic() clinic: ClinicDocument,
    @CurrentDoctor() doctor: DoctorDocument,
    @Param('patientId') patientId: string,
  ) {
    return this.patientService.archivePatient(
      clinic._id,
      patientId,
      doctor._id,
    );
  }
}
