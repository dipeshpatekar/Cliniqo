import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from "@nestjs/common"
import { InjectModel } from "@nestjs/mongoose"
import { Model, Types } from "mongoose"
import type { Request } from "express"
import { TokenService } from "../token.service.js"
import { Doctor, type DoctorDocument } from "../schemas/doctor.schema.js"
import { DoctorStatus } from "../auth.constants.js"

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly tokenService: TokenService,
    @InjectModel(Doctor.name)
    private readonly doctorModel: Model<DoctorDocument>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>()
    const authHeader = request.headers.authorization

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new UnauthorizedException(
        "Missing or invalid authorization header.",
      )
    }

    const token = authHeader.substring(7).trim()
    if (!token) {
      throw new UnauthorizedException("Missing bearer token.")
    }

    const payload = await this.tokenService.verifyAccessToken(token)

    if (!Types.ObjectId.isValid(payload.sub)) {
      throw new UnauthorizedException(
        "Invalid doctor identifier in token payload.",
      )
    }

    const doctor = await this.doctorModel.findById(payload.sub)
    if (!doctor || doctor.status !== DoctorStatus.ACTIVE) {
      throw new UnauthorizedException(
        "Account is not active or has been disabled.",
      )
    }
    ;(request as any).user = doctor
    ;(request as any).doctor = doctor

    return true
  }
}
