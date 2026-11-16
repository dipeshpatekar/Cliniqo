import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from "class-validator"
import { validatePasswordPolicy } from "./doctor.dto.js"

export class RegisterDto {
  @IsString({ message: "Full name must be a string." })
  @IsNotEmpty({ message: "Full name cannot be empty." })
  @MinLength(3, { message: "Full name must be at least 3 characters long." })
  @MaxLength(120, { message: "Full name cannot exceed 120 characters." })
  fullName: string

  @IsEmail({}, { message: "Invalid email address format." })
  @IsString({ message: "Email must be a string." })
  @IsNotEmpty({ message: "Email cannot be empty." })
  @MaxLength(254, { message: "Email cannot exceed 254 characters." })
  email: string

  @IsString({ message: "Password must be a string." })
  @IsNotEmpty({ message: "Password cannot be empty." })
  @MinLength(8, { message: "Password must be at least 8 characters long." })
  @MaxLength(128, { message: "Password cannot exceed 128 characters." })
  password: string

  @IsOptional()
  @IsString({ message: "Phone must be a string." })
  phone?: string

  @IsOptional()
  @IsString({ message: "Qualification must be a string." })
  qualification?: string

  @IsOptional()
  @IsString({ message: "Qualifications must be a string." })
  qualifications?: string

  @IsOptional()
  @IsString({ message: "Registration number must be a string." })
  registrationNumber?: string

  @IsOptional()
  @IsString({ message: "License number must be a string." })
  licenseNumber?: string

  @IsOptional()
  @IsString({ message: "Gender must be a string." })
  gender?: string

  @IsOptional()
  @IsString({ message: "Session type must be a string." })
  sessionType?: "WEB_STANDARD" | "DESKTOP_PERSISTENT"

  @IsOptional()
  @IsString({ message: "Device ID must be a string." })
  deviceId?: string
}

export class UpdateDoctorProfileDto {
  @IsOptional()
  @IsString({ message: "Full name must be a string." })
  @MinLength(3, { message: "Full name must be at least 3 characters long." })
  @MaxLength(120, { message: "Full name cannot exceed 120 characters." })
  fullName?: string

  @IsOptional()
  @IsString({ message: "Phone must be a string." })
  phone?: string

  @IsOptional()
  @IsString({ message: "Qualification must be a string." })
  qualification?: string

  @IsOptional()
  @IsString({ message: "Qualifications must be a string." })
  qualifications?: string

  @IsOptional()
  @IsString({ message: "Registration number must be a string." })
  registrationNumber?: string

  @IsOptional()
  @IsString({ message: "License number must be a string." })
  licenseNumber?: string

  @IsOptional()
  @IsString({ message: "Gender must be a string." })
  gender?: string

  @IsOptional()
  @IsString({ message: "Session type must be a string." })
  sessionType?: "WEB_STANDARD" | "DESKTOP_PERSISTENT"

  @IsOptional()
  @IsString({ message: "Device ID must be a string." })
  deviceId?: string
}

/**
 * Custom class-validator decorator enforcing Cliniqo's password complexity policy:
 * - Minimum 10, maximum 128 characters
 * - Uppercase, lowercase, numeric, and special characters required
 * - Leading/trailing whitespace prohibited
 */
export function IsStrongPassword(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: "isStrongPassword",
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: any, _args: ValidationArguments) {
          if (typeof value !== "string") return false
          return validatePasswordPolicy(value).isValid
        },
        defaultMessage(args: ValidationArguments) {
          const result = validatePasswordPolicy(args.value)
          return (
            result.errors.join(" ") ||
            "Password does not meet Cliniqo security requirements."
          )
        },
      },
    })
  }
}

export class LoginDto {
  @IsEmail({}, { message: "Invalid email address format." })
  @IsString({ message: "Email must be a string." })
  @IsNotEmpty({ message: "Email cannot be empty." })
  @MaxLength(254, { message: "Email cannot exceed 254 characters." })
  email: string

  @IsString({ message: "Password must be a string." })
  @IsNotEmpty({ message: "Password cannot be empty." })
  @MaxLength(128, { message: "Password cannot exceed 128 characters." })
  password: string

  @IsOptional()
  @IsString({ message: "Session type must be a string." })
  sessionType?: "WEB_STANDARD" | "DESKTOP_PERSISTENT"

  @IsOptional()
  @IsString({ message: "Device ID must be a string." })
  deviceId?: string
}

export class RefreshTokenDto {
  @IsString({ message: "Refresh token must be a string." })
  @IsNotEmpty({ message: "Refresh token cannot be empty." })
  @Length(64, 64, {
    message: "Refresh token must be a 64-character hexadecimal string.",
  })
  refreshToken: string

  @IsOptional()
  @IsString({ message: "Device ID must be a string." })
  deviceId?: string

  @IsOptional()
  @IsString({ message: "Idempotency key must be a string." })
  idempotencyKey?: string
}

export class ForgotPasswordDto {
  @IsEmail({}, { message: "Invalid email address format." })
  @IsString({ message: "Email must be a string." })
  @IsNotEmpty({ message: "Email cannot be empty." })
  @MaxLength(254, { message: "Email cannot exceed 254 characters." })
  email: string
}

export class VerifyOtpDto {
  @IsEmail({}, { message: "Invalid email address format." })
  @IsString({ message: "Email must be a string." })
  @IsNotEmpty({ message: "Email cannot be empty." })
  @MaxLength(254, { message: "Email cannot exceed 254 characters." })
  email: string

  @IsString({ message: "Verification code must be a string." })
  @IsNotEmpty({ message: "Verification code cannot be empty." })
  @Length(6, 6, { message: "Verification code must be exactly 6 digits." })
  @Matches(/^\d{6}$/, {
    message: "Verification code must contain only 6 digits.",
  })
  otp: string
}

export class ResendOtpDto {
  @IsEmail({}, { message: "Invalid email address format." })
  @IsString({ message: "Email must be a string." })
  @IsNotEmpty({ message: "Email cannot be empty." })
  @MaxLength(254, { message: "Email cannot exceed 254 characters." })
  email: string
}

export class ResetPasswordDto {
  @IsString({ message: "Reset token must be a string." })
  @IsNotEmpty({ message: "Reset token cannot be empty." })
  @Length(64, 64, {
    message: "Reset token must be a 64-character hexadecimal string.",
  })
  token: string

  @IsString({ message: "New password must be a string." })
  @IsNotEmpty({ message: "New password cannot be empty." })
  @MinLength(10, { message: "Password must be at least 10 characters long." })
  @MaxLength(128, { message: "Password cannot exceed 128 characters." })
  @IsStrongPassword()
  newPassword: string
}
