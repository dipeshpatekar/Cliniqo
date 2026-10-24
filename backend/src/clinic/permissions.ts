import { ClinicRole } from './schemas/clinic-membership.schema.js';

export enum ClinicPermission {
  CLINIC_READ = 'clinic:read',
  CLINIC_UPDATE = 'clinic:update',
  CLINIC_TRANSFER_OWNERSHIP = 'clinic:transfer_ownership',
  CLINIC_SUSPEND = 'clinic:suspend',
  CLINIC_REACTIVATE = 'clinic:reactivate',
  CLINIC_ARCHIVE = 'clinic:archive',
  MEMBER_INVITE = 'member:invite',
  MEMBER_REVOKE = 'member:revoke',
  MEMBER_LIST = 'member:list',
}

export const ROLE_PERMISSIONS_MAP: Record<
  ClinicRole,
  ReadonlySet<ClinicPermission>
> = {
  [ClinicRole.OWNER]: new Set([
    ClinicPermission.CLINIC_READ,
    ClinicPermission.CLINIC_UPDATE,
    ClinicPermission.CLINIC_TRANSFER_OWNERSHIP,
    ClinicPermission.CLINIC_SUSPEND,
    ClinicPermission.CLINIC_REACTIVATE,
    ClinicPermission.CLINIC_ARCHIVE,
    ClinicPermission.MEMBER_INVITE,
    ClinicPermission.MEMBER_REVOKE,
    ClinicPermission.MEMBER_LIST,
  ]),
  [ClinicRole.DOCTOR]: new Set([
    ClinicPermission.CLINIC_READ,
    ClinicPermission.MEMBER_LIST,
  ]),
  [ClinicRole.STAFF]: new Set([ClinicPermission.CLINIC_READ]),
};
