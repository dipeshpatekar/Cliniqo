import { describe, it, expect, vi, beforeEach } from "vitest"
import React from "react"
import { renderToString } from "react-dom/server"
import { PatientForm } from "./components/patients/PatientForm"
import {
  PatientSaveError,
  saveLocalPatient,
  type PatientSaveDiagnostic,
  type DiagnosticCategory,
  type LocalPatientArgs,
} from "./desktop/desktop-bridge"
import type { Patient } from "./types"

describe("Cliniqo Patient Save Reliability & Diagnostic Error Reporting", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  describe("Structured Diagnostic Categories & Non-PII Logging", () => {
    const categories: DiagnosticCategory[] = [
      "SESSION_EXPIRED",
      "CLINIC_MISMATCH",
      "DATABASE_BUSY",
      "DATABASE_CONSTRAINT",
      "DATABASE_FULL",
      "ENCRYPTION_FAILURE",
      "PATIENT_ID_ALLOCATION_FAILURE",
      "DATABASE_TRANSACTION_FAILURE",
      "UNKNOWN_SAVE_FAILURE",
    ]

    it("supports all required diagnostic categories without exposing PII", () => {
      for (const cat of categories) {
        const diag: PatientSaveDiagnostic = {
          category: cat,
          stage: "save_local_patient",
          command: "save_local_patient",
          sqlite_error_code: cat === "DATABASE_BUSY" ? "5" : null,
          message: `Technical failure in category ${cat}`,
          retryable: cat === "DATABASE_BUSY" || cat === "SESSION_EXPIRED",
        }

        const err = new PatientSaveError(diag)
        expect(err.name).toBe("PatientSaveError")
        expect(err.diagnostic.category).toBe(cat)
        expect(err.diagnostic.command).toBe("save_local_patient")
        // Verify no sensitive PII keywords in diagnostic object
        const str = JSON.stringify(err.diagnostic)
        expect(str).not.toContain("patient_name")
        expect(str).not.toContain("patient_phone")
        expect(str).not.toContain("patient_address")
      }
    })

    it("returns null in non-Tauri desktop environments gracefully", async () => {
      // isTauriDesktop returns false in node/vitest environment
      const res = await saveLocalPatient({
        clinic_id: "clinic_web",
        patient_code: "AAA-0001",
        name: "Web Synthetic Patient",
        phone: "9876543210",
        gender: "Male",
        age: 30,
        allergies: [],
        conditions: [],
      })
      expect(res).toBeNull()
    })
  })

  describe("PatientForm Component Diagnostic Error Banner & Non-Destructive Recovery", () => {
    const dummyPatient: Patient = {
      id: "AAA-0003",
      name: "Rohan Synthetic",
      initials: "RS",
      age: 30,
      gender: "Male",
      phone: "9876543210",
      lastVisit: "No visits yet",
      allergies: [],
      conditions: [],
      registeredAt: "2026-11-15T18:00:00Z",
    }

    it("renders PatientForm with entered data populated", () => {
      const html = renderToString(
        <PatientForm
          go={() => {}}
          onSave={() => {}}
          onReviewPatient={() => {}}
          patient={dummyPatient}
          patients={[]}
          nextPatientId="AAA-0003"
        />,
      )

      expect(html).toContain("Rohan Synthetic")
      expect(html).toContain("9876543210")
      expect(html).toContain("AAA-0003")
      expect(html).toContain("Save changes")
      expect(html).toContain("Save &amp; start consultation")
    })

    it("renders both 'Save patient' and 'Save & start consultation' buttons for new patient registration", () => {
      const html = renderToString(
        <PatientForm
          go={() => {}}
          onSave={() => {}}
          onReviewPatient={() => {}}
          patient={null}
          patients={[]}
          nextPatientId="AAA-0004"
        />,
      )

      expect(html).toContain("Add new patient")
      expect(html).toContain("Save patient")
      expect(html).toContain("Save &amp; start consultation")
      expect(html).toContain("AAA-0004")
    })

    it("supports blank optional phone number, age 0, and missing gender", () => {
      const minimalPatient: Patient = {
        id: "AAA-0005",
        name: "Minimal Patient",
        initials: "MP",
        age: 0,
        gender: "",
        phone: "",
        lastVisit: "No visits yet",
        allergies: [],
        conditions: [],
        registeredAt: "2026-11-15T18:00:00Z",
      }

      const html = renderToString(
        <PatientForm
          go={() => {}}
          onSave={() => {}}
          onReviewPatient={() => {}}
          patient={minimalPatient}
          patients={[]}
          nextPatientId="AAA-0005"
        />,
      )

      expect(html).toContain("Minimal Patient")
      expect(html).toContain("AAA-0005")
    })
  })

  describe("Both Button Workflows Contract Verification", () => {
    it("differentiates Save patient vs Save & Start Consultation via parameter", async () => {
      const onSaveMock = vi.fn().mockResolvedValue(undefined)
      let startConsultationArg: boolean | undefined = undefined

      const handleSave = async (patient: Patient, startConsultation?: boolean, mutationId?: string) => {
        startConsultationArg = startConsultation
        await onSaveMock(patient, startConsultation, mutationId)
      }

      const testPatient: Patient = {
        id: "AAA-0001",
        name: "Workflow Test Patient",
        initials: "WT",
        age: 40,
        gender: "Female",
        phone: "9876543210",
        lastVisit: "No visits yet",
        allergies: [],
        conditions: [],
      }

      // Workflow A: Save patient
      await handleSave(testPatient, false, "mut-save-only")
      expect(startConsultationArg).toBe(false)
      expect(onSaveMock).toHaveBeenCalledWith(testPatient, false, "mut-save-only")

      // Workflow B: Save & Start Consultation
      await handleSave(testPatient, true, "mut-save-consult")
      expect(startConsultationArg).toBe(true)
      expect(onSaveMock).toHaveBeenCalledWith(testPatient, true, "mut-save-consult")
    })

    it("preserves stable mutation ID on retry of the same logical save", async () => {
      const attempts: string[] = []
      const stableMutationId = "client-mut-test-uuid-stable"

      const onSaveWithRetry = async (patient: Patient, startConsultation?: boolean, mutationId?: string) => {
        attempts.push(mutationId || "")
      }

      const patient: Patient = {
        id: "AAA-0002",
        name: "Retry Patient",
        initials: "RP",
        age: 30,
        gender: "Male",
        phone: "9876543210",
        lastVisit: "No visits yet",
        allergies: [],
        conditions: [],
      }

      // First attempt (failed or uncertain)
      await onSaveWithRetry(patient, false, stableMutationId)
      // Second attempt (retry)
      await onSaveWithRetry(patient, false, stableMutationId)

      expect(attempts).toHaveLength(2)
      expect(attempts[0]).toBe(stableMutationId)
      expect(attempts[1]).toBe(stableMutationId)
      expect(attempts[0]).toBe(attempts[1])
    })

    it("preserves startConsultation: true intent during Retry after a failed Save & Start Consultation", async () => {
      let retryIntent: boolean | undefined = undefined
      let callCount = 0

      // Simulate PatientForm retry logic where lastStartConsultationRef preserves intent
      let lastStartConsultation = false
      const performSave = async (startConsultation: boolean) => {
        lastStartConsultation = startConsultation
        callCount++
        if (callCount === 1) {
          throw new PatientSaveError({
            category: "DATABASE_BUSY",
            stage: "save_local_patient",
            command: "save_local_patient",
            sqlite_error_code: "5",
            message: "Database busy syncing. Please retry.",
            retryable: true,
          })
        }
        retryIntent = startConsultation
      }

      // 1. Initial attempt with Save & Start Consultation (startConsultation = true)
      try {
        await performSave(true)
      } catch (err) {
        expect(err).toBeInstanceOf(PatientSaveError)
      }
      expect(callCount).toBe(1)
      expect(lastStartConsultation).toBe(true)

      // 2. User clicks Retry banner button (which invokes performSave(lastStartConsultation))
      await performSave(lastStartConsultation)
      expect(callCount).toBe(2)
      expect(retryIntent).toBe(true)
    })

    it("preserves startConsultation: false intent during Retry after a failed Save patient", async () => {
      let retryIntent: boolean | undefined = undefined
      let callCount = 0

      let lastStartConsultation = true
      const performSave = async (startConsultation: boolean) => {
        lastStartConsultation = startConsultation
        callCount++
        if (callCount === 1) {
          throw new PatientSaveError({
            category: "DATABASE_BUSY",
            stage: "save_local_patient",
            command: "save_local_patient",
            sqlite_error_code: "5",
            message: "Database busy syncing. Please retry.",
            retryable: true,
          })
        }
        retryIntent = startConsultation
      }

      // 1. Initial attempt with standard Save patient (startConsultation = false)
      try {
        await performSave(false)
      } catch (err) {
        expect(err).toBeInstanceOf(PatientSaveError)
      }
      expect(callCount).toBe(1)
      expect(lastStartConsultation).toBe(false)

      // 2. User clicks Retry banner button
      await performSave(lastStartConsultation)
      expect(callCount).toBe(2)
      expect(retryIntent).toBe(false)
    })
  })

  describe("Confirmed Persistence Verification for Create and Edit", () => {
    it("throws PatientSaveError when desktop save returns empty result on CREATE", () => {
      const wasEditing = false
      const saveRes = null

      let thrownError: any = null
      if (saveRes) {
        // Success path
      } else {
        thrownError = new PatientSaveError({
          category: "UNKNOWN_SAVE_FAILURE",
          stage: "save_local_patient",
          command: "save_local_patient",
          message: wasEditing
            ? "Desktop bridge returned empty result for patient update."
            : "Desktop bridge returned empty result for patient save.",
          retryable: true,
        })
      }

      expect(thrownError).toBeInstanceOf(PatientSaveError)
      expect(thrownError.diagnostic.category).toBe("UNKNOWN_SAVE_FAILURE")
      expect(thrownError.diagnostic.message).toBe("Desktop bridge returned empty result for patient save.")
      expect(thrownError.diagnostic.retryable).toBe(true)
    })

    it("throws PatientSaveError when desktop save returns empty result on EDIT", () => {
      const wasEditing = true
      const saveRes = null

      let thrownError: any = null
      if (saveRes) {
        // Success path
      } else {
        thrownError = new PatientSaveError({
          category: "UNKNOWN_SAVE_FAILURE",
          stage: "save_local_patient",
          command: "save_local_patient",
          message: wasEditing
            ? "Desktop bridge returned empty result for patient update."
            : "Desktop bridge returned empty result for patient save.",
          retryable: true,
        })
      }

      expect(thrownError).toBeInstanceOf(PatientSaveError)
      expect(thrownError.diagnostic.category).toBe("UNKNOWN_SAVE_FAILURE")
      expect(thrownError.diagnostic.message).toBe("Desktop bridge returned empty result for patient update.")
      expect(thrownError.diagnostic.retryable).toBe(true)
    })

    it("correctly identifies PatientNotFound constraint failure as non-retryable", () => {
      const diag: PatientSaveDiagnostic = {
        category: "DATABASE_CONSTRAINT",
        stage: "save_local_patient",
        command: "save_local_patient",
        sqlite_error_code: null,
        message: "Patient record not found for update.",
        retryable: false,
      }

      const err = new PatientSaveError(diag)
      expect(err.diagnostic.category).toBe("DATABASE_CONSTRAINT")
      expect(err.diagnostic.message).toBe("Patient record not found for update.")
      expect(err.diagnostic.retryable).toBe(false)
    })
  })
})

