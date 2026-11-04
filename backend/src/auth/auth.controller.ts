import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  HttpCode,
  HttpStatus,
  Req,
  UseGuards,
} from "@nestjs/common"
import type { Request } from "express"
import { AuthService } from "./auth.service.js"
import { TokenService } from "./token.service.js"
import { JwtAuthGuard } from "./guards/jwt-auth.guard.js"
import { CurrentDoctor } from "./decorators/current-doctor.decorator.js"
import type { DoctorDocument } from "./schemas/doctor.schema.js"
import {
  LoginDto,
  RegisterDto,
  UpdateDoctorProfileDto,
  RefreshTokenDto,
  ForgotPasswordDto,
  ResetPasswordDto,
} from "./dto/auth.dto.js"

@Controller("auth")
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly tokenService: TokenService,
  ) {}

  @Get("public-key")
  @HttpCode(HttpStatus.OK)
  async getPublicKey() {
    return this.tokenService.getPublicKeyInfo()
  }

  @Post("register")
  @HttpCode(HttpStatus.CREATED)
  async register(@Body() dto: RegisterDto, @Req() req: Request) {
    const meta = {
      ipAddress: req.ip || req.socket?.remoteAddress,
      userAgent: req.headers["user-agent"],
    }
    return this.authService.register(dto, meta)
  }

  @Get("profile")
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getProfile(@CurrentDoctor() doctor: DoctorDocument) {
    return this.authService.getProfile(doctor._id.toString())
  }

  @Patch("profile")
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async updateProfile(
    @CurrentDoctor() doctor: DoctorDocument,
    @Body() dto: UpdateDoctorProfileDto,
  ) {
    return this.authService.updateProfile(doctor._id.toString(), dto)
  }

  @Post("login")
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto, @Req() req: Request) {
    const meta = {
      ipAddress: req.ip || req.socket?.remoteAddress,
      userAgent: req.headers["user-agent"],
    }
    return this.authService.login(dto, meta)
  }

  @Post("refresh")
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() dto: RefreshTokenDto, @Req() req: Request) {
    const meta = {
      ipAddress: req.ip || req.socket?.remoteAddress,
      userAgent: req.headers["user-agent"],
    }
    return this.authService.refreshToken(dto, meta)
  }

  @Post("logout")
  @HttpCode(HttpStatus.OK)
  async logout(@Body() dto: RefreshTokenDto) {
    return this.authService.logout(dto)
  }

  @Post("forgot-password")
  @HttpCode(HttpStatus.OK)
  async forgotPassword(@Body() dto: ForgotPasswordDto, @Req() req: Request) {
    const meta = {
      ipAddress: req.ip || req.socket?.remoteAddress,
    }
    return this.authService.forgotPassword(dto, meta)
  }

  @Post("reset-password")
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Body() dto: ResetPasswordDto, @Req() req: Request) {
    const meta = {
      ipAddress: req.ip || req.socket?.remoteAddress,
    }
    return this.authService.resetPassword(dto, meta)
  }
}
