import { describe, it, expect, beforeEach, vi } from "vitest"
import { Types } from "mongoose"
import { SyncService } from "./sync.service.js"
import { SyncPushDto } from "./dto/sync-push.dto.js"
import {
  SyncActionType,
  SyncEntityType,
} from "./schemas/sync-change-feed.schema.js"
import { PrescriptionStatus } from "../prescription/schemas/prescription.schema.js"

describe("SyncService Prescription Sync & Revision Workflow", () => {
  let service: SyncService

  let mockConnection: any
  let mockChangeFeedModel: any
  let mockCounterModel: any
  let mockConflictModel: any
  let mockIdempotencyModel: any
  let mockPatientModel: any
  let mockConsultationModel: any
  let mockPrescriptionModel: any
  let mockRevisionModel: any
  let mockSeqCounterModel: any
  let mockInvoiceModel: any

  const clinicId = new Types.ObjectId("672bb0000000000000000001")
  const doctorId = new Types.ObjectId("672aa0000000000000000001")
  const patientId = new Types.ObjectId("672cc0000000000000000001")
  const consultationId = new Types.ObjectId("672dd0000000000000000001")
  const prescriptionServerId = new Types.ObjectId("672ee0000000000000000001")

  let storedPrescription: any = null
  let storedRevisions: any[] = []
  let idempotencyStore: Map<string, any> = new Map()

  beforeEach(() => {
    storedPrescription = null
    storedRevisions = []
    idempotencyStore.clear()

    const mockSession = {
      withTransaction: vi.fn(async (cb: () => Promise<void>) => {
        await cb()
      }),
      endSession: vi.fn(),
    }

    mockConnection = {
      startSession: vi.fn().mockResolvedValue(mockSession),
    }

    mockChangeFeedModel = {
      create: vi.fn().mockResolvedValue([{}]),
      findOne: vi.fn().mockImplementation((filter: any) => {
        if (filter.clientEntityId === "local-c-1") {
          return Promise.resolve({ entityId: consultationId.toHexString() })
        }
        if (filter.clientEntityId === "local-rx-1" && storedPrescription) {
          return Promise.resolve({ entityId: storedPrescription._id.toHexString() })
        }
        return Promise.resolve(null)
      }),
    }

    mockCounterModel = {
      findOneAndUpdate: vi.fn().mockResolvedValue({ lastSeq: 10 }),
    }

    mockConflictModel = {
      create: vi.fn().mockResolvedValue([{}]),
    }

    mockIdempotencyModel = {
      findOne: vi.fn().mockImplementation((filter: any) => {
        return Promise.resolve(idempotencyStore.get(filter.key) || null)
      }),
      findOneAndUpdate: vi.fn().mockImplementation((filter: any, update: any) => {
        const existing = idempotencyStore.get(filter.key) || {}
        const merged = { ...existing, ...update.$set }
        idempotencyStore.set(filter.key, merged)
        return Promise.resolve(merged)
      }),
      updateOne: vi.fn().mockImplementation((filter: any, update: any) => {
        const existing = idempotencyStore.get(filter.key) || {}
        const merged = { ...existing, ...update.$set }
        idempotencyStore.set(filter.key, merged)
        return Promise.resolve({ modifiedCount: 1 })
      }),
    }

    mockPatientModel = {
      findOne: vi.fn().mockResolvedValue({
        _id: patientId,
        clinicId,
        patientId: "PAT-0001",
      }),
    }

    mockConsultationModel = {
      findOne: vi.fn().mockImplementation((filter: any) => {
        if (filter._id && filter._id.equals(consultationId)) {
          return Promise.resolve({
            _id: consultationId,
            clinicId,
            patientId,
            patientCode: "PAT-0001",
            consultationDate: new Date(),
            chiefComplaint: "Fever and cough",
            diagnosis: "Bronchitis",
            save: vi.fn().mockResolvedValue(true),
          })
        }
        return Promise.resolve(null)
      }),
    }

    mockPrescriptionModel = {
      findOne: vi.fn().mockImplementation((filter: any) => {
        if (filter._id && storedPrescription && filter._id.equals(storedPrescription._id)) {
          return Promise.resolve(storedPrescription)
        }
        if (filter.prescriptionNumber && storedPrescription && filter.prescriptionNumber === storedPrescription.prescriptionNumber) {
          return Promise.resolve(storedPrescription)
        }
        return Promise.resolve(null)
      }),
      create: vi.fn().mockImplementation((docs: any[]) => {
        const doc = docs[0]
        storedPrescription = {
          ...doc,
          _id: prescriptionServerId,
          version: doc.version || 1,
          save: vi.fn().mockImplementation(function () {
            return Promise.resolve(this)
          }),
          toObject: function () {
            return { ...this }
          },
        }
        return Promise.resolve([storedPrescription])
      }),
    }

    mockRevisionModel = {
      create: vi.fn().mockImplementation((docs: any[]) => {
        const doc = docs[0]
        const rev = {
          ...doc,
          _id: new Types.ObjectId(),
          toObject: function () {
            return { ...this }
          },
        }
        storedRevisions.push(rev)
        return Promise.resolve([rev])
      }),
    }

    mockSeqCounterModel = {
      findOneAndUpdate: vi.fn().mockResolvedValue({ seq: 1 }),
    }

    mockInvoiceModel = {
      findOne: vi.fn().mockResolvedValue(null),
    }

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
    )
  })

  it("1. Online prescription creation: creates prescription and immutable Revision 1", async () => {
    const dto: SyncPushDto = {
      mutations: [
        {
          outboxId: "outbox-rx-1",
          entityType: SyncEntityType.PRESCRIPTION,
          action: SyncActionType.CREATE,
          entityId: "local-rx-1",
          idempotencyKey: "local-prescription-create-local-rx-1",
          clientVersion: 1,
          payload: {
            consultationId: consultationId.toHexString(),
            patientId: patientId.toHexString(),
            prescriptionNumber: "RX-00001",
            items: [
              {
                id: 1,
                name: "Amoxicillin",
                formulation: "Capsule",
                strength: "500 mg",
                dose: "1 cap",
                frequency: "TDS",
                duration: "5 days",
              },
            ],
          },
        },
      ],
    }

    const response = await service.push(clinicId, doctorId, dto)

    expect(response.results).toHaveLength(1)
    const result = response.results[0]
    expect(result.status).toBe("APPLIED")
    expect(result.serverId).toBe(prescriptionServerId.toHexString())
    expect(result.serverVersion).toBe(1)

    // Verify stored parent prescription
    expect(storedPrescription).not.toBeNull()
    expect(storedPrescription.currentRevisionNumber).toBe(1)
    expect(storedPrescription.status).toBe(PrescriptionStatus.ACTIVE)

    // Verify Revision 1 created
    expect(storedRevisions).toHaveLength(1)
    expect(storedRevisions[0].revisionNumber).toBe(1)
    expect(storedRevisions[0].items[0].name).toBe("Amoxicillin")

    // Verify change feed was created
    expect(mockChangeFeedModel.create).toHaveBeenCalled()
  })

  it("2. Online prescription revision: increments revision number, stores Revision 2, preserves Revision 1", async () => {
    // Seed existing Revision 1
    storedPrescription = {
      _id: prescriptionServerId,
      clinicId,
      consultationId,
      patientId,
      patientCode: "PAT-0001",
      prescriptionNumber: "RX-00001",
      status: PrescriptionStatus.ACTIVE,
      currentRevisionNumber: 1,
      version: 1,
      save: vi.fn().mockImplementation(function () {
        return Promise.resolve(this)
      }),
      toObject: function () {
        return { ...this }
      },
    }
    storedRevisions = [
      {
        _id: new Types.ObjectId(),
        prescriptionId: prescriptionServerId,
        revisionNumber: 1,
        items: [{ id: 1, name: "Amoxicillin", formulation: "Capsule", strength: "500 mg" }],
        toObject: function () {
          return { ...this }
        },
      },
    ]

    const dto: SyncPushDto = {
      mutations: [
        {
          outboxId: "outbox-rx-rev2",
          entityType: SyncEntityType.PRESCRIPTION,
          action: SyncActionType.REVISE,
          entityId: "local-rx-rev2",
          serverId: prescriptionServerId.toHexString(),
          idempotencyKey: "prescription-revise-local-rx-rev2-r2",
          clientVersion: 1,
          payload: {
            prescriptionId: prescriptionServerId.toHexString(),
            expectedRevisionNumber: 1,
            expectedVersion: 1,
            reasonForRevision: "Adjusted dose and added Cetirizine",
            items: [
              { id: 1, name: "Amoxicillin", formulation: "Capsule", strength: "500 mg" },
              { id: 2, name: "Cetirizine", formulation: "Tablet", strength: "10 mg" },
            ],
          },
        },
      ],
    }

    const response = await service.push(clinicId, doctorId, dto)

    expect(response.results).toHaveLength(1)
    const result = response.results[0]
    expect(result.status).toBe("APPLIED")
    expect(result.serverVersion).toBe(2)

    // Verify parent prescription updated to Revision 2
    expect(storedPrescription.currentRevisionNumber).toBe(2)
    expect(storedPrescription.version).toBe(2)

    // Verify Revision 1 remains unchanged in storedRevisions
    expect(storedRevisions).toHaveLength(2)
    expect(storedRevisions[0].revisionNumber).toBe(1)
    expect(storedRevisions[0].items).toHaveLength(1)
    expect(storedRevisions[0].items[0].name).toBe("Amoxicillin")

    // Verify Revision 2 has updated medicines
    expect(storedRevisions[1].revisionNumber).toBe(2)
    expect(storedRevisions[1].reasonForRevision).toBe("Adjusted dose and added Cetirizine")
    expect(storedRevisions[1].items).toHaveLength(2)
    expect(storedRevisions[1].items[1].name).toBe("Cetirizine")
  })

  it("3. Idempotency: duplicate retry returns cached APPLIED result without creating extra revision", async () => {
    // Seed existing Revision 1
    storedPrescription = {
      _id: prescriptionServerId,
      clinicId,
      consultationId,
      patientId,
      patientCode: "PAT-0001",
      prescriptionNumber: "RX-00001",
      status: PrescriptionStatus.ACTIVE,
      currentRevisionNumber: 1,
      version: 1,
      save: vi.fn().mockImplementation(function () {
        return Promise.resolve(this)
      }),
      toObject: function () {
        return { ...this }
      },
    }

    const dto: SyncPushDto = {
      mutations: [
        {
          outboxId: "outbox-rx-rev2",
          entityType: SyncEntityType.PRESCRIPTION,
          action: SyncActionType.REVISE,
          entityId: "local-rx-rev2",
          serverId: prescriptionServerId.toHexString(),
          idempotencyKey: "prescription-revise-local-rx-rev2-r2",
          clientVersion: 1,
          payload: {
            expectedRevisionNumber: 1,
            expectedVersion: 1,
            reasonForRevision: "First attempt",
            items: [{ id: 1, name: "Paracetamol", formulation: "Tablet", strength: "650 mg" }],
          },
        },
      ],
    }

    // First attempt
    const res1 = await service.push(clinicId, doctorId, dto)
    expect(res1.results[0].status).toBe("APPLIED")
    expect(storedRevisions).toHaveLength(1)

    // Second attempt (retry with same idempotencyKey and same payload)
    const res2 = await service.push(clinicId, doctorId, dto)
    expect(res2.results[0].status).toBe("APPLIED")
    expect(res2.results[0].serverVersion).toBe(2)

    // Revisions must still be 1 (no duplicate revision created on retry)
    expect(storedRevisions).toHaveLength(1)
  })

  it("4. Concurrency conflict: detects stale expected revision numbers and rejects silent overwrite", async () => {
    // Server is already at Revision 2
    storedPrescription = {
      _id: prescriptionServerId,
      clinicId,
      consultationId,
      patientId,
      patientCode: "PAT-0001",
      prescriptionNumber: "RX-00001",
      status: PrescriptionStatus.ACTIVE,
      currentRevisionNumber: 2,
      version: 2,
      save: vi.fn().mockImplementation(function () {
        return Promise.resolve(this)
      }),
      toObject: function () {
        return { ...this }
      },
    }

    // Client tries to revise with stale expectedRevisionNumber = 1
    const dto: SyncPushDto = {
      mutations: [
        {
          outboxId: "outbox-stale",
          entityType: SyncEntityType.PRESCRIPTION,
          action: SyncActionType.REVISE,
          entityId: "local-rx-stale",
          serverId: prescriptionServerId.toHexString(),
          idempotencyKey: "prescription-revise-stale-r2",
          clientVersion: 1,
          payload: {
            expectedRevisionNumber: 1,
            expectedVersion: 1,
            reasonForRevision: "Conflicting revision",
            items: [{ id: 1, name: "Aspirin", formulation: "Tablet", strength: "100 mg" }],
          },
        },
      ],
    }

    const response = await service.push(clinicId, doctorId, dto)

    expect(response.results).toHaveLength(1)
    const result = response.results[0]
    expect(result.status).toBe("CONFLICT")
    expect(result.conflictDetails?.conflictReason).toBe("CONCURRENT_REVISION_COLLISION")
    expect(result.conflictDetails?.serverVersion).toBe(2)

    // Server prescription must not have been modified
    expect(storedPrescription.currentRevisionNumber).toBe(2)
    expect(mockConflictModel.create).toHaveBeenCalled()
  })

  it("5. Offline UUID consultationId resolution: resolves clientEntityId via changeFeed", async () => {
    const dto: SyncPushDto = {
      mutations: [
        {
          outboxId: "outbox-offline-rx",
          entityType: SyncEntityType.PRESCRIPTION,
          action: SyncActionType.CREATE,
          entityId: "local-rx-offline",
          idempotencyKey: "local-prescription-create-offline-1",
          clientVersion: 1,
          payload: {
            consultationId: "local-c-1", // Local offline UUID resolved via changeFeed
            itemsJson: JSON.stringify([
              { id: 1, name: "Azithromycin", formulation: "Tablet", strength: "500 mg" },
            ]),
          },
        },
      ],
    }

    const response = await service.push(clinicId, doctorId, dto)

    expect(response.results).toHaveLength(1)
    expect(response.results[0].status).toBe("APPLIED")
    expect(storedPrescription).not.toBeNull()
    expect(storedRevisions).toHaveLength(1)
    expect(storedRevisions[0].items[0].name).toBe("Azithromycin")
  })
})
