import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsInt,
  Min,
  Max,
  IsArray,
  ValidateNested,
  IsEnum,
  MaxLength,
  IsNumber,
} from "class-validator"
import { Type } from "class-transformer"
import { PaymentStatus } from "../schemas/invoice.schema.js"

export class InvoiceItemDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  description: string

  @IsInt()
  @Min(1)
  quantity: number

  @IsInt()
  @Min(0)
  unitPricePaise: number
}

export class CreateInvoiceDto {
  @IsString()
  @IsNotEmpty()
  patientId: string

  @IsOptional()
  @IsString()
  consultationId?: string

  @IsOptional()
  @IsString()
  invoiceDate?: string

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InvoiceItemDto)
  items: InvoiceItemDto[]

  @IsOptional()
  @IsInt()
  @Min(0)
  discountPaise?: number = 0

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  taxRatePercent?: number = 0

  @IsOptional()
  @IsEnum(PaymentStatus)
  paymentStatus?: PaymentStatus = PaymentStatus.UNPAID

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string
}
