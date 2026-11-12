import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
} from "@nestjs/common"
import { InjectModel } from "@nestjs/mongoose"
import { Model, Types } from "mongoose"
import {
  Invoice,
  InvoiceDocument,
  InvoiceStatus,
  PaymentStatus,
  InvoiceItem,
} from "./schemas/invoice.schema.js"
import { CreateInvoiceDto, InvoiceItemDto } from "./dto/create-invoice.dto.js"
import { UpdateInvoiceDto } from "./dto/update-invoice.dto.js"
import { QueryInvoicesDto } from "./dto/query-invoices.dto.js"
import { createHash, randomUUID } from "crypto"
import {
  IdempotencyRecord,
  IdempotencyRecordDocument,
} from "../common/schemas/idempotency-record.schema.js"
import { Patient, PatientDocument } from "../patient/schemas/patient.schema.js"

export interface CalculatedTotals {
  items: InvoiceItem[]
  subtotalPaise: number
  discountPaise: number
  taxRatePercent: number
  taxPaise: number
  totalPaise: number
}

export function computeInvoiceTotals(
  itemsDto: InvoiceItemDto[],
  discountPaise = 0,
  taxRatePercent = 0,
): CalculatedTotals {
  if (!itemsDto || itemsDto.length === 0) {
    throw new BadRequestException("At least one invoice item is required.")
  }

  const items: InvoiceItem[] = itemsDto.map((item) => {
    if (
      typeof item.quantity !== "number" ||
      !Number.isInteger(item.quantity) ||
      item.quantity < 1
    ) {
      throw new BadRequestException(
        `Item "${item.description}": quantity must be an integer >= 1.`,
      )
    }
    if (
      typeof item.unitPricePaise !== "number" ||
      !Number.isInteger(item.unitPricePaise) ||
      item.unitPricePaise < 0
    ) {
      throw new BadRequestException(
        `Item "${item.description}": unit price must be an integer minor unit >= 0.`,
      )
    }
    const totalPaise = item.quantity * item.unitPricePaise
    return {
      description: item.description.trim(),
      quantity: item.quantity,
      unitPricePaise: item.unitPricePaise,
      totalPaise,
    }
  })

  const subtotalPaise = items.reduce((sum, it) => sum + it.totalPaise, 0)

  if (
    typeof discountPaise !== "number" ||
    !Number.isInteger(discountPaise) ||
    discountPaise < 0
  ) {
    throw new BadRequestException(
      "Discount must be an integer minor unit >= 0.",
    )
  }

  const effectiveDiscountPaise = Math.min(discountPaise, subtotalPaise)
  const taxableAmountPaise = subtotalPaise - effectiveDiscountPaise

  if (
    typeof taxRatePercent !== "number" ||
    taxRatePercent < 0 ||
    taxRatePercent > 100
  ) {
    throw new BadRequestException("Tax rate must be between 0 and 100 percent.")
  }

  // Integer monetary rounding for tax minor units
  const taxPaise = Math.round(taxableAmountPaise * (taxRatePercent / 100))
  const totalPaise = taxableAmountPaise + taxPaise

  return {
    items,
    subtotalPaise,
    discountPaise: effectiveDiscountPaise,
    taxRatePercent,
    taxPaise,
    totalPaise,
  }
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name)

  constructor(
    @InjectModel(Invoice.name)
    private readonly invoiceModel: Model<InvoiceDocument>,
    @InjectModel(Patient.name)
    private readonly patientModel: Model<PatientDocument>,
    @InjectModel(IdempotencyRecord.name)
    private readonly idempotencyModel: Model<IdempotencyRecordDocument>,
  ) {}

  /**
   * Creates an invoice draft or finalized invoice with integer minor units arithmetic.
   * Checks patient tenancy and supports persistent idempotency.
   */
  async createInvoice(
    clinicId: Types.ObjectId,
    doctorId: Types.ObjectId,
    dto: CreateInvoiceDto,
    idempotencyKey?: string,
  ): Promise<InvoiceDocument> {
    if (!Types.ObjectId.isValid(dto.patientId)) {
      throw new BadRequestException("Invalid patientId.")
    }

    const patient = await this.patientModel.findOne({
      _id: new Types.ObjectId(dto.patientId),
      clinicId,
    })
    if (!patient) {
      throw new NotFoundException("Patient not found in this clinic.")
    }

    if (idempotencyKey) {
      const existingKey = await this.idempotencyModel.findOne({
        clinicId,
        key: idempotencyKey,
      })
      if (existingKey?.responseBody) {
        return existingKey.responseBody as unknown as InvoiceDocument
      }
    }

    const totals = computeInvoiceTotals(
      dto.items,
      dto.discountPaise || 0,
      dto.taxRatePercent || 0,
    )

    const invoiceNumber = await this.generateInvoiceNumber(clinicId)

    const invoiceDate = dto.invoiceDate
      ? new Date(`${dto.invoiceDate}T00:00:00Z`)
      : new Date()

    const invoice = new this.invoiceModel({
      clinicId,
      patientId: patient._id,
      consultationId:
        dto.consultationId && Types.ObjectId.isValid(dto.consultationId)
          ? new Types.ObjectId(dto.consultationId)
          : null,
      invoiceNumber,
      invoiceDate,
      status: InvoiceStatus.DRAFT,
      paymentStatus: dto.paymentStatus || PaymentStatus.UNPAID,
      items: totals.items,
      subtotalPaise: totals.subtotalPaise,
      discountPaise: totals.discountPaise,
      taxRatePercent: totals.taxRatePercent,
      taxPaise: totals.taxPaise,
      totalPaise: totals.totalPaise,
      notes: dto.notes?.trim() || null,
      createdBy: doctorId,
      version: 1,
    })

    const saved = await invoice.save()

    if (idempotencyKey) {
      try {
        const now = new Date()
        await this.idempotencyModel.create({
          clinicId,
          key: idempotencyKey,
          httpMethod: "POST",
          normalizedRoute: "/billing",
          requestFingerprint: createHash("sha256")
            .update(JSON.stringify(dto))
            .digest("hex"),
          status: "COMPLETED",
          claimToken: randomUUID(),
          responseCode: 201,
          responseBody: saved.toObject(),
          expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        })
      } catch (e) {
        this.logger.warn(
          `Failed to store idempotency record for invoice ${saved._id.toString()}: ${String(e)}`,
        )
      }
    }

    return saved
  }

  /**
   * Retrieves invoices for a clinic with optional filters.
   */
  async getInvoices(
    clinicId: Types.ObjectId,
    query: QueryInvoicesDto,
  ): Promise<{
    invoices: InvoiceDocument[]
    total: number
    page: number
    limit: number
  }> {
    const filter: Record<string, any> = { clinicId }

    if (query.patientId && Types.ObjectId.isValid(query.patientId)) {
      filter.patientId = new Types.ObjectId(query.patientId)
    }
    if (query.consultationId && Types.ObjectId.isValid(query.consultationId)) {
      filter.consultationId = new Types.ObjectId(query.consultationId)
    }
    if (query.status) {
      filter.status = query.status
    }
    if (query.paymentStatus) {
      filter.paymentStatus = query.paymentStatus
    }

    const page = query.page && query.page > 0 ? query.page : 1
    const limit =
      query.limit && query.limit > 0 ? Math.min(query.limit, 100) : 20
    const skip = (page - 1) * limit

    const [invoices, total] = await Promise.all([
      this.invoiceModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("patientId", "name patientCode phone age gender")
        .exec(),
      this.invoiceModel.countDocuments(filter),
    ])

    return { invoices, total, page, limit }
  }

  /**
   * Retrieves a single invoice ensuring clinic tenancy.
   */
  async getInvoiceById(
    clinicId: Types.ObjectId,
    invoiceId: string,
  ): Promise<InvoiceDocument> {
    if (!Types.ObjectId.isValid(invoiceId)) {
      throw new BadRequestException("Invalid invoice ID.")
    }

    const invoice = await this.invoiceModel
      .findOne({ _id: new Types.ObjectId(invoiceId), clinicId })
      .populate("patientId", "name patientCode phone age gender")

    if (!invoice) {
      throw new NotFoundException("Invoice not found in this clinic.")
    }

    return invoice
  }

  /**
   * Updates an invoice draft. Finalized or cancelled invoices cannot be modified.
   */
  async updateInvoiceDraft(
    clinicId: Types.ObjectId,
    invoiceId: string,
    dto: UpdateInvoiceDto,
  ): Promise<InvoiceDocument> {
    const invoice = await this.getInvoiceById(clinicId, invoiceId)

    if (invoice.status !== InvoiceStatus.DRAFT) {
      throw new ConflictException(
        `Cannot edit invoice in ${invoice.status} status. Only DRAFT invoices may be modified.`,
      )
    }

    const itemsDto =
      dto.items ||
      invoice.items.map((it) => ({
        description: it.description,
        quantity: it.quantity,
        unitPricePaise: it.unitPricePaise,
      }))

    const discountPaise =
      dto.discountPaise !== undefined
        ? dto.discountPaise
        : invoice.discountPaise
    const taxRatePercent =
      dto.taxRatePercent !== undefined
        ? dto.taxRatePercent
        : invoice.taxRatePercent

    const totals = computeInvoiceTotals(itemsDto, discountPaise, taxRatePercent)

    invoice.items = totals.items
    invoice.subtotalPaise = totals.subtotalPaise
    invoice.discountPaise = totals.discountPaise
    invoice.taxRatePercent = totals.taxRatePercent
    invoice.taxPaise = totals.taxPaise
    invoice.totalPaise = totals.totalPaise

    if (dto.paymentStatus !== undefined) {
      invoice.paymentStatus = dto.paymentStatus
    }
    if (dto.notes !== undefined) {
      invoice.notes = dto.notes?.trim() || null
    }

    invoice.version += 1
    return invoice.save()
  }

  /**
   * Finalizes an invoice draft into an immutable record.
   */
  async finalizeInvoice(
    clinicId: Types.ObjectId,
    doctorId: Types.ObjectId,
    invoiceId: string,
  ): Promise<InvoiceDocument> {
    const invoice = await this.getInvoiceById(clinicId, invoiceId)

    if (invoice.status === InvoiceStatus.FINALIZED) {
      return invoice
    }

    if (invoice.status === InvoiceStatus.CANCELLED) {
      throw new ConflictException("Cannot finalize a cancelled invoice.")
    }

    invoice.status = InvoiceStatus.FINALIZED
    invoice.finalizedAt = new Date()
    invoice.finalizedBy = doctorId
    invoice.version += 1

    return invoice.save()
  }

  /**
   * Cancels an invoice with a required audit reason.
   */
  async cancelInvoice(
    clinicId: Types.ObjectId,
    doctorId: Types.ObjectId,
    invoiceId: string,
    reason: string,
  ): Promise<InvoiceDocument> {
    if (!reason || !reason.trim()) {
      throw new BadRequestException(
        "A non-empty cancellation reason is required.",
      )
    }

    const invoice = await this.getInvoiceById(clinicId, invoiceId)

    if (invoice.status === InvoiceStatus.CANCELLED) {
      return invoice
    }

    invoice.status = InvoiceStatus.CANCELLED
    invoice.cancelledAt = new Date()
    invoice.cancelledBy = doctorId
    invoice.cancellationReason = reason.trim()
    invoice.version += 1

    return invoice.save()
  }

  private async generateInvoiceNumber(
    clinicId: Types.ObjectId,
  ): Promise<string> {
    const year = new Date().getFullYear()
    const count = await this.invoiceModel.countDocuments({ clinicId })
    const seq = count + 1
    return `INV-${year}-${seq.toString().padStart(4, "0")}`
  }
}
