import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Types } from 'mongoose';
import { SyncService } from './sync.service.js';
import { SyncPushDto } from './dto/sync-push.dto.js';
import { SyncActionType, SyncEntityType } from './schemas/sync-change-feed.schema.js';
import { InvoiceStatus, PaymentStatus } from '../billing/schemas/invoice.schema.js';

describe('SyncService Invoice Sync Mutations', () => {
  let service: SyncService;

  let mockConnection: any;
  let mockChangeFeedModel: any;
  let mockCounterModel: any;
  let mockConflictModel: any;
  let mockIdempotencyModel: any;
  let mockPatientModel: any;
  let mockConsultationModel: any;
  let mockPrescriptionModel: any;
  let mockRevisionModel: any;
  let mockSeqCounterModel: any;
  let mockInvoiceModel: any;

  const clinicId = new Types.ObjectId('672bb0000000000000000001');
  const doctorId = new Types.ObjectId('672aa0000000000000000001');
  const patientId = new Types.ObjectId('672cc0000000000000000001');

  beforeEach(() => {
    const mockSession = {
      withTransaction: vi.fn(async (cb: () => Promise<void>) => {
        await cb();
      }),
      endSession: vi.fn(),
    };

    mockConnection = {
      startSession: vi.fn().mockResolvedValue(mockSession),
    };

    mockChangeFeedModel = {
      create: vi.fn().mockResolvedValue([{}]),
      find: vi.fn(),
    };

    mockCounterModel = {
      findOneAndUpdate: vi.fn().mockResolvedValue({ lastSeq: 42 }),
      findOne: vi.fn().mockResolvedValue({ lastSeq: 42 }),
    };

    mockConflictModel = {
      create: vi.fn().mockResolvedValue([{}]),
    };

    mockIdempotencyModel = {
      findOne: vi.fn().mockResolvedValue(null),
      findOneAndUpdate: vi.fn().mockResolvedValue({}),
      updateOne: vi.fn().mockResolvedValue({}),
    };

    mockPatientModel = {
      findOne: vi.fn().mockImplementation((filter: any) => {
        if (filter.clinicId && filter.clinicId.equals(clinicId)) {
          if (
            (filter._id && filter._id.equals(patientId)) ||
            filter.patientId === 'PAT-2026-0001'
          ) {
            return Promise.resolve({
              _id: patientId,
              clinicId,
              patientId: 'PAT-2026-0001',
            });
          }
        }
        return Promise.resolve(null);
      }),
    };

    mockConsultationModel = {
      findOne: vi.fn().mockResolvedValue(null),
    };

    mockPrescriptionModel = {
      findOne: vi.fn().mockResolvedValue(null),
    };

    mockRevisionModel = {
      findOne: vi.fn().mockResolvedValue(null),
    };

    mockSeqCounterModel = {
      findOneAndUpdate: vi.fn().mockResolvedValue({ currentSequence: 1 }),
    };

    const MockInvoiceModel: any = vi.fn().mockImplementation(function (this: any, doc: any) {
      Object.assign(this, doc);
      this._id = doc._id || new Types.ObjectId();
      this.version = doc.version || 1;
      this.save = vi.fn().mockResolvedValue(this);
      this.toObject = () => ({ ...this });
    });
    MockInvoiceModel.create = vi.fn().mockImplementation((docs: any[]) => {
      return Promise.resolve(
        docs.map((d) => {
          const instance: any = {
            ...d,
            _id: new Types.ObjectId(),
            version: d.version || 1,
            save: vi.fn().mockResolvedValue(d),
            toObject: () => ({ ...d, _id: instance._id }),
          };
          return instance;
        }),
      );
    });
    MockInvoiceModel.findOne = vi.fn().mockResolvedValue(null);

    mockInvoiceModel = MockInvoiceModel as any;

    service = new SyncService(
      mockConnection,
      mockChangeFeedModel,
      mockCounterModel,
      mockConflictModel,
      mockIdempotencyModel,
      mockPatientModel,
      mockConsultationModel,
      mockPrescriptionModel,
      mockRevisionModel,
      mockSeqCounterModel,
      mockInvoiceModel,
    );
  });

  describe('Invoice CREATE mutation', () => {
    it('successfully creates an invoice and records monotonic change feed entry', async () => {
      const dto: SyncPushDto = {
        mutations: [
          {
            outboxId: 'outbox-inv-1',
            entityType: SyncEntityType.INVOICE,
            entityId: 'client-inv-1',
            action: SyncActionType.CREATE,
            clientVersion: 1,
            idempotencyKey: 'idem-inv-create-1',
            payload: {
              patientId: patientId.toHexString(),
              invoiceNumber: 'INV-2026-0001',
              invoiceDate: '2026-10-28T10:00:00.000Z',
              items: [
                {
                  description: 'Consultation Fee',
                  quantity: 1,
                  unitPricePaise: 80000,
                  totalPaise: 80000,
                },
                {
                  description: 'CBC Blood Test',
                  quantity: 1,
                  unitPricePaise: 35000,
                  totalPaise: 35000,
                },
              ],
              subtotalPaise: 115000,
              discountPaise: 15000,
              taxRatePercent: 18,
              notes: 'First visit billing',
            },
          },
        ],
      };

      const response = await service.push(clinicId, doctorId, dto);

      expect(response.results).toHaveLength(1);
      const result = response.results[0];
      expect(result.status).toBe('APPLIED');
      expect(result.outboxId).toBe('outbox-inv-1');
      expect(result.serverId).toBeDefined();
      expect(result.serverVersion).toBe(1);

      // Verify invoice model creation
      expect(mockInvoiceModel.create).toHaveBeenCalledTimes(1);
      const createdArgs = mockInvoiceModel.create.mock.calls[0][0][0];
      expect(createdArgs.clinicId).toEqual(clinicId);
      expect(createdArgs.patientId).toEqual(patientId);
      expect(createdArgs.invoiceNumber).toBe('INV-2026-0001');
      expect(createdArgs.subtotalPaise).toBe(115000);
      expect(createdArgs.discountPaise).toBe(15000);
      // Taxable = 100000, 18% = 18000, Total = 118000 paise
      expect(createdArgs.taxPaise).toBe(18000);
      expect(createdArgs.totalPaise).toBe(118000);
      expect(createdArgs.status).toBe(InvoiceStatus.DRAFT);
      expect(createdArgs.paymentStatus).toBe(PaymentStatus.UNPAID);
      expect(createdArgs.items).toHaveLength(2);

      // Verify change feed appending
      expect(mockChangeFeedModel.create).toHaveBeenCalledTimes(1);
      const feedArg = mockChangeFeedModel.create.mock.calls[0][0][0];
      expect(feedArg.entityType).toBe(SyncEntityType.INVOICE);
      expect(feedArg.action).toBe(SyncActionType.CREATE);
      expect(feedArg.version).toBe(1);
      expect(feedArg.seq).toBe(42);
    });

    it('rejects cross-clinic invoice creation when patient belongs to another clinic', async () => {
      const foreignPatientId = new Types.ObjectId('672cc9999999999999999999');

      const dto: SyncPushDto = {
        mutations: [
          {
            outboxId: 'outbox-cross-clinic',
            entityType: SyncEntityType.INVOICE,
            entityId: 'client-inv-cross',
            action: SyncActionType.CREATE,
            clientVersion: 1,
            idempotencyKey: 'idem-cross-1',
            payload: {
              patientId: foreignPatientId.toHexString(),
              invoiceNumber: 'INV-FOREIGN-1',
              subtotalPaise: 50000,
            },
          },
        ],
      };

      const response = await service.push(clinicId, doctorId, dto);
      expect(response.results).toHaveLength(1);
      const result = response.results[0];
      expect(result.status).toBe('REJECTED');
      expect(result.error).toContain('Patient record not found in this clinic');
      expect(mockInvoiceModel.create).not.toHaveBeenCalled();
    });

    it('handles idempotent retries when same idempotencyKey is re-submitted', async () => {
      const cachedResult = {
        outboxId: 'outbox-retry-1',
        status: 'APPLIED' as const,
        entityType: SyncEntityType.INVOICE,
        entityId: 'client-inv-1',
        serverId: '672ee0000000000000000001',
        serverVersion: 1,
      };

      const payload = {
        patientId: patientId.toHexString(),
        invoiceNumber: 'INV-RETRY-1',
        subtotalPaise: 50000,
      };

      const crypto = await import('crypto');
      const fingerprint = crypto
        .createHash('sha256')
        .update(JSON.stringify(payload))
        .digest('hex');

      mockIdempotencyModel.findOne.mockResolvedValue({
        status: 'COMPLETED',
        requestFingerprint: fingerprint,
        responseBody: cachedResult,
      });

      const dto: SyncPushDto = {
        mutations: [
          {
            outboxId: 'outbox-retry-1',
            entityType: SyncEntityType.INVOICE,
            entityId: 'client-inv-1',
            action: SyncActionType.CREATE,
            clientVersion: 1,
            idempotencyKey: 'idem-retry-1',
            payload,
          },
        ],
      };

      const response = await service.push(clinicId, doctorId, dto);
      expect(response.results).toHaveLength(1);
      expect(response.results[0]).toEqual(cachedResult);
      expect(mockInvoiceModel.create).not.toHaveBeenCalled();
    });

    it('handles duplicate delivery idempotently if invoiceNumber already exists', async () => {
      const existingId = new Types.ObjectId('672ee0000000000000000002');
      mockInvoiceModel.findOne.mockResolvedValue({
        _id: existingId,
        clinicId,
        invoiceNumber: 'INV-EXISTING-1',
        version: 2,
      });

      const dto: SyncPushDto = {
        mutations: [
          {
            outboxId: 'outbox-dup-1',
            entityType: SyncEntityType.INVOICE,
            entityId: 'client-inv-dup',
            action: SyncActionType.CREATE,
            clientVersion: 1,
            idempotencyKey: 'idem-dup-new-key',
            payload: {
              patientId: patientId.toHexString(),
              invoiceNumber: 'INV-EXISTING-1',
              subtotalPaise: 50000,
            },
          },
        ],
      };

      const response = await service.push(clinicId, doctorId, dto);
      expect(response.results).toHaveLength(1);
      const result = response.results[0];
      expect(result.status).toBe('APPLIED');
      expect(result.serverId).toBe(existingId.toString());
      expect(result.serverVersion).toBe(2);
      expect(mockInvoiceModel.create).not.toHaveBeenCalled();
    });
  });

  describe('Invoice UPDATE mutation', () => {
    it('successfully updates a DRAFT invoice and increments version', async () => {
      const invoiceId = new Types.ObjectId('672ee0000000000000000010');
      const existingDoc: any = {
        _id: invoiceId,
        clinicId,
        status: InvoiceStatus.DRAFT,
        version: 1,
        subtotalPaise: 50000,
        discountPaise: 0,
        taxRatePercent: 0,
        taxPaise: 0,
        totalPaise: 50000,
        items: [{ description: 'Item 1', quantity: 1, unitPricePaise: 50000, totalPaise: 50000 }],
        save: vi.fn().mockImplementation(function (this: any) {
          return Promise.resolve(this);
        }),
        toObject: function () {
          return { ...this };
        },
      };

      mockInvoiceModel.findOne.mockResolvedValue(existingDoc);

      const dto: SyncPushDto = {
        mutations: [
          {
            outboxId: 'outbox-update-1',
            entityType: SyncEntityType.INVOICE,
            entityId: invoiceId.toHexString(),
            serverId: invoiceId.toHexString(),
            action: SyncActionType.UPDATE,
            clientVersion: 1,
            idempotencyKey: 'idem-update-1',
            payload: {
              subtotalPaise: 80000,
              discountPaise: 10000,
              taxRatePercent: 10,
              notes: 'Updated notes',
              items: [
                {
                  description: 'Item 1 updated',
                  quantity: 2,
                  unitPricePaise: 40000,
                  totalPaise: 80000,
                },
              ],
            },
          },
        ],
      };

      const response = await service.push(clinicId, doctorId, dto);
      expect(response.results).toHaveLength(1);
      const result = response.results[0];
      expect(result.status).toBe('APPLIED');
      expect(result.serverVersion).toBe(2);
      expect(existingDoc.version).toBe(2);
      expect(existingDoc.subtotalPaise).toBe(80000);
      expect(existingDoc.discountPaise).toBe(10000);
      // Taxable = 70000, 10% = 7000, Total = 77000
      expect(existingDoc.taxPaise).toBe(7000);
      expect(existingDoc.totalPaise).toBe(77000);
      expect(existingDoc.notes).toBe('Updated notes');
      expect(existingDoc.save).toHaveBeenCalled();
      expect(mockChangeFeedModel.create).toHaveBeenCalledTimes(1);
    });

    it('rejects update mutation on FINALIZED invoice (immutability enforcement)', async () => {
      const invoiceId = new Types.ObjectId('672ee0000000000000000020');
      const finalizedDoc: any = {
        _id: invoiceId,
        clinicId,
        status: InvoiceStatus.FINALIZED,
        version: 2,
        toObject: () => ({ _id: invoiceId, status: InvoiceStatus.FINALIZED }),
      };

      mockInvoiceModel.findOne.mockResolvedValue(finalizedDoc);

      const dto: SyncPushDto = {
        mutations: [
          {
            outboxId: 'outbox-update-finalized',
            entityType: SyncEntityType.INVOICE,
            entityId: invoiceId.toHexString(),
            action: SyncActionType.UPDATE,
            clientVersion: 2,
            idempotencyKey: 'idem-update-fin',
            payload: {
              subtotalPaise: 99999,
            },
          },
        ],
      };

      const response = await service.push(clinicId, doctorId, dto);
      expect(response.results).toHaveLength(1);
      const result = response.results[0];
      expect(result.status).toBe('REJECTED');
      expect(result.error).toContain('Cannot modify invoice in FINALIZED status');
    });

    it('rejects update mutation on CANCELLED invoice', async () => {
      const invoiceId = new Types.ObjectId('672ee0000000000000000021');
      const cancelledDoc: any = {
        _id: invoiceId,
        clinicId,
        status: InvoiceStatus.CANCELLED,
        version: 3,
        toObject: () => ({ _id: invoiceId, status: InvoiceStatus.CANCELLED }),
      };

      mockInvoiceModel.findOne.mockResolvedValue(cancelledDoc);

      const dto: SyncPushDto = {
        mutations: [
          {
            outboxId: 'outbox-update-cancelled',
            entityType: SyncEntityType.INVOICE,
            entityId: invoiceId.toHexString(),
            action: SyncActionType.UPDATE,
            clientVersion: 3,
            idempotencyKey: 'idem-update-canc',
            payload: {
              subtotalPaise: 99999,
            },
          },
        ],
      };

      const response = await service.push(clinicId, doctorId, dto);
      expect(response.results).toHaveLength(1);
      const result = response.results[0];
      expect(result.status).toBe('REJECTED');
      expect(result.error).toContain('Cannot modify invoice in CANCELLED status');
    });

    it('records conflict and returns CONFLICT status on stale version', async () => {
      const invoiceId = new Types.ObjectId('672ee0000000000000000030');
      const currentServerDoc: any = {
        _id: invoiceId,
        clinicId,
        status: InvoiceStatus.DRAFT,
        version: 3, // Server is at version 3
        toObject: () => ({ _id: invoiceId, version: 3, status: InvoiceStatus.DRAFT }),
      };

      mockInvoiceModel.findOne.mockResolvedValue(currentServerDoc);

      const dto: SyncPushDto = {
        mutations: [
          {
            outboxId: 'outbox-stale-update',
            entityType: SyncEntityType.INVOICE,
            entityId: invoiceId.toHexString(),
            action: SyncActionType.UPDATE,
            clientVersion: 1, // Client is stale (v1 < v3)
            idempotencyKey: 'idem-stale-1',
            payload: {
              subtotalPaise: 75000,
            },
          },
        ],
      };

      const response = await service.push(clinicId, doctorId, dto);
      expect(response.results).toHaveLength(1);
      const result = response.results[0];
      expect(result.status).toBe('CONFLICT');
      expect(result.serverVersion).toBe(3);
      expect(result.conflictDetails?.conflictReason).toBe('STALE_VERSION');
      expect(result.conflictDetails?.serverVersion).toBe(3);
      expect(result.conflictDetails?.clientVersion).toBe(1);

      expect(mockConflictModel.create).toHaveBeenCalledTimes(1);
      const conflictArg = mockConflictModel.create.mock.calls[0][0][0];
      expect(conflictArg.entityType).toBe(SyncEntityType.INVOICE);
      expect(conflictArg.conflictReason).toBe('STALE_VERSION');
      expect(conflictArg.clientVersion).toBe(1);
      expect(conflictArg.serverVersion).toBe(3);
    });
  });

  describe('Invoice FINALIZE mutation', () => {
    it('finalizes a DRAFT invoice, stamps finalizedBy/At, and increments version', async () => {
      const invoiceId = new Types.ObjectId('672ee0000000000000000040');
      const draftDoc: any = {
        _id: invoiceId,
        clinicId,
        status: InvoiceStatus.DRAFT,
        version: 1,
        save: vi.fn().mockImplementation(function (this: any) {
          return Promise.resolve(this);
        }),
        toObject: function () {
          return { ...this };
        },
      };

      mockInvoiceModel.findOne.mockResolvedValue(draftDoc);

      const dto: SyncPushDto = {
        mutations: [
          {
            outboxId: 'outbox-fin-1',
            entityType: SyncEntityType.INVOICE,
            entityId: invoiceId.toHexString(),
            action: SyncActionType.FINALIZE,
            clientVersion: 1,
            idempotencyKey: 'idem-fin-1',
            payload: {},
          },
        ],
      };

      const response = await service.push(clinicId, doctorId, dto);
      expect(response.results).toHaveLength(1);
      const result = response.results[0];
      expect(result.status).toBe('APPLIED');
      expect(result.serverVersion).toBe(2);
      expect(draftDoc.status).toBe(InvoiceStatus.FINALIZED);
      expect(draftDoc.finalizedBy).toEqual(doctorId);
      expect(draftDoc.finalizedAt).toBeInstanceOf(Date);
      expect(draftDoc.save).toHaveBeenCalled();

      // Change feed entry created
      expect(mockChangeFeedModel.create).toHaveBeenCalledTimes(1);
      const feedArg = mockChangeFeedModel.create.mock.calls[0][0][0];
      expect(feedArg.action).toBe(SyncActionType.FINALIZE);
    });

    it('returns APPLIED idempotently when invoice is already FINALIZED', async () => {
      const invoiceId = new Types.ObjectId('672ee0000000000000000041');
      const finDoc: any = {
        _id: invoiceId,
        clinicId,
        status: InvoiceStatus.FINALIZED,
        version: 2,
        save: vi.fn(),
      };

      mockInvoiceModel.findOne.mockResolvedValue(finDoc);

      const dto: SyncPushDto = {
        mutations: [
          {
            outboxId: 'outbox-fin-idempotent',
            entityType: SyncEntityType.INVOICE,
            entityId: invoiceId.toHexString(),
            action: SyncActionType.FINALIZE,
            clientVersion: 2,
            idempotencyKey: 'idem-fin-dup',
            payload: {},
          },
        ],
      };

      const response = await service.push(clinicId, doctorId, dto);
      expect(response.results).toHaveLength(1);
      const result = response.results[0];
      expect(result.status).toBe('APPLIED');
      expect(result.serverVersion).toBe(2);
      expect(finDoc.save).not.toHaveBeenCalled();
    });

    it('rejects finalize on CANCELLED invoice', async () => {
      const invoiceId = new Types.ObjectId('672ee0000000000000000042');
      const cancDoc: any = {
        _id: invoiceId,
        clinicId,
        status: InvoiceStatus.CANCELLED,
        version: 2,
      };

      mockInvoiceModel.findOne.mockResolvedValue(cancDoc);

      const dto: SyncPushDto = {
        mutations: [
          {
            outboxId: 'outbox-fin-canc',
            entityType: SyncEntityType.INVOICE,
            entityId: invoiceId.toHexString(),
            action: SyncActionType.FINALIZE,
            clientVersion: 2,
            idempotencyKey: 'idem-fin-canc',
            payload: {},
          },
        ],
      };

      const response = await service.push(clinicId, doctorId, dto);
      expect(response.results).toHaveLength(1);
      const result = response.results[0];
      expect(result.status).toBe('REJECTED');
      expect(result.error).toContain('Cannot finalize a cancelled invoice');
    });
  });

  describe('Invoice CANCEL mutation', () => {
    it('cancels an invoice, sets cancellation metadata, and appends to change feed', async () => {
      const invoiceId = new Types.ObjectId('672ee0000000000000000050');
      const invoiceDoc: any = {
        _id: invoiceId,
        clinicId,
        status: InvoiceStatus.FINALIZED,
        version: 2,
        save: vi.fn().mockImplementation(function (this: any) {
          return Promise.resolve(this);
        }),
        toObject: function () {
          return { ...this };
        },
      };

      mockInvoiceModel.findOne.mockResolvedValue(invoiceDoc);

      const dto: SyncPushDto = {
        mutations: [
          {
            outboxId: 'outbox-canc-1',
            entityType: SyncEntityType.INVOICE,
            entityId: invoiceId.toHexString(),
            action: SyncActionType.CANCEL,
            clientVersion: 2,
            idempotencyKey: 'idem-canc-1',
            payload: {
              reason: 'Patient requested refund and cancellation',
            },
          },
        ],
      };

      const response = await service.push(clinicId, doctorId, dto);
      expect(response.results).toHaveLength(1);
      const result = response.results[0];
      expect(result.status).toBe('APPLIED');
      expect(result.serverVersion).toBe(3);
      expect(invoiceDoc.status).toBe(InvoiceStatus.CANCELLED);
      expect(invoiceDoc.cancelledBy).toEqual(doctorId);
      expect(invoiceDoc.cancellationReason).toBe(
        'Patient requested refund and cancellation',
      );
      expect(invoiceDoc.save).toHaveBeenCalled();
      expect(mockChangeFeedModel.create).toHaveBeenCalledTimes(1);
    });

    it('returns APPLIED idempotently when invoice is already CANCELLED', async () => {
      const invoiceId = new Types.ObjectId('672ee0000000000000000051');
      const cancDoc: any = {
        _id: invoiceId,
        clinicId,
        status: InvoiceStatus.CANCELLED,
        version: 3,
        save: vi.fn(),
      };

      mockInvoiceModel.findOne.mockResolvedValue(cancDoc);

      const dto: SyncPushDto = {
        mutations: [
          {
            outboxId: 'outbox-canc-dup',
            entityType: SyncEntityType.INVOICE,
            entityId: invoiceId.toHexString(),
            action: SyncActionType.CANCEL,
            clientVersion: 3,
            idempotencyKey: 'idem-canc-dup',
            payload: {},
          },
        ],
      };

      const response = await service.push(clinicId, doctorId, dto);
      expect(response.results).toHaveLength(1);
      const result = response.results[0];
      expect(result.status).toBe('APPLIED');
      expect(result.serverVersion).toBe(3);
      expect(cancDoc.save).not.toHaveBeenCalled();
    });
  });

  describe('Invalid and unhandled mutations', () => {
    it('rejects unsupported invoice sync actions', async () => {
      const invoiceId = new Types.ObjectId('672ee0000000000000000060');
      mockInvoiceModel.findOne.mockResolvedValue({
        _id: invoiceId,
        clinicId,
        status: InvoiceStatus.DRAFT,
      });

      const dto: SyncPushDto = {
        mutations: [
          {
            outboxId: 'outbox-invalid-action',
            entityType: SyncEntityType.INVOICE,
            entityId: invoiceId.toHexString(),
            action: 'DELETE' as any,
            clientVersion: 1,
            idempotencyKey: 'idem-invalid-action',
            payload: {},
          },
        ],
      };

      const response = await service.push(clinicId, doctorId, dto);
      expect(response.results).toHaveLength(1);
      const result = response.results[0];
      expect(result.status).toBe('REJECTED');
      expect(result.error).toContain('Unsupported invoice sync action');
    });

    it('rejects unsupported entity types gracefully', async () => {
      const dto: SyncPushDto = {
        mutations: [
          {
            outboxId: 'outbox-unknown-entity',
            entityType: 'UNKNOWN_ENTITY' as any,
            entityId: 'some-id',
            action: SyncActionType.CREATE,
            clientVersion: 1,
            idempotencyKey: 'idem-unknown-entity',
            payload: {},
          },
        ],
      };

      const response = await service.push(clinicId, doctorId, dto);
      expect(response.results).toHaveLength(1);
      const result = response.results[0];
      expect(result.status).toBe('REJECTED');
      expect(result.error).toContain('Unsupported entity type: UNKNOWN_ENTITY');
    });
  });
});
