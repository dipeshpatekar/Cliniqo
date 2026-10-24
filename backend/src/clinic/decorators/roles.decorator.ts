import { SetMetadata } from '@nestjs/common';
import { ClinicPermission } from '../permissions.js';
import { ClinicRole } from '../schemas/clinic-membership.schema.js';

export const CLINIC_PERMISSIONS_KEY = 'clinic_permissions';
export const RequireClinicPermissions = (
  ...permissions: ClinicPermission[]
) => SetMetadata(CLINIC_PERMISSIONS_KEY, permissions);

export const ALLOW_SUSPENDED_CLINIC_KEY = 'allow_suspended_clinic';
export interface AllowSuspendedOptions {
  allowedRoles?: ClinicRole[];
}
export const AllowSuspendedClinic = (
  options: AllowSuspendedOptions = { allowedRoles: [ClinicRole.OWNER] },
) => SetMetadata(ALLOW_SUSPENDED_CLINIC_KEY, options);
