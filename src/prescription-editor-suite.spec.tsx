import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderToString } from "react-dom/server"
import React from "react"
import { PrescriptionEditModal } from "./components/consultation/PrescriptionEditModal"
import { PrescriptionPreview } from "./components/consultation/PrescriptionPreview"
import { BillPreview } from "./components/billing/BillPreview"
import { Dashboard } from "./components/dashboard/Dashboard"
import {
  type Patient,
  type Vitals,
  type ConsultationData,
  type Medicine,
  type ClinicalLibrary,
  type PrescriptionRevisionData,
  defaultClinicalLibrary,
  computeDefaultFollowUpDate,
  createEmptyConsultationData,
  loadCustomDiagnoses,
  saveCustomDiagnoses,
  getDiagnosisOptions,
  addCustomDiagnosis,
  saveClinicalLibrary,
  loadClinicalLibrary,
  addClinicalLibraryItem,
} from "./types"
import type { LocalPrescriptionRecord } from "./desktop/desktop-bridge"

describe("CLINIQUO — Prescription Editor, Clinical Library & UI Enhancements (Issues 1–6)", () => {
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
        for (const k in storage) delete storage[k]
      },
    }
    ;(target as any).scrollTo = vi.fn()
    ;(target as any).matchMedia = () => ({ matches: false })
    ;(globalThis as any).window = target
  })

  const mockPatient: Patient = {
    id: "pat-krishna-1",
    displayId: "AAA-0007",
    patientCode: "AAA-0007",
    name: "krishna",
    initials: "KR",
    age: 21,
    gender: "Female",
    phone: "8208096960",
    lastVisit: "2026-11-17T15:36:00",
    allergies: ["Penicillin"],
    conditions: ["Asthma"],
  }

  const mockVitals: Vitals = {
    systolic: "120",
    diastolic: "80",
    heartRate: "72",
    spo2: "99",
    temperature: "98.4",
    height: "162",
    weight: "54",
  }

  const mockMedicines: Medicine[] = [
    {
      id: 1,
      name: "TAKATAK MR",
      formulation: "Tablet",
      strength: "500 mg",
      dose: "1 tablet",
      route: "",
      frequency: "Once daily",
      duration: "3 days",
      food: "After food",
      directions: "",
    },
  ]

  const mockConsultationData: ConsultationData = {
    date: "2026-11-18",
    time: "10:00",
    chiefComplaint: "Muscle spasm and mild headache",
    symptomDuration: "2 days",
    diagnosis: "Acute Musculoskeletal Strain",
    medicines: mockMedicines,
    followUpDate: "2026-11-21",
    followUpInstructions: "Avoid heavy lifting and stay hydrated.",
    allergies: ["Penicillin"],
    conditions: ["Asthma"],
  }

  // =========================================================================
  // ISSUE 1: Complete Edit Prescription Functionality
  // =========================================================================
  describe("ISSUE 1 — Complete Edit Prescription Functionality", () => {
    it("renders all clinical sections: Vitals, Clinical Notes, Medical Background, Consultation Details, Medicines, Follow-up & ADV", () => {
      const html = renderToString(
        <PrescriptionEditModal
          isOpen={true}
          onClose={vi.fn()}
          prescriptionNumber="RX-854704"
          currentRevisionNumber={1}
          initialMedicines={mockMedicines}
          initialVitals={mockVitals}
          initialConsultationData={mockConsultationData}
          patient={mockPatient}
          onSaveRevision={vi.fn()}
        />,
      )

      // Section Headers & Content
      expect(html).toContain("Consultation Information")
      expect(html).toContain("2026-11-18")
      expect(html).toContain("10:00")

      expect(html).toContain("Clinical Notes")
      expect(html).toContain("Chief Complaints")
      expect(html).toContain("Muscle spasm and mild headache")
      expect(html).toContain("Symptom Duration")
      expect(html).toContain("Diagnosis")
      expect(html).toContain("Acute Musculoskeletal Strain")

      expect(html).toContain("Patient Vitals")
      expect(html).toContain("BP (Systolic)")
      expect(html).toContain("BP (Diastolic)")
      expect(html).toContain("Heart Rate (bpm)")
      expect(html).toContain("SpO₂ (%)")
      expect(html).toContain("Temp (°F)")
      expect(html).toContain("Weight (kg)")

      expect(html).toContain("Medical Background")
      expect(html).toContain("Known Allergies")
      expect(html).toContain("Medical History")

      expect(html).toContain("Medicines List")
      expect(html).toContain("TAKATAK MR")
      expect(html).toContain("Tablet")

      expect(html).toContain("Follow-up &amp; Additional Advice")
      expect(html).toContain("Follow-up Date")
      expect(html).toContain("Additional Advice (ADV)")

      expect(html).not.toContain("Reason for revision")
      expect(html).toContain("Review changes")
    })

    it("allows direct revision without requiring any reason for revision", () => {
      let savedData: any = null
      const handleSave = vi.fn(async (data: any) => {
        savedData = data
      })

      // Modal rendered in edit step without mandatory revision reason
      const html = renderToString(
        <PrescriptionEditModal
          isOpen={true}
          onClose={vi.fn()}
          prescriptionNumber="RX-854704"
          currentRevisionNumber={1}
          initialMedicines={mockMedicines}
          initialVitals={mockVitals}
          initialConsultationData={mockConsultationData}
          patient={mockPatient}
          onSaveRevision={handleSave}
        />,
      )

      expect(html).not.toContain("Reason for revision")
      expect(html).not.toContain("min 5 characters")
      expect(html).toContain("Review changes")
    })
  })

  // =========================================================================
  // ISSUE 2: Custom Clinical Library Values in Edit Prescription
  // =========================================================================
  describe("ISSUE 2 — Custom Clinical Library Values in Edit Prescription", () => {
    it("loads and displays custom formulations, medicines, strengths, doses, frequencies, durations, and food instructions", () => {
      const customLib: ClinicalLibrary = {
        ...defaultClinicalLibrary,
        Formulations: [...defaultClinicalLibrary.Formulations, "Transdermal Patch"],
        Medicines: [...defaultClinicalLibrary.Medicines, "CUSTOM-PAIN-RELIEF 50"],
        Strengths: [...defaultClinicalLibrary.Strengths, "75 mg/mL"],
        Doses: [...defaultClinicalLibrary.Doses, "3 tablets"],
        Frequencies: [...defaultClinicalLibrary.Frequencies, "Every 4 hours"],
        Durations: [...defaultClinicalLibrary.Durations, "21 days"],
        FoodInstructions: [...defaultClinicalLibrary.FoodInstructions, "With warm milk"],
      }

      const customMedicines: Medicine[] = [
        {
          id: 1,
          formulation: "Transdermal Patch",
          name: "CUSTOM-PAIN-RELIEF 50",
          strength: "75 mg/mL",
          dose: "3 tablets",
          frequency: "Every 4 hours",
          duration: "21 days",
          food: "With warm milk",
        },
      ]

      const html = renderToString(
        <PrescriptionEditModal
          isOpen={true}
          onClose={vi.fn()}
          prescriptionNumber="RX-854704"
          currentRevisionNumber={1}
          initialMedicines={customMedicines}
          clinicalLibrary={customLib}
          onSaveRevision={vi.fn()}
        />,
      )

      expect(html).toContain("Transdermal Patch")
      expect(html).toContain("CUSTOM-PAIN-RELIEF 50")
      expect(html).toContain("75 mg/mL")
      expect(html).toContain("3 tablets")
      expect(html).toContain("Every 4 hours")
      expect(html).toContain("21 days")
      expect(html).toContain("With warm milk")
    })

    it("persists new custom library values with case-insensitive deduplication across restarts", () => {
      const clinicId = "clinic-custom-lib-test"
      let currentLib = loadClinicalLibrary(clinicId)

      // Add custom items
      currentLib = addClinicalLibraryItem(currentLib, "Medicines", "Azithromycin Forte", clinicId)
      currentLib = addClinicalLibraryItem(currentLib, "Medicines", "azithromycin forte", clinicId) // Case duplicate -> ignored
      currentLib = addClinicalLibraryItem(currentLib, "Formulations", "Nasal Spray", clinicId)

      // Verify immediate memory state
      expect(currentLib.Medicines.filter((m) => m.toLowerCase() === "azithromycin forte")).toHaveLength(1)
      expect(currentLib.Formulations).toContain("Nasal Spray")

      // Simulate app restart / reload from localStorage
      const reloaded = loadClinicalLibrary(clinicId)
      expect(reloaded.Medicines).toContain("Azithromycin Forte")
      expect(reloaded.Formulations).toContain("Nasal Spray")
    })
  })

  // =========================================================================
  // ISSUE 3: Conditional Investigation — Patient Missing After Ctrl+N
  // =========================================================================
  describe("ISSUE 3 — Conditional Investigation: Patient Presence on Dashboard", () => {
    it("verifies created patient remains visible in Dashboard when navigating after Ctrl+N", () => {
      // Step 1: Patient was created and saved
      const savedPatient: Patient = {
        id: "303f435e-1f45-4935-b442-7bc991023456",
        displayId: "AAA-0007",
        patientCode: "AAA-0007",
        name: "krishna",
        initials: "KR",
        age: 21,
        gender: "Female",
        phone: "8208096960",
        lastVisit: "2026-11-18T10:00:00",
        allergies: [],
        conditions: [],
      }

      // Step 2 & 3: Consultation completed & prescription previewed
      // Step 4: Ctrl + N opens Add New Patient form (state has empty form, patientRecords unchanged)
      // Step 5: User decides not to register another patient
      // Step 6: User navigates to Dashboard
      const allPatients = [savedPatient]

      const html = renderToString(
        <Dashboard
          go={vi.fn()}
          patients={allPatients}
          onOpenPatient={vi.fn()}
        />,
      )

      // Step 7: Verify patient is displayed on Dashboard
      expect(html).toContain("krishna")
      expect(html).toContain("AAA-0007")
      expect(html).toContain("Patient records")
      expect(html).toContain("<strong>1</strong>")
    })
  })

  // =========================================================================
  // ISSUE 4: Default Follow-up Date After Three Days
  // =========================================================================
  describe("ISSUE 4 — Default Follow-up Date After Three Days", () => {
    it("computes follow-up date exactly 3 calendar days after prescription date without timezone shifts", () => {
      // 18 November 2026 -> 21 November 2026
      const followUp1 = computeDefaultFollowUpDate("2026-11-18")
      expect(followUp1).toBe("2026-11-21")

      // Month rollover: 30 November 2026 -> 03 December 2026
      const followUp2 = computeDefaultFollowUpDate("2026-11-30")
      expect(followUp2).toBe("2026-12-03")

      // Year rollover: 30 December 2026 -> 02 January 2027
      const followUp3 = computeDefaultFollowUpDate("2026-12-30")
      expect(followUp3).toBe("2027-01-02")
    })

    it("createEmptyConsultationData automatically populates followUpDate with 3-day default", () => {
      const empty = createEmptyConsultationData("2026-11-18")
      expect(empty.date).toBe("2026-11-18")
      expect(empty.followUpDate).toBe("2026-11-21")
    })
  })

  // =========================================================================
  // ISSUE 5: Custom Diagnoses Dropdown & Persistence
  // =========================================================================
  describe("ISSUE 5 — Automatically Save Custom Diagnoses to Dropdown", () => {
    it("persists custom diagnosis to clinic suggestions and deduplicates case-insensitively", () => {
      const clinicId = "clinic-diag-test"

      expect(loadCustomDiagnoses(clinicId)).toEqual([])

      // Doctor finalizes consultation with custom diagnosis
      const updated1 = addCustomDiagnosis("Acute Sinusitis", clinicId)
      expect(updated1).toContain("Acute Sinusitis")

      // Case-insensitive duplicate does not add redundant item
      const updated2 = addCustomDiagnosis("acute sinusitis", clinicId)
      expect(updated2).toHaveLength(1)

      // Merged diagnosis options include default and custom options
      const merged = getDiagnosisOptions(updated2)
      expect(merged).toContain("Upper respiratory tract infection")
      expect(merged).toContain("Acute Sinusitis")

      // Survives reload from localStorage
      const reloaded = loadCustomDiagnoses(clinicId)
      expect(reloaded).toContain("Acute Sinusitis")
    })
  })

  // =========================================================================
  // ISSUE 6: Prescription Patient Name Typography (10% Larger & UPPERCASE)
  // =========================================================================
  describe("ISSUE 6 — Prescription Patient Name Typography", () => {
    it("wraps patient name with .rx-patient-name-val in Prescription Preview", () => {
      const html = renderToString(
        <PrescriptionPreview
          go={vi.fn()}
          patient={mockPatient}
          vitals={mockVitals}
          data={mockConsultationData}
          bannerVisible={false}
          bannerImage={null}
          signatureImage={null}
          showClinicLogo={false}
          showClinicEmail={false}
          showAllergyWarning={false}
          returnPage="consultation"
        />,
      )

      // Patient name value is separated into .rx-patient-name and in UPPERCASE (font-size: 14.52px, 1.1x of 13.2px)
      expect(html).toContain('<span class="rx-patient-name rx-patient-name-val">KRISHNA</span>')
      // Demographics are separated into .rx-patient-demographics with original formatting at base font-size
      expect(html).toContain('class="rx-patient-demographics rx-patient-age-gender"')
      expect(html).toContain("21 yrs · Female")
      // Patient ID remains unchanged
      expect(html).toContain("<strong>AAA-0007</strong>")
    })

    it("wraps patient name with .rx-patient-name-val in Bill Preview", () => {
      const mockBill = {
        invoiceNumber: "INV-001",
        date: "2026-11-18",
        status: "DRAFT" as const,
        paymentStatus: "Unpaid" as const,
        discount: 0,
        taxRatePercent: 0,
        items: [{ id: 1, description: "Consultation fee", quantity: 1, rate: 800 }],
      }

      const html = renderToString(
        <BillPreview
          go={vi.fn()}
          patient={mockPatient}
          bill={mockBill}
          bannerImage={null}
          signatureImage={null}
          layout={{
            showClinicLogo: false,
            showClinicEmail: false,
            showDoctorDetails: true,
            showPaymentStatus: true,
            compactRows: false,
            themeColor: "#068D94",
            headerStyle: "standard",
            dateFormat: "DD/MM/YYYY",
            showTaxNumber: false,
            showPaymentInstructions: false,
          }}
          returnPage="patient-profile"
        />,
      )

      expect(html).toContain('class="bill-patient-name"')
      expect(html).toContain('<span class="rx-patient-name-val">krishna</span>')
    })
  })
})
