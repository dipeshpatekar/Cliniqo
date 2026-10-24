import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { CLINIC_PERMISSIONS_KEY } from '../decorators/roles.decorator.js';
import {
  ClinicPermission,
  ROLE_PERMISSIONS_MAP,
} from '../permissions.js';
import type { ClinicMembershipDocument } from '../schemas/clinic-membership.schema.js';

@Injectable()
export class ClinicPermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredPermissions = this.reflector.getAllAndOverride<
      ClinicPermission[]
    >(CLINIC_PERMISSIONS_KEY, [context.getHandler(), context.getClass()]);

    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const membership: ClinicMembershipDocument | undefined = (request as any)
      .membership;

    if (!membership || !membership.role) {
      throw new ForbiddenException('Missing clinic membership context.');
    }

    const rolePermissions = ROLE_PERMISSIONS_MAP[membership.role];
    if (!rolePermissions) {
      throw new ForbiddenException('Unknown or unmapped clinic role.');
    }

    const hasAllPermissions = requiredPermissions.every((perm) =>
      rolePermissions.has(perm),
    );

    if (!hasAllPermissions) {
      throw new ForbiddenException(
        'Insufficient clinic permissions for this operation.',
      );
    }

    return true;
  }
}
