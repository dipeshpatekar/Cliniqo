import {
  Controller,
  Post,
  Get,
  Patch,
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
import { RequireClinicPermissions } from '../clinic/decorators/roles.decorator.js';
import { ClinicPermission } from '../clinic/permissions.js';
import type { ClinicDocument } from '../clinic/schemas/clinic.schema.js';
import { BillingService } from './billing.service.js';
import { CreateInvoiceDto } from './dto/create-invoice.dto.js';
import { UpdateInvoiceDto } from './dto/update-invoice.dto.js';
import { QueryInvoicesDto } from './dto/query-invoices.dto.js';

@Controller('clinics/:clinicId/billing')
@UseGuards(JwtAuthGuard, ClinicScopeGuard, ClinicPermissionsGuard)
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @Post()
  @RequireClinicPermissions(ClinicPermission.BILLING_CREATE)
  @HttpCode(HttpStatus.CREATED)
  async createInvoice(
    @CurrentClinic() clinic: ClinicDocument,
    @CurrentDoctor() doctor: DoctorDocument,
    @Body() dto: CreateInvoiceDto,
    @Headers('idempotency-key') headerKey1?: string,
    @Headers('x-idempotency-key') headerKey2?: string,
  ) {
    const idempotencyKey = headerKey1 || headerKey2;
    return this.billingService.createInvoice(
      clinic._id,
      doctor._id,
      dto,
      idempotencyKey,
    );
  }

  @Get()
  @RequireClinicPermissions(ClinicPermission.BILLING_READ)
  async getInvoices(
    @CurrentClinic() clinic: ClinicDocument,
    @Query() query: QueryInvoicesDto,
  ) {
    return this.billingService.getInvoices(clinic._id, query);
  }

  @Get(':id')
  @RequireClinicPermissions(ClinicPermission.BILLING_READ)
  async getInvoiceById(
    @CurrentClinic() clinic: ClinicDocument,
    @Param('id') id: string,
  ) {
    return this.billingService.getInvoiceById(clinic._id, id);
  }

  @Patch(':id')
  @RequireClinicPermissions(ClinicPermission.BILLING_UPDATE)
  async updateInvoiceDraft(
    @CurrentClinic() clinic: ClinicDocument,
    @Param('id') id: string,
    @Body() dto: UpdateInvoiceDto,
  ) {
    return this.billingService.updateInvoiceDraft(clinic._id, id, dto);
  }

  @Post(':id/finalize')
  @RequireClinicPermissions(ClinicPermission.BILLING_FINALIZE)
  async finalizeInvoice(
    @CurrentClinic() clinic: ClinicDocument,
    @CurrentDoctor() doctor: DoctorDocument,
    @Param('id') id: string,
  ) {
    return this.billingService.finalizeInvoice(clinic._id, doctor._id, id);
  }

  @Post(':id/cancel')
  @RequireClinicPermissions(ClinicPermission.BILLING_CANCEL)
  async cancelInvoice(
    @CurrentClinic() clinic: ClinicDocument,
    @CurrentDoctor() doctor: DoctorDocument,
    @Param('id') id: string,
    @Body('reason') reason: string,
  ) {
    return this.billingService.cancelInvoice(clinic._id, doctor._id, id, reason);
  }
}
