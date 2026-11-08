import { createParamDecorator, ExecutionContext } from "@nestjs/common"
import type { DoctorDocument } from "../schemas/doctor.schema.js"

export const CurrentDoctor = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): DoctorDocument => {
    const request = ctx.switchToHttp().getRequest()
    return request.user || request.doctor
  },
)
