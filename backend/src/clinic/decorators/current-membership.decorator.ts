import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { ClinicMembershipDocument } from '../schemas/clinic-membership.schema.js';

export const CurrentMembership = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ClinicMembershipDocument => {
    const request = ctx.switchToHttp().getRequest();
    return request.membership;
  },
);
