import React from "react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderToString } from "react-dom/server"
import {
  type Medicine,
  type ClinicalLibrary,
  type Vitals,
  type ConsultationData,
  type Patient,
  defaultClinicalLibrary,
  normalizeMedicineList,
  normalizeMedicineItem,
  addClinicalLibraryItem,
  formatTime12Hour,
  getCurrentDeviceTime24,
  formatPrescriptionDateWithTime,
} from "./types"
import { PrescriptionEditModal } from "./components/consultation/PrescriptionEditModal"
import { reconstructHistoricalPrescription, executePrescriptionRevision } from "./routing/prescriptionRouting"
import {
  searchCatalogue,
  saveLocalConsultation,
  reviseLocalPrescription,
  type LocalPrescriptionRecord,
  type LocalConsultationRecord,
} from "./desktop/desktop-bridge"
import { SearchableOptionSelect } from "./components/common"

describe("Prescription Edit Modal — Reason Removal & Medicine Data Sync Suite", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.clear()
    }
  })

  const mockPatient: Patient = {
    id: "pat-123",
    displayId: "AAA-0026",
    fullName: "Himesh Reshmiya",
    mobile: "9876543210",
    ageYears: 34,
    gender: "Male",
    createdAt: "2026-11-18T10:00:00Z",
    allergies: ["Penicillin"],
    conditions: ["Hypertension"],
  }

  const mockVitals: Vitals = {
    systolic: "120",
    diastolic: "80",
    heartRate: "72",
    spo2: "99",
    temperature: "98.6",
    height: "175",
    weight: "70",
  }

  const mockMedicines: Medicine[] = [
    {
      id: 1,
      name: "TAKATAK MR",
      formulation: "Tablet",
      strength: "500 mg",
      dose: "1 tablet",
      frequency: "Once daily",
      duration: "3 days",
      food: "After food",
    },
  ]

  const mockConsultationData: ConsultationData = {
    date: "2026-11-18",
    time: "14:23",
    chiefComplaint: "Body ache and muscle spasm",
    symptomDuration: "2 days",
    diagnosis: "Acute Musculoskeletal Pain",
    medicines: mockMedicines,
    followUpDate: "2026-11-21",
    followUpInstructions: "Review if pain persists",
    allergies: ["Penicillin"],
    conditions: ["Hypertension"],
  }

  // =========================================================================
  // 1. REMOVE MANDATORY REVISION REASON TESTS
  // =========================================================================
  describe("1. Remove Mandatory Revision Reason", () => {
    it("renders the edit modal without 'Reason for revision' input or minimum character label", () => {
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

      expect(html).not.toContain("Reason for revision (Required, min 5 characters) *")
      expect(html).not.toContain("Reason for revision")
      expect(html).not.toContain("min 5 characters")
      expect(html).toContain("Review changes")
      expect(html).toContain("TAKATAK MR")
    })

    it("allows saving a revision without entering a revision reason", async () => {
      let savedRevisionData: any = null
      let savedReasonParam: any = null

      const handleSave = vi.fn(async (data: any, reason?: string) => {
        savedRevisionData = data
        savedReasonParam = reason
      })

      // We test through executePrescriptionRevision directly with no reason provided
      const mockRecord: LocalPrescriptionRecord = {
        id: "rx-uuid-1",
        server_id: null,
        clinic_id: "clinic-test-1",
        consultation_id: "c-uuid-1",
        patient_id: "pat-123",
        doctor_id: "doc-1",
        prescription_number: "RX-854704",
        revision_number: 1,
        status: "ACTIVE",
        items_json: JSON.stringify(mockMedicines),
        sync_status: "PENDING",
        server_version: 0,
        local_version: 1,
        created_at: "2026-11-18T10:00:00Z",
      }

      // executePrescriptionRevision accepts undefined/omitted reason and defaults safely
      const reviseBridgeMock = vi.fn().mockResolvedValue("rx-uuid-2")
      const fetchBridgeMock = vi.fn().mockResolvedValue([
        {
          ...mockRecord,
          id: "rx-uuid-2",
          revision_number: 2,
        },
      ])

      const result = await executePrescriptionRevision({
        currentRecord: mockRecord,
        clinicId: "clinic-test-1",
        patientId: "pat-123",
        medicines: mockMedicines,
        reviseBridge: reviseBridgeMock,
        fetchPrescriptionsBridge: fetchBridgeMock,
      })

      expect(reviseBridgeMock).toHaveBeenCalledWith(
        expect.objectContaining({
          prescription_id: "rx-uuid-1",
          expected_revision_number: 1,
          reason_for_revision: "Prescription revision",
        }),
      )
      expect(result.revision_number).toBe(2)
      expect(result.status).toBe("ACTIVE")
    })
  })

  // =========================================================================
  // 2. MEDICINE DATA NORMALIZATION & HYDRATION TESTS
  // =========================================================================
  describe("2. Medicine Data Normalization & Hydration", () => {
    it("normalizes backend and historical object shapes into standard medicine items", () => {
      const rawBackendItem = {
        name: "TAKATAK MR",
        formulation: "TABLET",
        strength: {
          display: "500 mg",
          components: [{ ingredientName: "Paracetamol", amount: 500, unit: "mg" }],
        },
        administeredDose: {
          magnitude: 1,
          unit: "TABLET",
        },
        frequency: {
          frequencyCode: "OD",
        },
        duration: {
          magnitude: 3,
          unit: "DAYS",
        },
        foodInstruction: "AFTER_MEALS",
      }

      const normalized = normalizeMedicineItem(rawBackendItem, 0)
      expect(normalized.name).toBe("TAKATAK MR")
      expect(normalized.formulation).toBe("Tablet")
      expect(normalized.strength).toBe("500 mg")
      expect(normalized.dose).toBe("1 tablet")
      expect(normalized.frequency).toBe("Once daily")
      expect(normalized.duration).toBe("3 days")
      expect(normalized.food).toBe("After food")
    })

    it("reconstructs historical prescription items from complex JSON safely", () => {
      const complexItems = [
        {
          name: "AMOXICILLIN",
          formulation: "CAPSULE",
          strength: { display: "250 mg" },
          administeredDose: { magnitude: 1, unit: "capsule" },
          frequency: { frequencyCode: "TID" },
          duration: { magnitude: 5, unit: "days" },
          foodInstruction: "WITH_MEALS",
        },
      ]

      const mockRecord: LocalPrescriptionRecord = {
        id: "rx-hist-1",
        server_id: null,
        clinic_id: "clinic-test-1",
        consultation_id: "c-hist-1",
        patient_id: "pat-123",
        doctor_id: "doc-1",
        prescription_number: "RX-004803",
        revision_number: 1,
        status: "ACTIVE",
        items_json: JSON.stringify(complexItems),
        sync_status: "PENDING",
        server_version: 0,
        local_version: 1,
        created_at: "2026-11-18T10:00:00Z",
      }

      const { consultationData, itemsError } = reconstructHistoricalPrescription(mockRecord)
      expect(itemsError).toBeNull()
      expect(consultationData.medicines).toHaveLength(1)
      expect(consultationData.medicines[0].name).toBe("AMOXICILLIN")
      expect(consultationData.medicines[0].formulation).toBe("Capsule")
      expect(consultationData.medicines[0].strength).toBe("250 mg")
      expect(consultationData.medicines[0].dose).toBe("1 capsule")
      expect(consultationData.medicines[0].frequency).toBe("Three times daily")
      expect(consultationData.medicines[0].duration).toBe("5 days")
      expect(consultationData.medicines[0].food).toBe("With food")
    })
  })

  // =========================================================================
  // 3. CUSTOM CLINICAL LIBRARY & OPTIONS IN EDIT MODAL
  // =========================================================================
  describe("3. Custom Clinical Library & Selectable Options", () => {
    it("renders custom formulations, strengths, doses, frequencies, durations, and food instructions", () => {
      const customLib: ClinicalLibrary = {
        ...defaultClinicalLibrary,
        Formulations: [...defaultClinicalLibrary.Formulations, "Inhaler (Custom)"],
        Medicines: [...defaultClinicalLibrary.Medicines, "BUDESONIDE 200"],
        Strengths: [...defaultClinicalLibrary.Strengths, "200 mcg/puff"],
        Doses: [...defaultClinicalLibrary.Doses, "2 puffs"],
        Frequencies: [...defaultClinicalLibrary.Frequencies, "Twice daily morning and night"],
        Durations: [...defaultClinicalLibrary.Durations, "30 days"],
        FoodInstructions: [...defaultClinicalLibrary.FoodInstructions, "Rinse mouth after use"],
      }

      const customMed: Medicine = {
        id: 1,
        name: "BUDESONIDE 200",
        formulation: "Inhaler (Custom)",
        strength: "200 mcg/puff",
        dose: "2 puffs",
        frequency: "Twice daily morning and night",
        duration: "30 days",
        food: "Rinse mouth after use",
      }

      const html = renderToString(
        <PrescriptionEditModal
          isOpen={true}
          onClose={vi.fn()}
          prescriptionNumber="RX-854704"
          currentRevisionNumber={1}
          initialMedicines={[customMed]}
          initialVitals={mockVitals}
          initialConsultationData={{
            ...mockConsultationData,
            medicines: [customMed],
          }}
          patient={mockPatient}
          clinicalLibrary={customLib}
          onSaveRevision={vi.fn()}
        />,
      )

      expect(html).toContain("Inhaler (Custom)")
      expect(html).toContain("BUDESONIDE 200")
      expect(html).toContain("200 mcg/puff")
      expect(html).toContain("2 puffs")
      expect(html).toContain("Twice daily morning and night")
      expect(html).toContain("30 days")
      expect(html).toContain("Rinse mouth after use")
    })

    it("addClinicalLibraryItem correctly persists newly typed custom medicine fields across sessions", () => {
      let lib = defaultClinicalLibrary
      const clinicId = "clinic-456"

      lib = addClinicalLibraryItem(lib, "Medicines", "NEW-MED-2026", clinicId)
      lib = addClinicalLibraryItem(lib, "Formulations", "Transdermal Gel", clinicId)
      lib = addClinicalLibraryItem(lib, "Strengths", "1.5% w/w", clinicId)
      lib = addClinicalLibraryItem(lib, "Doses", "Pea-sized amount", clinicId)
      lib = addClinicalLibraryItem(lib, "Frequencies", "Every alternate day", clinicId)
      lib = addClinicalLibraryItem(lib, "Durations", "14 days", clinicId)
      lib = addClinicalLibraryItem(lib, "FoodInstructions", "Before sleeping", clinicId)

      expect(lib.Medicines).toContain("NEW-MED-2026")
      expect(lib.Formulations).toContain("Transdermal Gel")
      expect(lib.Strengths).toContain("1.5% w/w")
      expect(lib.Doses).toContain("Pea-sized amount")
      expect(lib.Frequencies).toContain("Every alternate day")
      expect(lib.Durations).toContain("14 days")
      expect(lib.FoodInstructions).toContain("Before sleeping")
    })
  })

  // =========================================================================
  // 4. MEDICINE NAME CATALOGUE SEARCH & AUTOCOMPLETE IN EDIT MODAL
  // =========================================================================
  describe("4. Medicine Name Catalogue Search & Autocomplete in Edit Modal", () => {
    it("renders medicine search field with identical placeholder and search options as New Consultation", () => {
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

      expect(html).toContain("Search medicine")
      expect(html).toContain('aria-label="Search and select medicine"')
      expect(html).toContain("TAKATAK MR")
    })

    it("connects to medicine catalogue search and retrieves matching medicines", async () => {
      const searchRes = await searchCatalogue("Amox")
      expect(searchRes).toBeDefined()
      expect(searchRes.items.length).toBeGreaterThan(0)
      const first = searchRes.items[0]
      expect(first.name).toBeDefined()
      expect(first.dosageForm).toBeDefined()
    })

    it("renders multiple medicine rows with independent search comboboxes in Edit Modal", () => {
      const html = renderToString(
        <PrescriptionEditModal
          isOpen={true}
          onClose={vi.fn()}
          prescriptionNumber="RX-854704"
          currentRevisionNumber={1}
          initialMedicines={[
            {
              id: 1,
              name: "Amoxicillin",
              formulation: "Tablet",
              strength: "500 mg",
              dose: "1 tablet",
              frequency: "Twice daily",
              duration: "5 days",
              food: "After food",
            },
            {
              id: 2,
              name: "Paracetamol",
              formulation: "Tablet",
              strength: "650 mg",
              dose: "1 tablet",
              frequency: "As needed",
              duration: "3 days",
              food: "After food",
            },
          ]}
          initialVitals={mockVitals}
          initialConsultationData={mockConsultationData}
          patient={mockPatient}
          onSaveRevision={vi.fn()}
        />,
      )

      expect(html).toContain('id="edit-med-name-1"')
      expect(html).toContain('id="edit-med-name-2"')
      expect(html).toContain('value="Amoxicillin"')
      expect(html).toContain('value="Paracetamol"')
    })

    it("renders SearchableOptionSelect with badges and subtitles for clinic library and stock definitions", () => {
      const html = renderToString(
        <SearchableOptionSelect
          id="test-med-select"
          value="Amoxicillin + Clavulanic Acid"
          options={[
            {
              value: "Amoxicillin + Clavulanic Acid",
              label: "Amoxicillin + Clavulanic Acid",
              badge: "Clinic Library",
              subtitle: "Tablet • 625 mg • Amoxicillin and Potassium Clavulanate",
            },
            {
              value: "Amoxicillin 500mg",
              label: "Amoxicillin 500mg",
              badge: "Pharmacy Stock",
              subtitle: "Capsule • 500 mg",
            },
          ]}
          onChange={vi.fn()}
          placeholder="Search medicine"
          ariaLabel="Search and select medicine"
        />,
      )

      expect(html).toContain('id="test-med-select"')
      expect(html).toContain('value="Amoxicillin + Clavulanic Acid"')
      expect(html).toContain('placeholder="Search medicine"')
      expect(html).toContain('role="combobox"')
    })
  })

  // =========================================================================
  // 5. LOCAL CONSULTATION PERSISTENCE & CURRENT DEVICE TIME IN EDIT MODAL
  // =========================================================================
  describe("5. Local Consultation Persistence & Current Device Time in Edit Modal", () => {
    it("ensures saveLocalConsultation is defined, callable, and exports from desktop-bridge", () => {
      expect(saveLocalConsultation).toBeDefined()
      expect(typeof saveLocalConsultation).toBe("function")
    })

    it("initializes Consultation Time with current local device time while preserving original consultation date", () => {
      const pastConsultationData: ConsultationData = {
        ...mockConsultationData,
        date: "2026-11-10",
        time: "09:15", // Old consultation time from days ago
      }

      const expectedCurrentTime = getCurrentDeviceTime24()
      expect(expectedCurrentTime).toMatch(/^\d{2}:\d{2}$/)

      const html = renderToString(
        <PrescriptionEditModal
          isOpen={true}
          onClose={vi.fn()}
          prescriptionNumber="RX-854704"
          currentRevisionNumber={1}
          initialMedicines={mockMedicines}
          initialVitals={mockVitals}
          initialConsultationData={pastConsultationData}
          patient={mockPatient}
          onSaveRevision={vi.fn()}
        />,
      )

      // Retains original consultation date (does not arbitrarily change the date)
      expect(html).toContain('value="2026-11-10"')

      // Displays the current local device time rather than stale 09:15
      expect(html).toContain(`value="${expectedCurrentTime}"`)
    })

    it("formatTime12Hour formats both 24-hour and 12-hour timestamps accurately with AM/PM", () => {
      expect(formatTime12Hour("10:31")).toBe("10:31 AM")
      expect(formatTime12Hour("14:45")).toBe("02:45 PM")
      expect(formatTime12Hour("00:05")).toBe("12:05 AM")
      expect(formatTime12Hour("12:00")).toBe("12:00 PM")
      expect(formatTime12Hour("10:31 AM")).toBe("10:31 AM")
      expect(formatTime12Hour("02:45 pm")).toBe("02:45 PM")
      expect(formatTime12Hour("")).toBe("")
      expect(formatTime12Hour(null)).toBe("")
    })

    it("formatPrescriptionDateWithTime integrates 12-hour AM/PM format for preview and printing", () => {
      expect(formatPrescriptionDateWithTime("2026-11-19", "10:31")).toBe("19/11/2026, 10:31 AM")
      expect(formatPrescriptionDateWithTime("2026-11-19", "15:20")).toBe("19/11/2026, 03:20 PM")
    })

    it("persists revision with updated consultation time and links new consultation ID in SQLite", async () => {
      const mockConsultationId = "cons-new-rev-2"
      const mockReviseId = "rx-rev-2-id"

      const mockReviseBridge = vi.fn().mockResolvedValue(mockReviseId)
      const mockFetchPrescriptionsBridge = vi.fn().mockResolvedValue([
        {
          id: mockReviseId,
          clinic_id: "clinic-test",
          prescription_number: "RX-733323",
          revision_number: 2,
          status: "ACTIVE",
          consultation_id: mockConsultationId,
          items_json: JSON.stringify(mockMedicines),
          created_at: "2026-11-19T10:35:00Z",
        },
      ])

      const currentRecord: LocalPrescriptionRecord = {
        id: "rx-orig-id",
        server_id: null,
        clinic_id: "clinic-test",
        consultation_id: "cons-orig-id",
        patient_id: "pat-123",
        doctor_id: "doc-1",
        prescription_number: "RX-733323",
        revision_number: 1,
        status: "ACTIVE",
        items_json: JSON.stringify(mockMedicines),
        reason_for_revision: null,
        sync_status: "PENDING",
        server_version: 1,
        local_version: 1,
        created_at: "2026-11-18T10:31:00Z",
        updated_at: "2026-11-18T10:31:00Z",
      }

      const revisedRecord = await executePrescriptionRevision({
        currentRecord,
        clinicId: "clinic-test",
        patientId: "pat-123",
        medicines: mockMedicines,
        reasonForRevision: "Updated clinical notes and time",
        newConsultationId: mockConsultationId,
        reviseBridge: mockReviseBridge as any,
        fetchPrescriptionsBridge: mockFetchPrescriptionsBridge as any,
      })

      expect(mockReviseBridge).toHaveBeenCalledWith({
        clinic_id: "clinic-test",
        prescription_id: "rx-orig-id",
        expected_revision_number: 1,
        items_json: JSON.stringify(mockMedicines),
        reason_for_revision: "Updated clinical notes and time",
        new_consultation_id: mockConsultationId,
      })

      expect(revisedRecord.id).toBe(mockReviseId)
      expect(revisedRecord.revision_number).toBe(2)
      expect(revisedRecord.consultation_id).toBe(mockConsultationId)
    })

    it("reconstructHistoricalPrescription reconstructs revised consultation details while preserving immutability", () => {
      const rxRecord: LocalPrescriptionRecord = {
        id: "rx-rev-2-id",
        server_id: null,
        clinic_id: "clinic-test",
        consultation_id: "cons-rev-2",
        patient_id: "pat-123",
        doctor_id: "doc-1",
        prescription_number: "RX-733323",
        revision_number: 2,
        status: "ACTIVE",
        items_json: JSON.stringify(mockMedicines),
        reason_for_revision: "Prescription revision",
        sync_status: "PENDING",
        server_version: 1,
        local_version: 1,
        created_at: "2026-11-19T10:35:00Z",
        updated_at: "2026-11-19T10:35:00Z",
      }

      const matchedConsultation: LocalConsultationRecord = {
        id: "cons-rev-2",
        server_id: null,
        clinic_id: "clinic-test",
        patient_id: "pat-123",
        doctor_id: "doc-1",
        consultation_date: "2026-11-19T10:35",
        status: "ACTIVE",
        chief_complaint: "fever (5 days)",
        diagnosis: "Viral fever",
        clinical_snapshot_json: JSON.stringify({
          vitals: mockVitals,
          time: "10:35",
          consultationTime: "10:35",
          consultationDate: "2026-11-19",
          symptomDuration: "5 days",
        }),
        sync_status: "PENDING",
        server_version: 1,
        local_version: 1,
        updated_at: "2026-11-19T10:35:00Z",
      }

      const reconstructed = reconstructHistoricalPrescription(
        rxRecord,
        matchedConsultation,
      )

      expect(reconstructed.consultationData.date).toBe("2026-11-19")
      expect(reconstructed.consultationData.time).toBe("10:35")
      expect(reconstructed.consultationData.chiefComplaint).toBe("fever (5 days)")
      expect(reconstructed.consultationData.diagnosis).toBe("Viral fever")
    })
  })
})
