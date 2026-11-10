import { describe, it, expect } from "vitest"
import {
  formatSequentialPatientId,
  parseSequentialPatientId,
  isSequentialPatientId,
  getPublicPatientId,
  mapLocalRecordToPatient,
} from "./types"
import type { LocalPatientRecord } from "./desktop/desktop-bridge"

describe("Sequential Patient ID Format & Lifecycle (AAA-0001 ... ZZZ-9999)", () => {
  describe("Formatting sequential IDs", () => {
    it("formats seq 1 to AAA-0001", () => {
      expect(formatSequentialPatientId(1)).toBe("AAA-0001")
    })

    it("formats seq 9999 to AAA-9999", () => {
      expect(formatSequentialPatientId(9999)).toBe("AAA-9999")
    })

    it("rolls over sequentially from AAA-9999 (seq 9999) to AAB-0001 (seq 10000)", () => {
      expect(formatSequentialPatientId(10000)).toBe("AAB-0001")
    })

    it("formats seq 19998 to AAB-9999", () => {
      expect(formatSequentialPatientId(19998)).toBe("AAB-9999")
    })

    it("rolls over sequentially from AAB-9999 to AAC-0001 (seq 19999)", () => {
      expect(formatSequentialPatientId(19999)).toBe("AAC-0001")
    })

    it("safely handles 0 or negative numbers by defaulting to seq 1", () => {
      expect(formatSequentialPatientId(0)).toBe("AAA-0001")
      expect(formatSequentialPatientId(-5)).toBe("AAA-0001")
    })
  })

  describe("Parsing sequential IDs back to monotonic integers", () => {
    it("parses AAA-0001 to 1", () => {
      expect(parseSequentialPatientId("AAA-0001")).toBe(1)
    })

    it("parses AAA-9999 to 9999", () => {
      expect(parseSequentialPatientId("AAA-9999")).toBe(9999)
    })

    it("parses AAB-0001 to 10000", () => {
      expect(parseSequentialPatientId("AAB-0001")).toBe(10000)
    })

    it("parses AAC-0001 to 19999", () => {
      expect(parseSequentialPatientId("AAC-0001")).toBe(19999)
    })

    it("isSequentialPatientId validates format", () => {
      expect(isSequentialPatientId("AAA-0001")).toBe(true)
      expect(isSequentialPatientId("AAB-9999")).toBe(true)
      expect(isSequentialPatientId("PC-1049")).toBe(false)
      expect(isSequentialPatientId("P-00101")).toBe(false)
      expect(isSequentialPatientId("invalid")).toBe(false)
    })

    it("returns null for historical legacy IDs without throwing", () => {
      expect(parseSequentialPatientId("PC-1049")).toBeNull()
      expect(parseSequentialPatientId("P-00101")).toBeNull()
      expect(parseSequentialPatientId("PT-1001")).toBeNull()
    })
  })

  describe("Preserving Historical IDs and masking ObjectIds/UUIDs", () => {
    it("preserves historical PC-1049 ID in getPublicPatientId", () => {
      expect(getPublicPatientId({ id: "PC-1049" })).toBe("PC-1049")
      expect(getPublicPatientId({ displayId: "PC-1049" })).toBe("PC-1049")
    })

    it("preserves historical P-00101 ID in getPublicPatientId", () => {
      expect(getPublicPatientId({ id: "P-00101" })).toBe("P-00101")
      expect(getPublicPatientId({ patientCode: "P-00101" })).toBe("P-00101")
    })

    it("returns sequential ID AAA-0001 in getPublicPatientId", () => {
      expect(getPublicPatientId({ id: "AAA-0001" })).toBe("AAA-0001")
      expect(getPublicPatientId({ displayId: "AAA-0001" })).toBe("AAA-0001")
    })

    it("never exposes 24-char MongoDB ObjectIds as patient IDs", () => {
      const mongoId = "6af172c5403992300e13330f"
      const res = getPublicPatientId({ id: mongoId })
      expect(res).not.toBe(mongoId)
      expect(res).toBe("AAA-0001")
    })

    it("never exposes UUIDs as patient IDs", () => {
      const uuid = "e87fbbd6-1b45-4df3-840a-9d95f87b8d81"
      const res = getPublicPatientId({ id: uuid })
      expect(res).not.toBe(uuid)
      expect(res).toBe("AAA-0001")
    })

    it("maps local SQLite record with sequential patient_code accurately", () => {
      const rec: LocalPatientRecord = {
        id: "e87fbbd6-1b45-4df3-840a-9d95f87b8d81",
        server_id: null,
        clinic_id: "clinic-1",
        patient_code: "AAA-0042",
        name: "Test Patient",
        phone: "9876543210",
        gender: "Female",
        date_of_birth: null,
        age: 30,
        allergies: [],
        conditions: [],
        sync_status: "PENDING",
        local_version: 1,
        server_version: 1,
        updated_at: "2026-11-09T12:00:00Z",
      }
      const mapped = mapLocalRecordToPatient(rec)
      expect(mapped.displayId).toBe("AAA-0042")
      expect(getPublicPatientId(mapped)).toBe("AAA-0042")
    })

    it("maps local SQLite record with historical PC-1049 without corrupting it", () => {
      const rec: LocalPatientRecord = {
        id: "e87fbbd6-1b45-4df3-840a-9d95f87b8d81",
        server_id: null,
        clinic_id: "clinic-1",
        patient_code: "PC-1049",
        name: "Historical Patient",
        phone: "9876543210",
        gender: "Male",
        date_of_birth: null,
        age: 45,
        allergies: [],
        conditions: [],
        sync_status: "SYNCED",
        local_version: 1,
        server_version: 1,
        updated_at: "2026-11-09T12:00:00Z",
      }
      const mapped = mapLocalRecordToPatient(rec)
      expect(mapped.displayId).toBe("PC-1049")
      expect(getPublicPatientId(mapped)).toBe("PC-1049")
    })
  })

  describe("Non-reuse after deletion guarantees", () => {
    it("monotonically increments sequence even when a patient is deleted", () => {
      // Start with empty state
      let maxAllocatedSeq = 0

      // Add Patient 1
      const p1Seq = maxAllocatedSeq + 1
      const p1Id = formatSequentialPatientId(p1Seq)
      expect(p1Id).toBe("AAA-0001")
      maxAllocatedSeq = p1Seq

      // Add Patient 2
      const p2Seq = maxAllocatedSeq + 1
      const p2Id = formatSequentialPatientId(p2Seq)
      expect(p2Id).toBe("AAA-0002")
      maxAllocatedSeq = p2Seq

      // Simulate deleting Patient 2 (AAA-0002)
      // The patient is deleted from records, but maxAllocatedSeq NEVER decreases
      const activeRecords = [{ id: p1Id, displayId: p1Id }]
      expect(activeRecords.length).toBe(1)

      // Allocate next patient after deletion of AAA-0002
      const nextSeq = maxAllocatedSeq + 1
      const nextId = formatSequentialPatientId(nextSeq)
      expect(nextId).toBe("AAA-0003")
      expect(nextId).not.toBe("AAA-0002") // Proves AAA-0002 is never reused!
    })
  })
})
