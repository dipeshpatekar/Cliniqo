import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { Doctor, DoctorSchema } from './schemas/doctor.schema.js';
import {
  RefreshSession,
  RefreshSessionSchema,
} from './schemas/refresh-session.schema.js';
import {
  PasswordResetToken,
  PasswordResetTokenSchema,
} from './schemas/password-reset.schema.js';
import { RateLimit, RateLimitSchema } from './schemas/rate-limit.schema.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';
import { MailService } from './mail.service.js';
import { RateLimiterService } from './rate-limiter.service.js';
import { AuthService } from './auth.service.js';
import { AuthController } from './auth.controller.js';

import { JwtAuthGuard } from './guards/jwt-auth.guard.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Doctor.name, schema: DoctorSchema },
      { name: RefreshSession.name, schema: RefreshSessionSchema },
      { name: PasswordResetToken.name, schema: PasswordResetTokenSchema },
      { name: RateLimit.name, schema: RateLimitSchema },
    ]),
    JwtModule.register({}),
  ],
  controllers: [AuthController],
  providers: [
    PasswordService,
    TokenService,
    MailService,
    RateLimiterService,
    AuthService,
    JwtAuthGuard,
  ],
  exports: [
    PasswordService,
    TokenService,
    MailService,
    AuthService,
    JwtAuthGuard,
    MongooseModule,
  ],
})
export class AuthModule {}
