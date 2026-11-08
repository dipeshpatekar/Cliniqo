import {
  IsOptional,
  IsInt,
  Min,
  Max,
  IsArray,
  ValidateNested,
  IsEnum,
  MaxLength,
  IsNumber,
  IsString,
} from "class-validator"
import { Type } from "class-transformer"
import { InvoiceItemDto } from "./create-invoice.dto.js"
import { PaymentStatus } from "../schemas/invoice.schema.js"

export class UpdateInvoiceDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InvoiceItemDto)
  items?: InvoiceItemDto[]

  @IsOptional()
  @IsInt()
  @Min(0)
  discountPaise?: number

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  taxRatePercent?: number

  @IsOptional()
  @IsEnum(PaymentStatus)
  paymentStatus?: PaymentStatus

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string
}
