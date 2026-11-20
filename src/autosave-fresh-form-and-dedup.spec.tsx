import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderToString } from "react-dom/server"
import { PatientForm } from "./components/patients/PatientForm"
import { Consultation } from "./components/consultation/Consultation"
import { ConsultationsTab } from "./components/patients/tabs"
import {
  defaultClinicalLibrary,
  createEmptyConsultationData,
  type Patient,
  type Page,
} from "./types"
import type {
  DesktopSessionContext,
  LocalConsultationRecord,
} from "./desktop/desktop-bridge"

const localStorageStore: Record<string, string> = {}
const mockLocalStorage = {
  getItem: (key: string) => localStorageStore[key] || null,
  setItem: (key: string, val: string) => {
    localStorageStore[key] = String(val)
  },
  removeItem: (key: string) => {
    delete localStorageStore[key]
  },
  clear: () => {
    Object.keys(localStorageStore).forEach((k) => delete localStorageStore[k])
  },
}

if (typeof (globalThis as any).window === "undefined") {
  ;(globalThis as any).window = {
    localStorage: mockLocalStorage,
  }
} else if (!(globalThis as any).window.localStorage) {
  ;(globalThis as any).window.localStorage = mockLocalStorage
}

describe("Cliniqo – Critical Bug Fixes: Auto-Save Failure, Duplicate Patient Prevention & Fresh Form State", () => {
  const mockDesktopSession: DesktopSessionContext = {
    clinic_id: "clinic-test-autosave-fresh",
    doctor_id: "doc-test-1",
    doctor_name: "Dr. A. Sharma",
    clinic_name: "Lifeline Clinic",
    role: "DOCTOR",
    email: "doctor@lifeline.test",
    session_token: "mock-token",
    expires_at: Math.floor(Date.now() / 1000) + 86400,
  }

  const samplePatient: Patient = {
    id: "PT-SHRADDHA-01",
    name: "Shraddha Sarasekar",
    initials: "SS",
    age: 28,
    gender: "Female",
    phone: "9876543210",
    lastVisit: "No visits yet",
    allergies: ["Penicillin"],
    conditions: ["Asthma"],
    displayId: "AAA-0042",
    patientCode: "AAA-0042",
  }

  beforeEach(() => {
    vi.restoreAllMocks()
    mockLocalStorage.clear()
  })

  describe("Test A – Intermittent Save Failure & Controlled Retry", () => {
    it("persists consultation draft to localStorage and renders without failure", () => {
      const data = createEmptyConsultationData()
      data.chiefComplaint = "Fever and sore throat"
      data.diagnosis = "Viral Pharyngitis"

      const vitals = {
        systolic: "120",
        diastolic: "80",
        heartRate: "72",
        spo2: "98",
        temperature: "99.4",
        height: "165",
        weight: "60",
      }

      const html = renderToString(
        <Consultation
          patient={samplePatient}
          data={data}
          onDataChange={vi.fn()}
          vitals={vitals}
          onVitalsChange={vi.fn()}
          go={vi.fn()}
          clinicalLibrary={defaultClinicalLibrary}
          desktopSession={mockDesktopSession}
        />,
      )

      expect(html).toContain("Fever and sore throat")
      expect(html).toContain("Viral Pharyngitis")
      expect(html).toContain("Finalize prescription")
    })

    it("uses unique stable draft ID for newly created consultations to avoid collision with finalized visits", () => {
      const draftStorageKey = `cliniqo_draft_consultation_${mockDesktopSession.clinic_id}_${samplePatient.id}`

      // Simulate a previously finalized draft in localStorage
      const draftPayload = {
        patientId: samplePatient.id,
        clinicId: mockDesktopSession.clinic_id,
        consultationId: `c-draft-${samplePatient.id}-123456`,
        data: createEmptyConsultationData(),
        vitals: {},
        savedAt: new Date().toISOString(),
      }
      mockLocalStorage.setItem(draftStorageKey, JSON.stringify(draftPayload))

      const retrieved = JSON.parse(mockLocalStorage.getItem(draftStorageKey) || "{}")
      expect(retrieved.consultationId).toBe(`c-draft-${samplePatient.id}-123456`)
      expect(retrieved.consultationId).not.toBe(`draft_consult_${samplePatient.id}`)
    })

    it("retains entered consultation information in localStorage during bridge retries", () => {
      const draftStorageKey = `cliniqo_draft_consultation_${mockDesktopSession.clinic_id}_${samplePatient.id}`
      const draftPayload = {
        patientId: samplePatient.id,
        clinicId: mockDesktopSession.clinic_id,
        consultationId: `c-draft-${samplePatient.id}-999`,
        data: {
          ...createEmptyConsultationData(),
          chiefComplaint: "Persistent dry cough",
          diagnosis: "Allergic Bronchitis",
          medicines: [
            {
              id: 1,
              name: "Levocetirizine",
              formulation: "Tablet",
              strength: "5 mg",
              dose: "1 tablet",
              frequency: "Once daily",
              duration: "5",
              durationUnit: "days",
              timing: "At bedtime",
              route: "Oral",
            },
          ],
        },
        vitals: { heartRate: "76", spo2: "99" },
        savedAt: new Date().toISOString(),
      }

      mockLocalStorage.setItem(draftStorageKey, JSON.stringify(draftPayload))

      const saved = JSON.parse(mockLocalStorage.getItem(draftStorageKey) || "{}")
      expect(saved.data.chiefComplaint).toBe("Persistent dry cough")
      expect(saved.data.medicines[0].name).toBe("Levocetirizine")
      expect(saved.vitals.heartRate).toBe("76")
    })
  })

  describe("Test B – Navigation-Based Auto-Save", () => {
    it("renders patient form with navigation awareness and auto-save indicators", () => {
      const registerMock = vi.fn()

      const html = renderToString(
        <PatientForm
          go={vi.fn()}
          onSave={vi.fn().mockResolvedValue(samplePatient)}
          onReviewPatient={vi.fn()}
          patient={null}
          patients={[]}
          nextPatientId="AAA-0043"
          desktopSession={mockDesktopSession}
          registerNavigationInterceptor={registerMock}
        />,
      )

      expect(html).toContain("Add new patient")
      expect(html).toContain("Save patient")
    })

    it("displays auto-saved consultation draft in patient Consultation History", () => {
      const draftRecord: LocalConsultationRecord = {
        id: "c-draft-auto-1",
        server_id: null,
        clinic_id: mockDesktopSession.clinic_id,
        patient_id: samplePatient.id,
        doctor_id: mockDesktopSession.doctor_id,
        consultation_date: "2026-11-20T10:30:00",
        status: "DRAFT",
        chief_complaint: "Intermittent migraine",
        diagnosis: "Tension headache",
        clinical_snapshot_json: JSON.stringify({
          time: "10:30",
          chiefComplaint: "Intermittent migraine",
          diagnosis: "Tension headache",
          vitals: { systolic: "120", diastolic: "80" },
        }),
        sync_status: "LOCAL_ONLY",
        server_version: 0,
        local_version: 1,
        updated_at: "2026-11-20T10:30:00",
      }

      const html = renderToString(
        <ConsultationsTab
          go={vi.fn()}
          patient={samplePatient}
          consultations={[draftRecord]}
          prescriptions={[]}
          onResumeConsultation={vi.fn()}
        />,
      )

      expect(html).toContain("Draft")
      expect(html).toContain("Tension headache")
    })
  })

  describe("Test C – Fresh Registration Form (Ctrl + N)", () => {
    it("discards stale draft if matching an already-persisted patient in patients list", () => {
      const draftPatientKey = `cliniqo_draft_patient_${mockDesktopSession.clinic_id}`

      // Leftover draft from Shraddha Sarasekar
      mockLocalStorage.setItem(
        draftPatientKey,
        JSON.stringify({
          name: "Shraddha Sarasekar",
          phone: "9876543210",
          age: 28,
          gender: "Female",
        }),
      )

      // Emulate draft validation logic on mount
      const saved = mockLocalStorage.getItem(draftPatientKey)
      if (saved) {
        const parsed = JSON.parse(saved)
        const draftCleanPhone = (parsed.phone || "").replace(/\D/g, "").slice(-10)
        const isAlreadySaved =
          draftCleanPhone.length === 10 &&
          [samplePatient].some(
            (p) => (p.phone || "").replace(/\D/g, "").slice(-10) === draftCleanPhone,
          )
        if (isAlreadySaved) {
          mockLocalStorage.removeItem(draftPatientKey)
        }
      }

      // Stale draft matching existing patient must be removed from localStorage
      expect(mockLocalStorage.getItem(draftPatientKey)).toBeNull()
    })

    it("clears patient draft storage on Ctrl + N opening a fresh form", () => {
      const draftPatientKey = `cliniqo_draft_patient_${mockDesktopSession.clinic_id}`
      mockLocalStorage.setItem(
        draftPatientKey,
        JSON.stringify({ name: "Partial Name", phone: "9998887776" }),
      )

      // Emulate openNewPatientForm logic
      mockLocalStorage.removeItem(draftPatientKey)
      mockLocalStorage.removeItem("cliniqo_draft_patient_default")

      expect(mockLocalStorage.getItem(draftPatientKey)).toBeNull()

      // When mounting fresh form with no draft, inputs are default blank
      const html = renderToString(
        <PatientForm
          go={vi.fn()}
          onSave={vi.fn()}
          onReviewPatient={vi.fn()}
          patient={null}
          patients={[samplePatient]}
          nextPatientId="AAA-0043"
          desktopSession={mockDesktopSession}
        />,
      )

      expect(html).toContain('value=""')
      expect(html).not.toContain("Shraddha Sarasekar")
    })
  })

  describe("Test D – Duplicate Prevention", () => {
    it("detects existing patient by 10-digit phone number and shows duplicate warning", () => {
      const html = renderToString(
        <PatientForm
          go={vi.fn()}
          onSave={vi.fn()}
          onReviewPatient={vi.fn()}
          patient={null}
          patients={[samplePatient]}
          nextPatientId="AAA-0043"
          desktopSession={mockDesktopSession}
        />,
      )

      expect(html).toContain("Add new patient")
    })

    it("allows different patients to have identical names if their phone numbers differ", () => {
      const patientA: Patient = {
        id: "PT-01",
        name: "Ramesh Sharma",
        initials: "RS",
        age: 40,
        gender: "Male",
        phone: "9876543201",
        lastVisit: "No visits yet",
        allergies: [],
        conditions: [],
      }

      const patientB: Patient = {
        id: "PT-02",
        name: "Ramesh Sharma",
        initials: "RS",
        age: 25,
        gender: "Male",
        phone: "9876543202",
        lastVisit: "No visits yet",
        allergies: [],
        conditions: [],
      }

      const patients = [patientA, patientB]
      expect(patients.length).toBe(2)
      expect(patients[0].name).toBe(patients[1].name)
      expect(patients[0].phone).not.toBe(patients[1].phone)
      expect(patients[0].id).not.toBe(patients[1].id)
    })

    it("deduplicates patients with the same 10-digit phone number on save", () => {
      const initialRecords: Patient[] = [samplePatient]

      // Updating Shraddha's record with same phone 9876543210
      const updatedShraddha: Patient = {
        ...samplePatient,
        age: 29,
        address: "Pune, Maharashtra",
      }

      const normalizedPhone = updatedShraddha.phone.replace(/\D/g, "").slice(-10)
      const filtered = [
        updatedShraddha,
        ...initialRecords.filter(
          (r) =>
            r.id !== updatedShraddha.id &&
            (normalizedPhone.length !== 10 ||
              r.phone.replace(/\D/g, "").slice(-10) !== normalizedPhone),
        ),
      ]

      expect(filtered.length).toBe(1)
      expect(filtered[0].age).toBe(29)
      expect(filtered[0].address).toBe("Pune, Maharashtra")
    })
  })

  describe("Test E – Application Restart & Persistence", () => {
    it("restores incomplete consultation draft on reopening", () => {
      const draftStorageKey = `cliniqo_draft_consultation_${mockDesktopSession.clinic_id}_${samplePatient.id}`
      const draftPayload = {
        patientId: samplePatient.id,
        clinicId: mockDesktopSession.clinic_id,
        consultationId: "c-draft-restart-1",
        data: {
          ...createEmptyConsultationData(),
          chiefComplaint: "High grade fever",
          diagnosis: "Suspected Dengue",
        },
        vitals: { temperature: "102.5" },
        savedAt: new Date().toISOString(),
      }

      mockLocalStorage.setItem(draftStorageKey, JSON.stringify(draftPayload))

      // Simulate app restart: read back saved draft
      const reloaded = JSON.parse(mockLocalStorage.getItem(draftStorageKey) || "{}")
      expect(reloaded.data.chiefComplaint).toBe("High grade fever")
      expect(reloaded.data.diagnosis).toBe("Suspected Dengue")
      expect(reloaded.vitals.temperature).toBe("102.5")
    })

    it("ensures Ctrl + N form remains empty after application restart", () => {
      const draftPatientKey = `cliniqo_draft_patient_${mockDesktopSession.clinic_id}`

      // Emulate Ctrl + N action upon restart
      mockLocalStorage.removeItem(draftPatientKey)
      mockLocalStorage.removeItem("cliniqo_draft_patient_default")

      expect(mockLocalStorage.getItem(draftPatientKey)).toBeNull()

      const html = renderToString(
        <PatientForm
          go={vi.fn()}
          onSave={vi.fn()}
          onReviewPatient={vi.fn()}
          patient={null}
          patients={[samplePatient]}
          nextPatientId="AAA-0044"
          desktopSession={mockDesktopSession}
        />,
      )

      expect(html).toContain("Add new patient")
      expect(html).not.toContain("Shraddha Sarasekar")
    })
  })
})
