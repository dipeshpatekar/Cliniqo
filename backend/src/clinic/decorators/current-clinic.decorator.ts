import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { ClinicDocument } from '../schemas/clinic.schema.js';

export const CurrentClinic = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ClinicDocument => {
    const request = ctx.switchToHttp().getRequest();
    return request.clinic;
  },
);
