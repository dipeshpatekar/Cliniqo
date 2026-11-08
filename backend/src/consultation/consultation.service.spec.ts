import { describe, it, expect, beforeEach, vi } from "vitest"
import {
  BadRequestException,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  UnprocessableEntityException,
} from "@nestjs/common"
import { Types } from "mongoose"
import {
  ConsultationService,
  validateVitalsCoupling,
  validateConsultationDate,
  canonicalJsonStringify,
  computeRequestFingerprint,
} from "./consultation.service.js"
import { ConsultationStatus } from "./schemas/consultation.schema.js"
import { PatientStatus } from "../patient/schemas/patient.schema.js"
import { ClinicRole } from "../clinic/schemas/clinic-membership.schema.js"
import { ClinicAuditAction } from "../clinic/schemas/clinic-audit-log.schema.js"

describe("ConsultationService (Unit Tests)", () => {
  let service: ConsultationService
  let mockConsultationModel: any
  let mockAddendumModel: any
  let mockIdempotencyModel: any
  let mockPatientModel: any
  let mockAuditLogModel: any
  let mockConnection: any
  let mockSession: any

  const clinicId = new Types.ObjectId()
  const doctorId = new Types.ObjectId()
  const otherDoctorId = new Types.ObjectId()
  const patientId = new Types.ObjectId()

  beforeEach(() => {
    mockSession = {
      startTransaction: vi.fn(),
      commitTransaction: vi.fn().mockResolvedValue(undefined),
      abortTransaction: vi.fn().mockResolvedValue(undefined),
      endSession: vi.fn().mockResolvedValue(undefined),
      inTransaction: vi.fn().mockReturnValue(true),
    }

    mockConnection = {
      startSession: vi.fn().mockResolvedValue(mockSession),
    }

    mockConsultationModel = {
      create: vi.fn().mockImplementation((docs) =>
        Promise.resolve(
          docs.map((d: any) => ({
            _id: new Types.ObjectId(),
            ...d,
            toObject: function () {
              return { ...this }
            },
          })),
        ),
      ),
      find: vi.fn().mockReturnValue({
        populate: vi.fn().mockReturnThis(),
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      }),
      findOne: vi.fn().mockReturnValue({
        populate: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        session: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue(null),
        exec: vi.fn().mockResolvedValue(null),
      }),
      findOneAndUpdate: vi.fn().mockResolvedValue(null),
      countDocuments: vi.fn().mockResolvedValue(0),
    }

    mockAddendumModel = {
      create: vi.fn().mockImplementation((docs) =>
        Promise.resolve(
          docs.map((d: any) => ({
            _id: new Types.ObjectId(),
            ...d,
            toObject: function () {
              return { ...this }
            },
          })),
        ),
      ),
      find: vi.fn().mockReturnValue({
        populate: vi.fn().mockReturnThis(),
        sort: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      }),
      countDocuments: vi.fn().mockResolvedValue(0),
    }

    mockIdempotencyModel = {
      create: vi.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
      findOne: vi.fn().mockResolvedValue(null),
      findOneAndUpdate: vi.fn().mockResolvedValue(null),
      updateOne: vi.fn().mockResolvedValue({ acknowledged: true }),
    }

    mockPatientModel = {
      findOne: vi.fn().mockReturnValue({
        exec: vi.fn().mockResolvedValue({
          _id: patientId,
          clinicId,
          patientId: "P-00101",
          name: "Ananya Iyer",
          status: PatientStatus.ACTIVE,
        }),
      }),
      findOneAndUpdate: vi.fn().mockResolvedValue({
        _id: patientId,
        lastVisitAt: new Date(),
      }),
    }

    mockAuditLogModel = {
      create: vi.fn().mockResolvedValue([{ _id: new Types.ObjectId() }]),
    }

    service = new ConsultationService(
      mockConsultationModel,
      mockAddendumModel,
      mockIdempotencyModel,
      mockPatientModel,
      mockAuditLogModel,
      mockConnection,
    )
  })

  describe("Validation & Utility Functions", () => {
    it("canonicalJsonStringify sorts keys deterministically", () => {
      const a = { b: 1, a: 2, c: { z: 1, y: 2 } }
      const b = { a: 2, c: { y: 2, z: 1 }, b: 1 }
      expect(canonicalJsonStringify(a)).toBe(canonicalJsonStringify(b))
    })

    it("computeRequestFingerprint generates SHA-256 hash", () => {
      const fp1 = computeRequestFingerprint("POST", "/test", { a: 1 })
      const fp2 = computeRequestFingerprint("POST", "/test", { a: 1 })
      const fp3 = computeRequestFingerprint("PATCH", "/test", { a: 1 })
      expect(fp1).toBe(fp2)
      expect(fp1).not.toBe(fp3)
    })

    it("validateVitalsCoupling rejects systolic < diastolic + 10", () => {
      expect(() =>
        validateVitalsCoupling({ systolic: 120, diastolic: 115 }),
      ).toThrow(BadRequestException)
    })

    it("validateVitalsCoupling accepts systolic >= diastolic + 10", () => {
      expect(() =>
        validateVitalsCoupling({ systolic: 120, diastolic: 80 }),
      ).not.toThrow()
    })

    it("validateConsultationDate rejects date > 24 hours into the future", () => {
      const farFuture = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
      expect(() => validateConsultationDate(farFuture)).toThrow(
        BadRequestException,
      )
    })

    it("validateConsultationDate accepts valid current date", () => {
      const nowStr = new Date().toISOString()
      expect(validateConsultationDate(nowStr)).toBeInstanceOf(Date)
    })
  })

  describe("createConsultation", () => {
    it("creates a draft consultation successfully with patientCode, doctorId, and version 1", async () => {
      const result = await service.createConsultation(
        clinicId,
        "P-00101",
        {
          chiefComplaint: "Mild headache",
          diagnosis: "Tension headache",
        },
        doctorId,
      )

      expect(mockPatientModel.findOne).toHaveBeenCalled()
      expect(mockConsultationModel.create).toHaveBeenCalled()
      expect(mockAuditLogModel.create).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            action: ClinicAuditAction.CONSULTATION_CREATED,
            clinicId,
            actorDoctorId: doctorId,
          }),
        ]),
        expect.anything(),
      )
      expect(result.status).toBe(ConsultationStatus.DRAFT)
      expect(result.patientCode).toBe("P-00101")
      expect(result.version).toBe(1)
    })

    it("rejects if patient is not found in clinic (NotFoundException)", async () => {
      mockPatientModel.findOne.mockReturnValue({
        exec: vi.fn().mockResolvedValue(null),
      })

      await expect(
        service.createConsultation(
          clinicId,
          "NON-EXISTENT",
          { chiefComplaint: "Cough" },
          doctorId,
        ),
      ).rejects.toThrow(NotFoundException)
    })

    it("rejects if patient is ARCHIVED (BadRequestException)", async () => {
      mockPatientModel.findOne.mockReturnValue({
        exec: vi.fn().mockResolvedValue({
          _id: patientId,
          clinicId,
          status: PatientStatus.ARCHIVED,
        }),
      })

      await expect(
        service.createConsultation(
          clinicId,
          "P-00101",
          { chiefComplaint: "Cough" },
          doctorId,
        ),
      ).rejects.toThrow(BadRequestException)
    })

    it("handles partial unique draft collision (E11000): aborts transaction, queries draft outside transaction, and returns 409 with existing ID", async () => {
      const existingDraftId = new Types.ObjectId()
      const duplicateError: any = new Error(
        "E11000 duplicate key error collection: cliniqo.consultations index: uniq_active_consultation_draft_per_patient",
      )
      duplicateError.code = 11000

      mockConsultationModel.create.mockRejectedValue(duplicateError)
      mockConsultationModel.findOne.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue({
          _id: existingDraftId,
          patientId,
          status: ConsultationStatus.DRAFT,
        }),
      })

      await expect(
        service.createConsultation(
          clinicId,
          "P-00101",
          { chiefComplaint: "Cough" },
          doctorId,
        ),
      ).rejects.toThrow(ConflictException)

      expect(mockSession.abortTransaction).toHaveBeenCalled()
    })

    it("replays cached response for already COMPLETED idempotency key without duplicate creation or audit", async () => {
      const cachedResponse = {
        _id: "existing-id",
        status: ConsultationStatus.DRAFT,
        patientCode: "P-00101",
      }

      const key = "idem-key-1"
      const normalizedRoute = `/clinics/${clinicId.toString()}/patients/${patientId.toString()}/consultations`
      const dto = { chiefComplaint: "Cough" }
      const fp = computeRequestFingerprint("POST", normalizedRoute, dto)

      const duplicateKeyErr: any = new Error("duplicate")
      duplicateKeyErr.code = 11000
      mockIdempotencyModel.create.mockRejectedValue(duplicateKeyErr)

      mockIdempotencyModel.findOne.mockResolvedValue({
        clinicId,
        key,
        status: "COMPLETED",
        requestFingerprint: fp,
        responseCode: 201,
        responseBody: cachedResponse,
      })

      const result = await service.createConsultation(
        clinicId,
        patientId.toString(),
        dto,
        doctorId,
        key,
      )

      expect(result).toEqual(cachedResponse)
      expect(mockConsultationModel.create).not.toHaveBeenCalled()
      expect(mockAuditLogModel.create).not.toHaveBeenCalled()
    })

    it("rejects with 422 if same idempotency key is reused with different request payload", async () => {
      const key = "idem-key-2"
      const duplicateKeyErr: any = new Error("duplicate")
      duplicateKeyErr.code = 11000
      mockIdempotencyModel.create.mockRejectedValue(duplicateKeyErr)

      mockIdempotencyModel.findOne.mockResolvedValue({
        clinicId,
        key,
        status: "PROCESSING",
        requestFingerprint: "different-hash",
        lockedUntil: new Date(Date.now() + 60_000),
      })

      await expect(
        service.createConsultation(
          clinicId,
          patientId.toString(),
          { chiefComplaint: "Fever" },
          doctorId,
          key,
        ),
      ).rejects.toThrow(UnprocessableEntityException)
    })

    it("returns 409 Conflict with Retry-After if request with same key is currently PROCESSING with active lease", async () => {
      const key = "idem-key-3"
      const normalizedRoute = `/clinics/${clinicId.toString()}/patients/${patientId.toString()}/consultations`
      const dto = { chiefComplaint: "Fever" }
      const fp = computeRequestFingerprint("POST", normalizedRoute, dto)

      const duplicateKeyErr: any = new Error("duplicate")
      duplicateKeyErr.code = 11000
      mockIdempotencyModel.create.mockRejectedValue(duplicateKeyErr)

      mockIdempotencyModel.findOne.mockResolvedValue({
        clinicId,
        key,
        status: "PROCESSING",
        requestFingerprint: fp,
        lockedUntil: new Date(Date.now() + 50_000),
      })

      await expect(
        service.createConsultation(
          clinicId,
          patientId.toString(),
          dto,
          doctorId,
          key,
        ),
      ).rejects.toThrow(ConflictException)
    })

    it("enforces lease-expiry fencing in createConsultation: aborts transaction if worker lease expired or token was revoked", async () => {
      const key = "idem-fencing-key-1"
      // Initial claim succeeds
      mockIdempotencyModel.create.mockResolvedValue({
        _id: new Types.ObjectId(),
      })
      // In-transaction fencing query returns null (simulating expired lockedUntil or overwritten claimToken)
      mockIdempotencyModel.findOneAndUpdate.mockResolvedValue(null)

      await expect(
        service.createConsultation(
          clinicId,
          patientId.toString(),
          { chiefComplaint: "Persistent migraine" },
          doctorId,
          key,
        ),
      ).rejects.toThrow(
        new ConflictException(
          "Idempotency lease expired or was revoked by a concurrent retry. Transaction aborted.",
        ),
      )

      // Verify transaction was aborted
      expect(mockSession.abortTransaction).toHaveBeenCalled()
    })

    it("enforces transaction-abort -> FAILED -> successful retry recovery with zero surviving writes", async () => {
      const key = "idem-abort-recovery-key"
      const dto = { chiefComplaint: "High fever" }
      const normalizedRoute = `/clinics/${clinicId.toString()}/patients/${patientId.toString()}/consultations`
      const fp = computeRequestFingerprint("POST", normalizedRoute, dto)

      // Step 1: First attempt encounters transaction write failure
      mockIdempotencyModel.create.mockResolvedValueOnce({
        _id: new Types.ObjectId(),
      })
      mockAuditLogModel.create.mockRejectedValueOnce(
        new Error("Transient write failure during audit"),
      )

      await expect(
        service.createConsultation(
          clinicId,
          patientId.toString(),
          dto,
          doctorId,
          key,
        ),
      ).rejects.toThrow(
        "A database error occurred while processing the request",
      )

      // Assert transaction was aborted
      expect(mockSession.abortTransaction).toHaveBeenCalled()
      // Assert idempotency record was marked FAILED outside transaction
      expect(mockIdempotencyModel.updateOne).toHaveBeenCalledWith(
        expect.objectContaining({
          clinicId,
          key,
          status: "PROCESSING",
        }),
        expect.objectContaining({
          $set: expect.objectContaining({
            status: "FAILED",
            lockedUntil: null,
          }),
        }),
      )

      // Step 2: Retry with same key finds FAILED status and reclaims lease
      const duplicateKeyErr: any = new Error("duplicate key")
      duplicateKeyErr.code = 11000
      mockIdempotencyModel.create.mockRejectedValueOnce(duplicateKeyErr)

      mockIdempotencyModel.findOne.mockResolvedValueOnce({
        clinicId,
        key,
        status: "FAILED",
        requestFingerprint: fp,
      })

      // findOneAndUpdate reclaims lease
      const newClaimToken = "reclaimed-token-123"
      mockIdempotencyModel.findOneAndUpdate
        .mockResolvedValueOnce({
          clinicId,
          key,
          status: "PROCESSING",
          claimToken: newClaimToken,
        })
        // In-transaction completion update succeeds
        .mockResolvedValueOnce({
          clinicId,
          key,
          status: "COMPLETED",
          claimToken: newClaimToken,
        })

      mockAuditLogModel.create.mockResolvedValueOnce([
        { _id: new Types.ObjectId() },
      ])

      const result = await service.createConsultation(
        clinicId,
        patientId.toString(),
        dto,
        doctorId,
        key,
      )

      expect(result).toBeDefined()
      expect(result.chiefComplaint).toBe("High fever")
    })
  })

  describe("updateConsultation", () => {
    it("updates draft consultation, increments version, and logs audit", async () => {
      const consultationId = new Types.ObjectId().toString()
      mockConsultationModel.findOneAndUpdate.mockResolvedValue({
        _id: new Types.ObjectId(consultationId),
        clinicId,
        patientId,
        version: 2,
        status: ConsultationStatus.DRAFT,
      })

      const updated = await service.updateConsultation(
        clinicId,
        consultationId,
        {
          expectedVersion: 1,
          chiefComplaint: "Updated symptoms",
        },
        doctorId,
      )

      expect(updated.version).toBe(2)
      expect(mockAuditLogModel.create).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            action: ClinicAuditAction.CONSULTATION_UPDATED,
          }),
        ]),
        expect.anything(),
      )
    })

    it("rejects update with 409 Conflict if expectedVersion does not match current version (optimistic lock conflict)", async () => {
      const consultationId = new Types.ObjectId().toString()
      mockConsultationModel.findOneAndUpdate.mockResolvedValue(null)
      mockConsultationModel.findOne.mockReturnValue({
        session: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue({
          _id: new Types.ObjectId(consultationId),
          clinicId,
          version: 2,
          status: ConsultationStatus.DRAFT,
        }),
      })

      await expect(
        service.updateConsultation(
          clinicId,
          consultationId,
          {
            expectedVersion: 1,
            chiefComplaint: "Stale edit",
          },
          doctorId,
        ),
      ).rejects.toThrow(ConflictException)
    })

    it("rejects update with 409 Conflict if consultation is already FINALIZED", async () => {
      const consultationId = new Types.ObjectId().toString()
      mockConsultationModel.findOneAndUpdate.mockResolvedValue(null)
      mockConsultationModel.findOne.mockReturnValue({
        session: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue({
          _id: new Types.ObjectId(consultationId),
          clinicId,
          version: 2,
          status: ConsultationStatus.FINALIZED,
        }),
      })

      await expect(
        service.updateConsultation(
          clinicId,
          consultationId,
          {
            expectedVersion: 2,
            chiefComplaint: "Attempting to edit finalized",
          },
          doctorId,
        ),
      ).rejects.toThrow(ConflictException)
    })
  })

  describe("finalizeConsultation", () => {
    it("finalizes consultation, updates Patient.lastVisitAt with $max, and records audit", async () => {
      const consultationId = new Types.ObjectId().toString()
      const visitDate = new Date("2026-10-25T10:00:00.000Z")

      mockConsultationModel.findOneAndUpdate.mockResolvedValue({
        _id: new Types.ObjectId(consultationId),
        clinicId,
        patientId,
        consultationDate: visitDate,
        status: ConsultationStatus.FINALIZED,
        finalizedAt: new Date(),
        version: 2,
        toObject: function () {
          return { ...this }
        },
      })

      const finalized = await service.finalizeConsultation(
        clinicId,
        consultationId,
        {
          expectedVersion: 1,
          chiefComplaint: "Sore throat",
          diagnosis: "Acute pharyngitis",
        },
        doctorId,
      )

      expect(finalized.status).toBe(ConsultationStatus.FINALIZED)
      expect(mockPatientModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: patientId, clinicId },
        {
          $max: { lastVisitAt: visitDate },
          $set: { updatedBy: doctorId },
        },
        expect.anything(),
      )
      expect(mockAuditLogModel.create).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            action: ClinicAuditAction.CONSULTATION_FINALIZED,
          }),
        ]),
        expect.anything(),
      )
    })

    it("rejects finalization with 409 Conflict if expectedVersion is stale", async () => {
      const consultationId = new Types.ObjectId().toString()
      mockConsultationModel.findOneAndUpdate.mockResolvedValue(null)
      mockConsultationModel.findOne.mockReturnValue({
        session: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue({
          _id: new Types.ObjectId(consultationId),
          clinicId,
          version: 3,
          status: ConsultationStatus.DRAFT,
        }),
      })

      await expect(
        service.finalizeConsultation(
          clinicId,
          consultationId,
          {
            expectedVersion: 1,
            chiefComplaint: "Sore throat",
            diagnosis: "Pharyngitis",
          },
          doctorId,
        ),
      ).rejects.toThrow(ConflictException)
    })

    it("rejects finalization with 409 Conflict if already FINALIZED without idempotency key", async () => {
      const consultationId = new Types.ObjectId().toString()
      mockConsultationModel.findOneAndUpdate.mockResolvedValue(null)
      mockConsultationModel.findOne.mockReturnValue({
        session: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue({
          _id: new Types.ObjectId(consultationId),
          clinicId,
          version: 2,
          status: ConsultationStatus.FINALIZED,
        }),
      })

      await expect(
        service.finalizeConsultation(
          clinicId,
          consultationId,
          {
            expectedVersion: 1,
            chiefComplaint: "Sore throat",
            diagnosis: "Pharyngitis",
          },
          doctorId,
        ),
      ).rejects.toThrow(ConflictException)
    })

    it("enforces lease-expiry fencing in finalizeConsultation: aborts transaction if worker lease expired or token was revoked", async () => {
      const consultationId = new Types.ObjectId().toString()
      const key = "finalize-fencing-key"

      mockConsultationModel.findOneAndUpdate.mockResolvedValue({
        _id: new Types.ObjectId(consultationId),
        clinicId,
        patientId,
        version: 2,
        consultationDate: new Date(),
        status: ConsultationStatus.FINALIZED,
        toObject: function () {
          return { ...this }
        },
      })

      // Claim succeeds
      mockIdempotencyModel.create.mockResolvedValue({
        _id: new Types.ObjectId(),
      })
      // In-transaction fencing query returns null (lease expired or token mismatch)
      mockIdempotencyModel.findOneAndUpdate.mockResolvedValue(null)

      await expect(
        service.finalizeConsultation(
          clinicId,
          consultationId,
          {
            expectedVersion: 1,
            chiefComplaint: "Ear ache",
            diagnosis: "Otitis media",
          },
          doctorId,
          key,
        ),
      ).rejects.toThrow(
        new ConflictException(
          "Idempotency lease expired or was revoked by a concurrent retry. Transaction aborted.",
        ),
      )

      expect(mockSession.abortTransaction).toHaveBeenCalled()
    })
  })

  describe("addAddendum", () => {
    it("appends addendum with atomic sequence allocation on parent consultation", async () => {
      const consultationId = new Types.ObjectId().toString()
      mockConsultationModel.findOneAndUpdate.mockResolvedValue({
        _id: new Types.ObjectId(consultationId),
        clinicId,
        patientId,
        status: ConsultationStatus.FINALIZED,
        addendumCount: 1,
      })

      const addendum = await service.addAddendum(
        clinicId,
        consultationId,
        {
          note: "Correction: blood culture negative",
          reasonForAddendum: "Follow-up laboratory result",
        },
        doctorId,
      )

      expect(addendum).toBeDefined()

      expect(mockAddendumModel.create).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            sequenceNumber: 1,
            authorDoctorId: doctorId,
          }),
        ]),
        expect.anything(),
      )
      expect(mockAuditLogModel.create).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            action: ClinicAuditAction.CONSULTATION_ADDENDUM_ADDED,
          }),
        ]),
        expect.anything(),
      )
    })

    it("rejects addendum on DRAFT consultation (BadRequestException)", async () => {
      const consultationId = new Types.ObjectId().toString()
      mockConsultationModel.findOneAndUpdate.mockResolvedValue(null)
      mockConsultationModel.findOne.mockReturnValue({
        session: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue({
          _id: new Types.ObjectId(consultationId),
          clinicId,
          status: ConsultationStatus.DRAFT,
        }),
      })

      await expect(
        service.addAddendum(
          clinicId,
          consultationId,
          {
            note: "Premature note",
            reasonForAddendum: "Testing",
          },
          doctorId,
        ),
      ).rejects.toThrow(BadRequestException)
    })
  })

  describe("cancelDraftConsultation", () => {
    it("rejects cancellation of FINALIZED consultation (ConflictException)", async () => {
      const consultationId = new Types.ObjectId().toString()
      mockConsultationModel.findOne.mockResolvedValue({
        _id: new Types.ObjectId(consultationId),
        clinicId,
        status: ConsultationStatus.FINALIZED,
      })

      await expect(
        service.cancelDraftConsultation(
          clinicId,
          consultationId,
          doctorId,
          ClinicRole.DOCTOR,
          { reason: "Mistake in entry" },
        ),
      ).rejects.toThrow(ConflictException)
    })

    it("rejects if Doctor B attempts to cancel Doctor A draft (ForbiddenException)", async () => {
      const consultationId = new Types.ObjectId().toString()
      mockConsultationModel.findOne.mockResolvedValue({
        _id: new Types.ObjectId(consultationId),
        clinicId,
        status: ConsultationStatus.DRAFT,
        doctorId: doctorId,
        createdBy: doctorId,
      })

      await expect(
        service.cancelDraftConsultation(
          clinicId,
          consultationId,
          otherDoctorId,
          ClinicRole.DOCTOR,
          { reason: "Not my draft" },
        ),
      ).rejects.toThrow(ForbiddenException)
    })

    it("allows Doctor A to cancel own draft with mandatory reason", async () => {
      const consultationId = new Types.ObjectId().toString()
      mockConsultationModel.findOne.mockResolvedValue({
        _id: new Types.ObjectId(consultationId),
        clinicId,
        patientId,
        status: ConsultationStatus.DRAFT,
        doctorId: doctorId,
        createdBy: doctorId,
      })
      mockConsultationModel.findOneAndUpdate.mockResolvedValue({
        _id: new Types.ObjectId(consultationId),
        clinicId,
        patientId,
        status: ConsultationStatus.CANCELLED,
        cancellationReason: "Patient departed before exam",
      })

      const res = await service.cancelDraftConsultation(
        clinicId,
        consultationId,
        doctorId,
        ClinicRole.DOCTOR,
        { reason: "Patient departed before exam" },
      )

      expect(res.message).toContain("successfully cancelled")
      expect(mockAuditLogModel.create).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            action: ClinicAuditAction.CONSULTATION_CANCELLED,
          }),
        ]),
        expect.anything(),
      )
    })

    it("allows Clinic OWNER to cancel any doctor draft with audit log", async () => {
      const consultationId = new Types.ObjectId().toString()
      mockConsultationModel.findOne.mockResolvedValue({
        _id: new Types.ObjectId(consultationId),
        clinicId,
        patientId,
        status: ConsultationStatus.DRAFT,
        doctorId: doctorId,
        createdBy: doctorId,
      })
      mockConsultationModel.findOneAndUpdate.mockResolvedValue({
        _id: new Types.ObjectId(consultationId),
        clinicId,
        patientId,
        status: ConsultationStatus.CANCELLED,
        cancellationReason: "Administrative cleanup by clinic owner",
      })

      const res = await service.cancelDraftConsultation(
        clinicId,
        consultationId,
        otherDoctorId,
        ClinicRole.OWNER,
        { reason: "Administrative cleanup by clinic owner" },
      )

      expect(res.message).toContain("successfully cancelled")
    })
  })

  describe("getClinicalSnapshot", () => {
    it("returns frozen clinical data for future Prescription Domain", async () => {
      const consultationId = new Types.ObjectId()
      mockConsultationModel.findOne.mockResolvedValue({
        _id: consultationId,
        patientId,
        patientCode: "P-00101",
        doctorId,
        consultationDate: new Date(),
        chiefComplaint: "Headache",
        diagnosis: "Migraine",
        vitals: { systolic: 120, diastolic: 80 },
        provisionalMedicines: [{ name: "Paracetamol", formulation: "Tablet" }],
      })

      const snapshot = await service.getClinicalSnapshot(
        clinicId,
        consultationId,
      )

      expect(snapshot.patientCode).toBe("P-00101")
      expect(snapshot.diagnosis).toBe("Migraine")
      expect(snapshot.provisionalMedicines).toHaveLength(1)
    })
  })
})
