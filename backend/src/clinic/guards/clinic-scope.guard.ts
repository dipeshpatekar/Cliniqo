import {
  Injectable,
  CanActivate,
  ExecutionContext,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { Request } from 'express';
import {
  Clinic,
  type ClinicDocument,
  ClinicStatus,
} from '../schemas/clinic.schema.js';
import {
  ClinicMembership,
  type ClinicMembershipDocument,
  ClinicMembershipStatus,
  ClinicRole,
} from '../schemas/clinic-membership.schema.js';
import {
  ALLOW_SUSPENDED_CLINIC_KEY,
  type AllowSuspendedOptions,
} from '../decorators/roles.decorator.js';

@Injectable()
export class ClinicScopeGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @InjectModel(Clinic.name)
    private readonly clinicModel: Model<ClinicDocument>,
    @InjectModel(ClinicMembership.name)
    private readonly membershipModel: Model<ClinicMembershipDocument>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const user = (request as any).user || (request as any).doctor;

    if (!user || !user._id) {
      throw new ForbiddenException('User authentication context is missing.');
    }

    const rawRouteClinicId = request.params?.clinicId;
    const rawHeaderClinicId = request.headers['x-clinic-id'];

    const routeClinicId = Array.isArray(rawRouteClinicId)
      ? rawRouteClinicId[0]
      : rawRouteClinicId;
    const headerClinicId = Array.isArray(rawHeaderClinicId)
      ? rawHeaderClinicId[0]
      : rawHeaderClinicId;

    // 1. Conflict detection between route param and header
    if (
      routeClinicId &&
      headerClinicId &&
      routeClinicId.trim() !== headerClinicId.trim()
    ) {
      throw new BadRequestException(
        'Conflicting clinic context between route parameter and X-Clinic-ID header.',
      );
    }

    const targetClinicIdStr = (routeClinicId || headerClinicId)?.trim();
    if (!targetClinicIdStr) {
      throw new BadRequestException(
        'Clinic identifier is required in route parameter or X-Clinic-ID header.',
      );
    }

    // 2. Validate ObjectId format
    if (!Types.ObjectId.isValid(targetClinicIdStr)) {
      throw new BadRequestException('Invalid clinic identifier format.');
    }

    const clinicId = new Types.ObjectId(targetClinicIdStr);

    // 3. Find clinic
    const clinic = await this.clinicModel.findById(clinicId);
    if (!clinic) {
      throw new NotFoundException('Clinic not found.');
    }

    // 4. Find active membership for authenticated doctor
    const membership = await this.membershipModel.findOne({
      clinicId,
      doctorId: user._id,
      status: ClinicMembershipStatus.ACTIVE,
    });

    if (!membership) {
      throw new ForbiddenException(
        'You are not an active member of this clinic.',
      );
    }

    // 5. Evaluate clinic lifecycle status
    const allowSuspendedConfig =
      this.reflector.getAllAndOverride<AllowSuspendedOptions>(
        ALLOW_SUSPENDED_CLINIC_KEY,
        [context.getHandler(), context.getClass()],
      );

    if (clinic.status === ClinicStatus.SUSPENDED) {
      const allowedRoles = allowSuspendedConfig?.allowedRoles ?? [ClinicRole.OWNER];
      const isAllowed =
        allowSuspendedConfig &&
        allowedRoles.includes(membership.role) &&
        membership.status === ClinicMembershipStatus.ACTIVE;

      if (!isAllowed) {
        throw new ForbiddenException(
          'Clinic is suspended. Normal operations are restricted.',
        );
      }
    } else if (clinic.status === ClinicStatus.ARCHIVED) {
      const handlerName = context.getHandler().name;
      const isOwnerRead =
        allowSuspendedConfig &&
        membership.role === ClinicRole.OWNER &&
        (handlerName === 'getClinicProfile' || handlerName === 'listAuditLogs');

      if (!isOwnerRead) {
        throw new ForbiddenException(
          'Clinic has been archived and cannot be accessed.',
        );
      }
    }

    // 6. Bind validated context to request
    (request as any).clinic = clinic;
    (request as any).membership = membership;

    return true;
  }
}
