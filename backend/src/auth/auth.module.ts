import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Doctor, DoctorSchema } from './schemas/doctor.schema.js';
import { PasswordService } from './password.service.js';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Doctor.name, schema: DoctorSchema }]),
  ],
  providers: [PasswordService],
  exports: [PasswordService, MongooseModule],
})
export class AuthModule {}
