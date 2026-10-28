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
import { FormularyService } from './formulary.service.js';
import { CreateFormularyItemDto } from './dto/create-formulary-item.dto.js';
import { UpdateFormularyItemDto } from './dto/update-formulary-item.dto.js';
import { QueryFormularyDto } from './dto/query-formulary.dto.js';

@Controller('clinics/:clinicId/formulary')
@UseGuards(JwtAuthGuard, ClinicScopeGuard, ClinicPermissionsGuard)
export class FormularyController {
  constructor(private readonly formularyService: FormularyService) {}

  @Post()
  @RequireClinicPermissions(ClinicPermission.FORMULARY_MANAGE)
  @HttpCode(HttpStatus.CREATED)
  async createItem(
    @CurrentClinic() clinic: ClinicDocument,
    @CurrentDoctor() doctor: DoctorDocument,
    @Body() dto: CreateFormularyItemDto,
  ) {
    return this.formularyService.createItem(clinic._id, doctor._id, dto);
  }

  @Get()
  @RequireClinicPermissions(ClinicPermission.FORMULARY_READ)
  async getItems(
    @CurrentClinic() clinic: ClinicDocument,
    @Query() query: QueryFormularyDto,
  ) {
    return this.formularyService.getItems(clinic._id, query);
  }

  @Get(':id')
  @RequireClinicPermissions(ClinicPermission.FORMULARY_READ)
  async getItemById(
    @CurrentClinic() clinic: ClinicDocument,
    @Param('id') id: string,
  ) {
    return this.formularyService.getItemById(clinic._id, id);
  }

  @Patch(':id')
  @RequireClinicPermissions(ClinicPermission.FORMULARY_MANAGE)
  async updateItem(
    @CurrentClinic() clinic: ClinicDocument,
    @Param('id') id: string,
    @Body() dto: UpdateFormularyItemDto,
  ) {
    return this.formularyService.updateItem(clinic._id, id, dto);
  }

  @Delete(':id')
  @RequireClinicPermissions(ClinicPermission.FORMULARY_MANAGE)
  async archiveItem(
    @CurrentClinic() clinic: ClinicDocument,
    @Param('id') id: string,
  ) {
    return this.formularyService.archiveItem(clinic._id, id);
  }

  @Post('seed-defaults')
  @RequireClinicPermissions(ClinicPermission.FORMULARY_MANAGE)
  async seedDefaults(
    @CurrentClinic() clinic: ClinicDocument,
    @CurrentDoctor() doctor: DoctorDocument,
  ) {
    const count = await this.formularyService.seedStandardFormulary(clinic._id, doctor._id);
    return { seededCount: count };
  }
}
