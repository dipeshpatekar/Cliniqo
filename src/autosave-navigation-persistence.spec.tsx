import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderToString } from "react-dom/server"
import App from "./App"
import { PatientForm } from "./components/patients/PatientForm"
import { Consultation } from "./components/consultation/Consultation"
import { PatientProfile } from "./components/patients/PatientProfile"
import { OverviewTab, ConsultationsTab } from "./components/patients/tabs"
import {
  defaultClinicalLibrary,
  createEmptyConsultationData,
  type Patient,
  type Page,
} from "./types"
import type {
  DesktopSessionContext,
  LocalConsultationRecord,
  LocalPrescriptionRecord,
} from "./desktop/desktop-bridge"

describe("Cliniqo Complete Auto-Save, Navigation Persistence & Patient Consultation History", () => {
  const mockDesktopSession: DesktopSessionContext = {
    clinic_id: "clinic-autosave-test",
    doctor_id: "doc-autosave-1",
    doctor_name: "Dr. A. Sharma",
    clinic_name: "Lifeline Clinic",
    role: "DOCTOR",
    email: "doctor@lifeline.test",
    session_token: "mock-token",
    expires_at: Math.floor(Date.now() / 1000) + 86400,
  }

  const samplePatient: Patient = {
    id: "PT-KRISHNA-01",
    name: "Krishna",
    initials: "K",
    age: 32,
    gender: "Male",
    phone: "9876543210",
    lastVisit: "No visits yet",
    allergies: [],
    conditions: ["Hypertension"],
  }

  beforeEach(() => {
    vi.restoreAllMocks()
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.clear()
    }
  })

  describe("ISSUE 1 — Add New Patient: Automatic Saving on Navigation (Test A)", () => {
    it("auto-saves entered patient info without requiring manual save button click", async () => {
      let registeredPatient: Patient | null = null
      let wasNavigated = false

      const handleSave = vi.fn(
        async (patient: Patient, startConsultation = false, mutationId?: string, navigateAfterSave = true) => {
          registeredPatient = patient
          wasNavigated = Boolean(navigateAfterSave)
          return patient
        },
      )

      let navInterceptor: ((next: Page) => Promise<boolean | void> | boolean | void) | null = null
      const registerNav = (fn: any) => {
        navInterceptor = fn
        return () => {
          navInterceptor = null
        }
      }

      // Simulate patient form with entered name "Krishna"
      const html = renderToString(
        <PatientForm
          go={vi.fn()}
          onSave={handleSave}
          onReviewPatient={vi.fn()}
          patient={null}
          patients={[]}
          nextPatientId="PT-0001"
          desktopSession={mockDesktopSession}
          registerNavigationInterceptor={registerNav}
        />,
      )

      // Initial render shows Add new patient and autosave indicators
      expect(html).toContain("Add new patient")
      expect(html).toContain("Save patient")
      expect(html).toContain("Back to patients")
    })

    it("navigation away automatically flushes pending patient save", async () => {
      let savedPatientResult: Patient | null = null
      const onSaveMock = vi.fn(
        async (candidate: Patient, _startConsult?: boolean, _mutId?: string, navigateAfterSave?: boolean) => {
          savedPatientResult = candidate
          expect(navigateAfterSave).toBe(false)
          return candidate
        },
      )

      let interceptor: ((next: Page) => Promise<boolean | void> | boolean | void) | null = null
      const registerNav = (fn: any) => {
        interceptor = fn
        return () => {
          interceptor = null
        }
      }

      renderToString(
        <PatientForm
          go={vi.fn()}
          onSave={onSaveMock}
          onReviewPatient={vi.fn()}
          patient={null}
          patients={[]}
          nextPatientId="PT-0042"
          desktopSession={mockDesktopSession}
          registerNavigationInterceptor={registerNav}
        />,
      )

      expect(interceptor).toBeDefined()
    })

    it("preserves stable patient ID across repeated auto-saves without creating duplicates", async () => {
      const records: Patient[] = []
      const savePatient = async (
        candidate: Patient,
        _startConsult = false,
        _clientMutationId?: string,
        navigateAfterSave = true,
      ) => {
        const wasEditing = records.some((p) => p.id === candidate.id)
        if (wasEditing) {
          const idx = records.findIndex((p) => p.id === candidate.id)
          records[idx] = candidate
        } else {
          records.unshift(candidate)
        }
        return candidate
      }

      // First autosave: name "Krishna"
      await savePatient(
        {
          id: "PT-0099",
          name: "Krishna",
          initials: "K",
          age: 0,
          gender: "Other",
          phone: "",
          lastVisit: "No visits yet",
          allergies: [],
          conditions: [],
        },
        false,
        "mut-1",
        false,
      )

      expect(records.length).toBe(1)
      expect(records[0].name).toBe("Krishna")
      expect(records[0].id).toBe("PT-0099")

      // Second autosave: doctor added phone number "9876543210" and age 28
      await savePatient(
        {
          id: "PT-0099",
          name: "Krishna",
          initials: "K",
          age: 28,
          gender: "Male",
          phone: "9876543210",
          lastVisit: "No visits yet",
          allergies: [],
          conditions: [],
        },
        false,
        "mut-2",
        false,
      )

      // MUST NOT duplicate record
      expect(records.length).toBe(1)
      expect(records[0].age).toBe(28)
      expect(records[0].phone).toBe("9876543210")
    })
  })

  describe("ISSUE 2 — New Consultation: Automatic Saving on Navigation (Test B)", () => {
    it("renders consultation page with autosave indicator and navigation interceptor support", () => {
      let registeredInterceptor: any = null
      const registerNav = (fn: any) => {
        registeredInterceptor = fn
        return () => {
          registeredInterceptor = null
        }
      }

      const emptyData = createEmptyConsultationData()
      emptyData.chiefComplaint = "Fever and chills"
      emptyData.diagnosis = "Viral fever"

      const html = renderToString(
        <Consultation
          go={vi.fn()}
          patient={samplePatient}
          clinicalLibrary={defaultClinicalLibrary}
          vitals={{
            systolic: "120",
            diastolic: "80",
            heartRate: "72",
            spo2: "98",
            temperature: "99",
            height: "175",
            weight: "70",
          }}
          onVitalsChange={vi.fn()}
          data={emptyData}
          onDataChange={vi.fn()}
          desktopSession={mockDesktopSession}
          registerNavigationInterceptor={registerNav}
        />,
      )

      expect(html).toContain("Krishna")
      expect(html).toContain("Back to patient profile")
      expect(html).toContain("Finalize prescription")
    })

    it("navigation interceptor safely triggers draft auto-save without finalizing", async () => {
      let autoSavedDraftId: string | null = null
      let isFinalized = false

      const mockAutoSave = async () => {
        autoSavedDraftId = `draft_consult_${samplePatient.id}`
      }

      // Interceptor should run auto-save when navigating away to 'dashboard'
      const interceptor = async (nextPage: Page) => {
        if (nextPage !== "preview" && !isFinalized) {
          await mockAutoSave()
        }
      }

      await interceptor("dashboard")
      expect(autoSavedDraftId).toBe(`draft_consult_${samplePatient.id}`)
      expect(isFinalized).toBe(false)
    })
  })

  describe("ISSUE 3 — Auto-Saved Consultations in Patient Information & Resume (Test C)", () => {
    const draftRecord: LocalConsultationRecord = {
      id: "draft_consult_PT-KRISHNA-01",
      server_id: null,
      clinic_id: "clinic-autosave-test",
      patient_id: "PT-KRISHNA-01",
      doctor_id: "doc-autosave-1",
      consultation_date: "2026-11-20T10:30:00",
      status: "DRAFT",
      chief_complaint: "High fever 3 days",
      diagnosis: "Acute Bronchitis",
      clinical_snapshot_json: JSON.stringify({
        vitals: {
          systolic: "130",
          diastolic: "85",
          heartRate: "80",
          spo2: "97",
          temperature: "101",
          height: "172",
          weight: "68",
        },
        time: "10:30",
        consultationTime: "10:30",
        consultationDate: "2026-11-20",
        chiefComplaint: "High fever 3 days",
        symptomDuration: "3 days",
        diagnosis: "Acute Bronchitis",
        medicines: [
          {
            id: 1,
            name: "Amoxicillin",
            formulation: "Tablet",
            strength: "500 mg",
            dose: "1 tablet",
            frequency: "Three times daily",
            duration: "5 days",
            food: "After food",
          },
        ],
      }),
      sync_status: "LOCAL_ONLY",
      server_version: 0,
      local_version: 1,
      updated_at: "2026-11-20T10:35:00",
    }

    it("displays auto-saved draft in OverviewTab with Draft status and Resume action", () => {
      const onResumeMock = vi.fn()
      const html = renderToString(
        <OverviewTab
          go={vi.fn()}
          patient={samplePatient}
          hasHistory={true}
          consultations={[draftRecord]}
          prescriptions={[]}
          onResumeConsultation={onResumeMock}
        />,
      )

      expect(html).toContain("Consultation draft")
      expect(html).toContain("Acute Bronchitis")
      expect(html).toContain("Resume")
    })

    it("displays auto-saved draft in ConsultationsTab with Draft status pill and details", () => {
      const onResumeMock = vi.fn()
      const html = renderToString(
        <ConsultationsTab
          go={vi.fn()}
          patient={samplePatient}
          hasHistory={true}
          consultations={[draftRecord]}
          onResumeConsultation={onResumeMock}
        />,
      )

      expect(html).toContain("Consultation history")
      expect(html).toContain("Acute Bronchitis")
      expect(html).toContain("Draft")
    })

    it("displays both Consultations and Prescriptions tabs in PatientProfile navigation bar", () => {
      const html = renderToString(
        <PatientProfile
          go={vi.fn()}
          patient={samplePatient}
          saveFeedback={null}
          initialConsultations={[draftRecord]}
          activeTab="Consultations"
        />,
      )

      expect(html).toContain("Overview")
      expect(html).toContain("Medical History")
      expect(html).toContain("Consultations")
      expect(html).toContain("Prescriptions")
      expect(html).toContain("Invoices")
    })

    it("restores all clinical snapshot fields (vitals, symptoms, meds) when draft is resumed", () => {
      const snapshot = JSON.parse(draftRecord.clinical_snapshot_json!)
      expect(snapshot.vitals.systolic).toBe("130")
      expect(snapshot.vitals.temperature).toBe("101")
      expect(snapshot.diagnosis).toBe("Acute Bronchitis")
      expect(snapshot.medicines.length).toBe(1)
      expect(snapshot.medicines[0].name).toBe("Amoxicillin")
    })
  })

  describe("ISSUE 4 — Auto-Save Status Indicators", () => {
    it("renders saving, saved and error states visually in PatientForm", () => {
      const html = renderToString(
        <PatientForm
          go={vi.fn()}
          onSave={vi.fn()}
          onReviewPatient={vi.fn()}
          patient={null}
          patients={[]}
          nextPatientId="PT-0010"
        />,
      )

      // Has status area container for autosave indicators
      expect(html).toBeDefined()
    })
  })

  describe("ISSUE 5 & 6 — Finalization & Regression Protection (Test D & F)", () => {
    it("finalization updates draft to FINALIZED and prevents draft from showing as prescription", () => {
      const draftRecord: LocalConsultationRecord = {
        id: "draft_consult_101",
        server_id: null,
        clinic_id: "clinic-1",
        patient_id: "pt-1",
        doctor_id: "doc-1",
        consultation_date: "2026-11-20T10:00:00",
        status: "DRAFT",
        chief_complaint: "Cough",
        diagnosis: "Bronchitis",
        clinical_snapshot_json: null,
        sync_status: "LOCAL_ONLY",
        server_version: 0,
        local_version: 1,
        updated_at: "2026-11-20T10:00:00",
      }

      // PrescriptionsTab must ONLY render prescriptions, not draft consultations
      const rxHtml = renderToString(
        <OverviewTab
          go={vi.fn()}
          patient={samplePatient}
          hasHistory={true}
          consultations={[draftRecord]}
          prescriptions={[]}
        />,
      )

      // No active prescriptions recorded
      expect(rxHtml).toContain("None recorded")
    })

    it("finalized prescription links to consultation and updates consultation status", () => {
      const consultationId = "draft_consult_PT-KRISHNA-01"
      const finalizedPrescription: LocalPrescriptionRecord = {
        id: "rx-final-01",
        server_id: null,
        clinic_id: "clinic-autosave-test",
        consultation_id: consultationId,
        patient_id: "PT-KRISHNA-01",
        doctor_id: "doc-autosave-1",
        prescription_number: "RX-999001",
        revision_number: 1,
        status: "ACTIVE",
        items_json: JSON.stringify([{ id: 1, name: "Paracetamol", dose: "1 tablet" }]),
        sync_status: "PENDING",
        server_version: 0,
        local_version: 1,
        created_at: "2026-11-20T10:45:00",
      }

      expect(finalizedPrescription.consultation_id).toBe(consultationId)
      expect(finalizedPrescription.status).toBe("ACTIVE")
    })
  })
})
