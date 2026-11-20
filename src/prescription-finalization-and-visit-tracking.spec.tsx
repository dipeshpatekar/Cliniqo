import { describe, it, expect, vi, beforeEach } from "vitest"
import React from "react"
import { renderToString } from "react-dom/server"
import App from "./App"
import { PrescriptionPreview } from "./components/consultation/PrescriptionPreview"
import { PatientProfile } from "./components/patients/PatientProfile"
import { PatientsPage } from "./components/patients/PatientsPage"
import {
  resolvePrescriptionPreviewNavigation,
  computePrescriptionPreviewState,
} from "./routing/prescriptionRouting"
import {
  formatPatientVisitDateTime,
  mapLocalRecordToPatient,
  type Patient,
  type ConsultationData,
  type Vitals,
} from "./types"
import type {
  DesktopSessionContext,
  LocalPatientRecord,
  LocalPrescriptionRecord,
} from "./desktop/desktop-bridge"

describe("Cliniqo Prescription Finalization Navigation, Concise Notifications & Last Visit Tracking", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    const storage: Record<string, string> = {
      "cliniqo-theme": "light",
    }
    const target = new EventTarget()
    ;(target as any).localStorage = {
      getItem: (key: string) => storage[key] ?? null,
      setItem: (key: string, val: string) => {
        storage[key] = val
      },
      removeItem: (key: string) => {
        delete storage[key]
      },
      clear: () => {
        for (const k of Object.keys(storage)) delete storage[k]
      },
    }
    ;(target as any).location = { reload: vi.fn() }
    ;(target as any).setTimeout = setTimeout
    ;(target as any).clearTimeout = clearTimeout
    ;(globalThis as any).window = target
  })

  const mockDesktopSession: DesktopSessionContext = {
    clinic_id: "clinic_test_123",
    doctor_id: "doc_test_123",
    doctor_name: "Dr. Vikram Seth",
    clinic_name: "Seth Healthcare Center",
    token: "mock-token",
    refresh_token: "mock-refresh-token",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  }

  const mockPatientA: Patient = {
    id: "PT-TEST-001",
    displayId: "AAA-0001",
    patientCode: "AAA-0001",
    name: "Aakash Verma",
    initials: "AV",
    age: 32,
    gender: "Male",
    phone: "9876543210",
    lastVisit: "2026-11-20T10:30:00.000Z",
    registeredAt: "2026-11-20T10:30:00.000Z",
    allergies: ["Penicillin"],
    conditions: ["Hypertension"],
  }

  const mockConsultationData: ConsultationData = {
    date: "2026-11-20",
    time: "10:30 AM",
    chiefComplaint: "Fever and cold",
    symptomDuration: "3 days",
    diagnosis: "Viral upper respiratory infection",
    medicines: [
      {
        id: 1,
        name: "Paracetamol",
        formulation: "Tablet",
        dose: "650 mg",
        frequency: "Three times daily",
        duration: "3 days",
        food: "After food",
        route: "Oral",
      },
    ],
    followUpDate: "2026-11-25",
    followUpInstructions: "Review if fever persists",
    allergies: ["Penicillin"],
    conditions: ["Hypertension"],
  }

  const mockVitals: Vitals = {
    systolic: "120",
    diastolic: "80",
    heartRate: "72",
    spo2: "98",
    temperature: "99",
    height: "175",
    weight: "70",
  }

  const mockFinalizedRx: LocalPrescriptionRecord = {
    id: "rx-test-001",
    server_id: null,
    clinic_id: "clinic_test_123",
    consultation_id: "consult-test-001",
    patient_id: "PT-TEST-001",
    doctor_id: "doc_test_123",
    prescription_number: "RX-353489",
    revision_number: 1,
    status: "ACTIVE",
    items_json: JSON.stringify(mockConsultationData.medicines),
    notes: null,
    sync_status: "LOCAL_ONLY",
    server_version: 0,
    local_version: 1,
    created_at: "2026-11-20T10:30:00.000Z",
    updated_at: "2026-11-20T10:30:00.000Z",
  }

  describe("Test A: Prescription Preview Back Navigation After Finalization", () => {
    it("1. When consultation is finalized, resolvePrescriptionPreviewNavigation resolves returnPage to 'patient-profile'", () => {
      const navFinalized = resolvePrescriptionPreviewNavigation(
        "consultation",
        "consultation",
        true, // isFinalized = true
      )
      expect(navFinalized.returnPage).toBe("patient-profile")
      expect(navFinalized.clearHistorical).toBe(true)
    })

    it("2. When viewing preview without finalization, returnPage remains 'consultation'", () => {
      const navUnfinalized = resolvePrescriptionPreviewNavigation(
        "consultation",
        "consultation",
        false, // isFinalized = false
      )
      expect(navUnfinalized.returnPage).toBe("consultation")
    })

    it("3. Clicking Back button from finalized prescription preview navigates to patient profile", () => {
      const goSpy = vi.fn()
      const html = renderToString(
        <PrescriptionPreview
          go={goSpy}
          patient={mockPatientA}
          vitals={mockVitals}
          data={mockConsultationData}
          bannerVisible={true}
          bannerImage={null}
          signatureImage={null}
          showClinicLogo={true}
          showClinicEmail={true}
          showAllergyWarning={true}
          returnPage="patient-profile"
          prescriptionRecord={mockFinalizedRx}
          isNewlyFinalized={true}
        />,
      )

      expect(html).toContain('aria-label="Back to patient profile"')
      expect(html).not.toContain('aria-label="Back to consultation"')
    })

    it("4. When returning to patient profile, newly created patient profile renders patient info and tabs", () => {
      const html = renderToString(
        <App
          initialPage="patient-profile"
          initialDesktopSession={mockDesktopSession}
          initialSelectedPatient={mockPatientA}
          initialPatientProfileTab="Prescriptions"
        />,
      )

      expect(html).toContain("Aakash Verma")
      expect(html).toContain("AAA-0001")
      expect(html).toContain("Prescriptions")
      expect(html).not.toContain("New consultation")
    })
  })

  describe("Test B: Concise Success Notifications", () => {
    it("1. Prescription Preview renders 'Prescription saved' without technical explanation", () => {
      const html = renderToString(
        <PrescriptionPreview
          go={() => {}}
          patient={mockPatientA}
          vitals={mockVitals}
          data={mockConsultationData}
          bannerVisible={true}
          bannerImage={null}
          signatureImage={null}
          showClinicLogo={true}
          showClinicEmail={true}
          showAllergyWarning={true}
          returnPage="patient-profile"
          prescriptionRecord={mockFinalizedRx}
          isNewlyFinalized={true}
        />,
      )

      expect(html).toContain("Prescription saved")
      expect(html).not.toContain("Persisted to local encrypted storage")
    })

    it("2. PatientProfile renders 'Patient saved' without technical explanation", () => {
      const html = renderToString(
        <PatientProfile
          go={() => {}}
          patient={mockPatientA}
          saveFeedback="updated"
        />,
      )

      expect(html).toContain("Patient saved")
      expect(html).not.toContain("The existing local record was updated without changing its patient ID")
      expect(html).not.toContain("The local patient record is ready for this session")
    })
  })

  describe("Test C: Patient Last Visit Initialization & Auto-Update", () => {
    it("1. formatPatientVisitDateTime formats ISO datetime into 'DD/MM/YYYY · hh:mm A'", () => {
      // 2026-11-20 16:30 IST is 2026-11-20T11:00:00Z
      const formatted = formatPatientVisitDateTime("2026-11-20T11:00:00.000Z")
      expect(formatted).toBe("20/11/2026 · 04:30 PM")
    })

    it("2. When a new patient is registered, mapLocalRecordToPatient initializes lastVisit with registration timestamp", () => {
      const regTime = "2026-11-20T10:30:00.000Z"
      const rawRec: LocalPatientRecord = {
        id: "PT-NEW-001",
        server_id: null,
        clinic_id: "clinic_test_123",
        patient_code: "AAA-0045",
        name: "Neha Joshi",
        phone: "9123456789",
        gender: "Female",
        date_of_birth: null,
        age: 26,
        allergies: [],
        conditions: [],
        sensitive_notes: JSON.stringify({ registeredAt: regTime }),
        sync_status: "PENDING",
        server_version: 0,
        local_version: 1,
        created_at: regTime,
        updated_at: regTime,
        last_visit: null,
      }

      const patient = mapLocalRecordToPatient(rawRec)
      expect(patient.lastVisit).toBe(regTime)
      expect(patient.lastVisit).not.toBe("No visits yet")
    })

    it("3. PatientsPage displays formatted last visit and never displays 'No visits yet' or 'Not visited yet'", () => {
      const html = renderToString(
        <PatientsPage
          go={() => {}}
          patients={[mockPatientA]}
          onOpenPatient={() => {}}
          onStartConsultation={() => {}}
          onCreateBill={() => {}}
          onEditPatient={() => {}}
        />,
      )

      expect(html).toContain("20/11/2026")
      expect(html).not.toContain("No visits yet")
      expect(html).not.toContain("Not visited yet")
    })

    it("4. PatientProfile displays formatted last visit using patient registration time if no consultations yet", () => {
      const html = renderToString(
        <PatientProfile
          go={() => {}}
          patient={mockPatientA}
          saveFeedback={null}
        />,
      )

      expect(html).toContain("Last visit")
      expect(html).toContain(formatPatientVisitDateTime(mockPatientA.lastVisit))
      expect(html).not.toContain("No consultations yet")
      expect(html).not.toContain("No visits yet")
    })
  })

  describe("Test D: Prescription Editing After Finalization Not Marked As Revision", () => {
    it("1. Editing immediately after finalization has isRevision=false", () => {
      const { isHistorical } = computePrescriptionPreviewState("patient-profile", null)
      expect(isHistorical).toBe(false)

      const html = renderToString(
        <PrescriptionPreview
          go={() => {}}
          patient={mockPatientA}
          vitals={mockVitals}
          data={mockConsultationData}
          bannerVisible={true}
          bannerImage={null}
          signatureImage={null}
          showClinicLogo={true}
          showClinicEmail={true}
          showAllergyWarning={true}
          returnPage="patient-profile"
          prescriptionRecord={mockFinalizedRx}
          isHistorical={false}
          isNewlyFinalized={true}
          onRevisePrescription={async () => {}}
        />,
      )

      // Shows live finalization banner
      expect(html).toContain("Prescription saved")
      // Does not show revision indicator in header subtitle
      expect(html).toContain("RX-353489 · Finalized")
      expect(html).not.toContain("Read-only historical record")
    })
  })
})
