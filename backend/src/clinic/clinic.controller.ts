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
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CurrentDoctor } from '../auth/decorators/current-doctor.decorator.js';
import type { DoctorDocument } from '../auth/schemas/doctor.schema.js';
import { ClinicScopeGuard } from './guards/clinic-scope.guard.js';
import { ClinicPermissionsGuard } from './guards/clinic-permissions.guard.js';
import { CurrentClinic } from './decorators/current-clinic.decorator.js';
import { CurrentMembership } from './decorators/current-membership.decorator.js';
import {
  RequireClinicPermissions,
  AllowSuspendedClinic,
} from './decorators/roles.decorator.js';
import { ClinicPermission } from './permissions.js';
import {
  ClinicRole,
  type ClinicMembershipDocument,
} from './schemas/clinic-membership.schema.js';
import type { ClinicDocument } from './schemas/clinic.schema.js';
import { ClinicService } from './clinic.service.js';
import { ClinicAuditService } from './clinic-audit.service.js';
import { CreateClinicDto } from './dto/create-clinic.dto.js';
import { UpdateClinicDto } from './dto/update-clinic.dto.js';
import { InviteMemberDto } from './dto/invite-member.dto.js';
import { TransferOwnershipDto } from './dto/transfer-ownership.dto.js';
import { ClinicLifecycleDto } from './dto/clinic-lifecycle.dto.js';

@Controller('clinics')
export class ClinicController {
  constructor(
    private readonly clinicService: ClinicService,
    private readonly auditService: ClinicAuditService,
  ) {}

  /**
   * Creates a new clinic and assigns the authenticated doctor as initial OWNER.
   */
  @Post()
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async createClinic(
    @CurrentDoctor() doctor: DoctorDocument,
    @Body() dto: CreateClinicDto,
  ) {
    return this.clinicService.createClinicWithMembership(doctor, dto);
  }

  /**
   * Lists active clinics for the authenticated doctor.
   */
  @Get('my-clinics')
  @UseGuards(JwtAuthGuard)
  async listMyClinics(@CurrentDoctor() doctor: DoctorDocument) {
    return this.clinicService.listDoctorClinics(doctor._id);
  }

  /**
   * Lists pending invitations addressed to the authenticated doctor's registered email.
   * Zero raw tokens or token hashes are exposed.
   */
  @Get('invitations')
  @UseGuards(JwtAuthGuard)
  async listMyInvitations(@CurrentDoctor() doctor: DoctorDocument) {
    return this.clinicService.listDoctorInvitations(doctor.email);
  }

  /**
   * Accepts an invitation token atomically.
   */
  @Post('invitations/:token/accept')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async acceptInvitation(
    @Param('token') token: string,
    @CurrentDoctor() doctor: DoctorDocument,
  ) {
    return this.clinicService.acceptInvitation(token, doctor);
  }

  /**
   * Declines an invitation token atomically.
   */
  @Post('invitations/:token/decline')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async declineInvitation(
    @Param('token') token: string,
    @CurrentDoctor() doctor: DoctorDocument,
  ) {
    return this.clinicService.declineInvitation(token, doctor);
  }

  /**
   * Retrieves clinic profile for a validated clinic context.
   * Suspended clinics can be read by OWNER.
   */
  @Get(':clinicId')
  @UseGuards(JwtAuthGuard, ClinicScopeGuard, ClinicPermissionsGuard)
  @AllowSuspendedClinic({ allowedRoles: [ClinicRole.OWNER] })
  @RequireClinicPermissions(ClinicPermission.CLINIC_READ)
  async getClinicProfile(@CurrentClinic() clinic: ClinicDocument) {
    return clinic;
  }

  /**
   * Updates clinic profile details.
   */
  @Patch(':clinicId')
  @UseGuards(JwtAuthGuard, ClinicScopeGuard, ClinicPermissionsGuard)
  @RequireClinicPermissions(ClinicPermission.CLINIC_UPDATE)
  async updateClinic(
    @CurrentClinic() clinic: ClinicDocument,
    @CurrentDoctor() doctor: DoctorDocument,
    @Body() dto: UpdateClinicDto,
  ) {
    return this.clinicService.updateClinic(clinic._id, dto, doctor._id);
  }

  /**
   * Suspends an active clinic (Owner only).
   */
  @Post(':clinicId/suspend')
  @UseGuards(JwtAuthGuard, ClinicScopeGuard, ClinicPermissionsGuard)
  @RequireClinicPermissions(ClinicPermission.CLINIC_SUSPEND)
  @HttpCode(HttpStatus.OK)
  async suspendClinic(
    @CurrentClinic() clinic: ClinicDocument,
    @CurrentDoctor() doctor: DoctorDocument,
    @Body() dto: ClinicLifecycleDto,
  ) {
    return this.clinicService.suspendClinic(clinic._id, dto.reason, doctor._id);
  }

  /**
   * Reactivates a suspended clinic (Owner only).
   */
  @Post(':clinicId/reactivate')
  @UseGuards(JwtAuthGuard, ClinicScopeGuard, ClinicPermissionsGuard)
  @AllowSuspendedClinic({ allowedRoles: [ClinicRole.OWNER] })
  @RequireClinicPermissions(ClinicPermission.CLINIC_REACTIVATE)
  @HttpCode(HttpStatus.OK)
  async reactivateClinic(
    @CurrentClinic() clinic: ClinicDocument,
    @CurrentDoctor() doctor: DoctorDocument,
    @Body() dto: ClinicLifecycleDto,
  ) {
    return this.clinicService.reactivateClinic(
      clinic._id,
      dto.reason,
      doctor._id,
    );
  }

  /**
   * Permanently archives a clinic (Owner only, terminal state).
   */
  @Post(':clinicId/archive')
  @UseGuards(JwtAuthGuard, ClinicScopeGuard, ClinicPermissionsGuard)
  @AllowSuspendedClinic({ allowedRoles: [ClinicRole.OWNER] })
  @RequireClinicPermissions(ClinicPermission.CLINIC_ARCHIVE)
  @HttpCode(HttpStatus.OK)
  async archiveClinic(
    @CurrentClinic() clinic: ClinicDocument,
    @CurrentDoctor() doctor: DoctorDocument,
    @Body() dto: ClinicLifecycleDto,
  ) {
    return this.clinicService.archiveClinic(clinic._id, dto.reason, doctor._id);
  }

  /**
   * Atomically transfers clinic ownership to an active member.
   */
  @Post(':clinicId/transfer-ownership')
  @UseGuards(JwtAuthGuard, ClinicScopeGuard, ClinicPermissionsGuard)
  @RequireClinicPermissions(ClinicPermission.CLINIC_TRANSFER_OWNERSHIP)
  @HttpCode(HttpStatus.OK)
  async transferOwnership(
    @CurrentClinic() clinic: ClinicDocument,
    @CurrentDoctor() doctor: DoctorDocument,
    @Body() dto: TransferOwnershipDto,
  ) {
    return this.clinicService.transferOwnership(
      clinic._id,
      doctor._id,
      new Types.ObjectId(dto.newOwnerDoctorId),
    );
  }

  /**
   * Lists active members of a clinic.
   */
  @Get(':clinicId/members')
  @UseGuards(JwtAuthGuard, ClinicScopeGuard, ClinicPermissionsGuard)
  @RequireClinicPermissions(ClinicPermission.MEMBER_LIST)
  async listMembers(@CurrentClinic() clinic: ClinicDocument) {
    return this.clinicService.listMembers(clinic._id);
  }

  /**
   * Invites a new doctor or staff member to the clinic.
   */
  @Post(':clinicId/invitations')
  @UseGuards(JwtAuthGuard, ClinicScopeGuard, ClinicPermissionsGuard)
  @RequireClinicPermissions(ClinicPermission.MEMBER_INVITE)
  @HttpCode(HttpStatus.CREATED)
  async inviteMember(
    @CurrentClinic() clinic: ClinicDocument,
    @CurrentDoctor() doctor: DoctorDocument,
    @Body() dto: InviteMemberDto,
  ) {
    return this.clinicService.inviteMember(clinic._id, doctor, dto);
  }

  /**
   * Cancels a pending invitation.
   */
  @Delete(':clinicId/invitations/:invId')
  @UseGuards(JwtAuthGuard, ClinicScopeGuard, ClinicPermissionsGuard)
  @RequireClinicPermissions(ClinicPermission.MEMBER_REVOKE)
  @HttpCode(HttpStatus.OK)
  async cancelInvitation(
    @CurrentClinic() clinic: ClinicDocument,
    @CurrentDoctor() doctor: DoctorDocument,
    @Param('invId') invId: string,
  ) {
    if (!Types.ObjectId.isValid(invId)) {
      throw new BadRequestException('Invalid invitation identifier format.');
    }
    return this.clinicService.cancelInvitation(
      clinic._id,
      new Types.ObjectId(invId),
      doctor._id,
    );
  }

  /**
   * Revokes an active member's membership (Blocks OWNER revocation).
   */
  @Delete(':clinicId/members/:targetDoctorId')
  @UseGuards(JwtAuthGuard, ClinicScopeGuard, ClinicPermissionsGuard)
  @RequireClinicPermissions(ClinicPermission.MEMBER_REVOKE)
  @HttpCode(HttpStatus.OK)
  async revokeMember(
    @CurrentClinic() clinic: ClinicDocument,
    @CurrentDoctor() doctor: DoctorDocument,
    @Param('targetDoctorId') targetDoctorId: string,
  ) {
    if (!Types.ObjectId.isValid(targetDoctorId)) {
      throw new BadRequestException('Invalid target doctor identifier format.');
    }
    return this.clinicService.revokeMember(
      clinic._id,
      new Types.ObjectId(targetDoctorId),
      doctor._id,
    );
  }

  /**
   * Retrieves immutable audit logs for the clinic (Restricted to OWNER only).
   */
  @Get(':clinicId/audit-logs')
  @UseGuards(JwtAuthGuard, ClinicScopeGuard, ClinicPermissionsGuard)
  @AllowSuspendedClinic({ allowedRoles: [ClinicRole.OWNER] })
  @RequireClinicPermissions(ClinicPermission.CLINIC_READ)
  async listAuditLogs(
    @CurrentClinic() clinic: ClinicDocument,
    @CurrentMembership() membership: ClinicMembershipDocument,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    if (membership.role !== ClinicRole.OWNER) {
      throw new ForbiddenException(
        'Audit logs can only be viewed by the clinic owner.',
      );
    }
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 50;
    return this.auditService.listClinicAuditLogs(clinic._id, pageNum, limitNum);
  }
}
