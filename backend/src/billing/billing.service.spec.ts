import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Types } from 'mongoose';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  BillingService,
  computeInvoiceTotals,
} from './billing.service.js';
import {
  InvoiceStatus,
  PaymentStatus,
} from './schemas/invoice.schema.js';

describe('Billing Monetary Arithmetic (computeInvoiceTotals)', () => {
  it('correctly calculates subtotal, discount, tax and total in integer minor units (paise)', () => {
    // 2 consultations @ 800.00 INR (80000 paise each) = 160000 paise
    // 1 injection fee @ 250.00 INR (25000 paise) = 25000 paise
    // Subtotal = 185000 paise
    // Discount = 10000 paise (100.00 INR)
    // Taxable = 175000 paise
    // Tax rate = 18% -> 175000 * 0.18 = 31500 paise
    // Total = 175000 + 31500 = 206500 paise (2065.00 INR)
    const items = [
      { description: 'Consultation', quantity: 2, unitPricePaise: 80000 },
      { description: 'Procedure', quantity: 1, unitPricePaise: 25000 },
    ];

    const result = computeInvoiceTotals(items, 10000, 18);

    expect(result.subtotalPaise).toBe(185000);
    expect(result.discountPaise).toBe(10000);
    expect(result.taxPaise).toBe(31500);
    expect(result.totalPaise).toBe(206500);
  });

  it('clamps discount so it cannot exceed subtotal', () => {
    const items = [{ description: 'Follow-up', quantity: 1, unitPricePaise: 50000 }];
    // Subtotal = 50000, discount requested = 70000
    const result = computeInvoiceTotals(items, 70000, 0);

    expect(result.subtotalPaise).toBe(50000);
    expect(result.discountPaise).toBe(50000);
    expect(result.totalPaise).toBe(0);
  });

  it('rejects empty items array', () => {
    expect(() => computeInvoiceTotals([], 0, 0)).toThrow(BadRequestException);
  });

  it('rejects invalid quantity (< 1 or non-integer)', () => {
    expect(() =>
      computeInvoiceTotals([{ description: 'Item', quantity: 0, unitPricePaise: 1000 }], 0, 0),
    ).toThrow(BadRequestException);

    expect(() =>
      computeInvoiceTotals([{ description: 'Item', quantity: 1.5, unitPricePaise: 1000 }], 0, 0),
    ).toThrow(BadRequestException);
  });

  it('rejects negative unit price or negative discount', () => {
    expect(() =>
      computeInvoiceTotals([{ description: 'Item', quantity: 1, unitPricePaise: -500 }], 0, 0),
    ).toThrow(BadRequestException);

    expect(() =>
      computeInvoiceTotals([{ description: 'Item', quantity: 1, unitPricePaise: 500 }], -100, 0),
    ).toThrow(BadRequestException);
  });

  it('rejects invalid tax rate (> 100 or < 0)', () => {
    expect(() =>
      computeInvoiceTotals([{ description: 'Item', quantity: 1, unitPricePaise: 1000 }], 0, 105),
    ).toThrow(BadRequestException);

    expect(() =>
      computeInvoiceTotals([{ description: 'Item', quantity: 1, unitPricePaise: 1000 }], 0, -5),
    ).toThrow(BadRequestException);
  });
});

describe('BillingService', () => {
  let service: BillingService;
  let mockInvoiceModel: any;
  let mockPatientModel: any;
  let mockIdempotencyModel: any;

  const clinicId = new Types.ObjectId();
  const doctorId = new Types.ObjectId();
  const patientId = new Types.ObjectId();

  beforeEach(() => {
    const MockModel = vi.fn().mockImplementation(function (this: any, doc: any) {
      Object.assign(this, doc);
      this._id = new Types.ObjectId();
      this.save = vi.fn().mockResolvedValue(this);
      this.toObject = () => ({ ...this });
    });

    MockModel.findOne = vi.fn();
    MockModel.find = vi.fn();
    MockModel.countDocuments = vi.fn().mockResolvedValue(0);

    mockInvoiceModel = MockModel as any;

    mockPatientModel = {
      findOne: vi.fn(),
    };

    mockIdempotencyModel = {
      findOne: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    };

    service = new BillingService(
      mockInvoiceModel,
      mockPatientModel as any,
      mockIdempotencyModel as any,
    );
  });

  describe('createInvoice', () => {
    it('creates an invoice draft with minor-unit integer arithmetic and clinic isolation', async () => {
      mockPatientModel.findOne.mockResolvedValue({ _id: patientId, clinicId });

      const dto = {
        patientId: patientId.toHexString(),
        items: [{ description: 'General Consultation', quantity: 1, unitPricePaise: 80000 }],
        discountPaise: 0,
        taxRatePercent: 0,
        paymentStatus: PaymentStatus.UNPAID,
      };

      const result = await service.createInvoice(clinicId, doctorId, dto);
      expect(result).toBeDefined();
      expect(result.clinicId).toBe(clinicId);
      expect(result.patientId).toBe(patientId);
      expect(result.status).toBe(InvoiceStatus.DRAFT);
      expect(result.subtotalPaise).toBe(80000);
      expect(result.totalPaise).toBe(80000);
    });

    it('rejects invoice creation if patient belongs to a different clinic', async () => {
      mockPatientModel.findOne.mockResolvedValue(null);

      const dto = {
        patientId: new Types.ObjectId().toHexString(),
        items: [{ description: 'General Consultation', quantity: 1, unitPricePaise: 80000 }],
      };

      await expect(service.createInvoice(clinicId, doctorId, dto)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('returns existing response when idempotency key is matched', async () => {
      mockPatientModel.findOne.mockResolvedValue({ _id: patientId, clinicId });
      const cached = { _id: new Types.ObjectId(), invoiceNumber: 'INV-2026-0001' };
      mockIdempotencyModel.findOne.mockResolvedValue({ responseBody: cached });

      const dto = {
        patientId: patientId.toHexString(),
        items: [{ description: 'General Consultation', quantity: 1, unitPricePaise: 80000 }],
      };

      const result = await service.createInvoice(clinicId, doctorId, dto, 'idem-123');
      expect(result).toBe(cached);
      expect(mockInvoiceModel).not.toHaveBeenCalled();
    });
  });

  describe('updateInvoiceDraft', () => {
    it('updates draft and recalculates totals', async () => {
      const existingDoc = {
        _id: new Types.ObjectId(),
        clinicId,
        status: InvoiceStatus.DRAFT,
        items: [{ description: 'Consultation', quantity: 1, unitPricePaise: 50000, totalPaise: 50000 }],
        subtotalPaise: 50000,
        discountPaise: 0,
        taxRatePercent: 0,
        taxPaise: 0,
        totalPaise: 50000,
        version: 1,
        populate: vi.fn().mockReturnThis(),
        save: vi.fn().mockImplementation(function (this: any) {
          return Promise.resolve(this);
        }),
      };
      mockInvoiceModel.findOne.mockReturnValue({
        populate: vi.fn().mockResolvedValue(existingDoc),
      });

      const dto = {
        items: [{ description: 'Specialist Consultation', quantity: 1, unitPricePaise: 120000 }],
        discountPaise: 20000,
      };

      const updated = await service.updateInvoiceDraft(clinicId, existingDoc._id.toHexString(), dto);
      expect(updated.subtotalPaise).toBe(120000);
      expect(updated.discountPaise).toBe(20000);
      expect(updated.totalPaise).toBe(100000);
      expect(updated.version).toBe(2);
    });

    it('rejects editing an invoice that has been FINALIZED', async () => {
      const existingDoc = {
        _id: new Types.ObjectId(),
        clinicId,
        status: InvoiceStatus.FINALIZED,
        populate: vi.fn().mockReturnThis(),
      };
      mockInvoiceModel.findOne.mockReturnValue({
        populate: vi.fn().mockResolvedValue(existingDoc),
      });

      await expect(
        service.updateInvoiceDraft(clinicId, existingDoc._id.toHexString(), {}),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('finalizeInvoice', () => {
    it('transitions DRAFT to FINALIZED and records finalized timestamp', async () => {
      const existingDoc = {
        _id: new Types.ObjectId(),
        clinicId,
        status: InvoiceStatus.DRAFT,
        version: 1,
        populate: vi.fn().mockReturnThis(),
        save: vi.fn().mockImplementation(function (this: any) {
          return Promise.resolve(this);
        }),
      };
      mockInvoiceModel.findOne.mockReturnValue({
        populate: vi.fn().mockResolvedValue(existingDoc),
      });

      const finalized = await service.finalizeInvoice(clinicId, doctorId, existingDoc._id.toHexString());
      expect(finalized.status).toBe(InvoiceStatus.FINALIZED);
      expect(finalized.finalizedBy).toBe(doctorId);
      expect(finalized.finalizedAt).toBeInstanceOf(Date);
      expect(finalized.version).toBe(2);
    });

    it('rejects finalizing a CANCELLED invoice', async () => {
      const existingDoc = {
        _id: new Types.ObjectId(),
        clinicId,
        status: InvoiceStatus.CANCELLED,
        populate: vi.fn().mockReturnThis(),
      };
      mockInvoiceModel.findOne.mockReturnValue({
        populate: vi.fn().mockResolvedValue(existingDoc),
      });

      await expect(
        service.finalizeInvoice(clinicId, doctorId, existingDoc._id.toHexString()),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('cancelInvoice', () => {
    it('cancels invoice and requires non-empty reason', async () => {
      const existingDoc = {
        _id: new Types.ObjectId(),
        clinicId,
        status: InvoiceStatus.DRAFT,
        version: 1,
        populate: vi.fn().mockReturnThis(),
        save: vi.fn().mockImplementation(function (this: any) {
          return Promise.resolve(this);
        }),
      };
      mockInvoiceModel.findOne.mockReturnValue({
        populate: vi.fn().mockResolvedValue(existingDoc),
      });

      await expect(
        service.cancelInvoice(clinicId, doctorId, existingDoc._id.toHexString(), '   '),
      ).rejects.toThrow(BadRequestException);

      const cancelled = await service.cancelInvoice(
        clinicId,
        doctorId,
        existingDoc._id.toHexString(),
        'Billing error in line items',
      );
      expect(cancelled.status).toBe(InvoiceStatus.CANCELLED);
      expect(cancelled.cancellationReason).toBe('Billing error in line items');
    });
  });
});
