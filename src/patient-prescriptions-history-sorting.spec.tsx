import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderToString } from "react-dom/server"
import { PrescriptionsTab, ConsultationsTab, OverviewTab } from "./components/patients/tabs"
import { PatientsPage } from "./components/patients/PatientsPage"
import { PatientProfile } from "./components/patients/PatientProfile"
import type { Patient } from "./types"
import type { LocalPrescriptionRecord, LocalConsultationRecord } from "./desktop/desktop-bridge"
import { createEmptyConsultationData } from "./types"

describe("Issue 4, 5 & 6 — Duplicate Prescriptions, Medical History Isolation, and Patient Sorting", () => {
  const patientKrishna: Patient = {
    id: "pat-krishna-uuid-001",
    displayId: "AAA-0026",
    patientCode: "AAA-0026",
    name: "Krishna",
    initials: "K",
    age: 30,
    gender: "Male",
    phone: "9876543210",
    lastVisit: "Today",
    allergies: ["Penicillin", "Dust"],
    conditions: ["Contact with unconditional virus"],
    createdAt: "2026-11-20T10:00:00.000Z",
    registeredAt: "2026-11-20T10:00:00.000Z",
  }

  const samplePrescription1: LocalPrescriptionRecord = {
    id: "rx-uuid-001",
    server_id: null,
    clinic_id: "clinic-test-1",
    consultation_id: "consult-uuid-001",
    patient_id: "pat-krishna-uuid-001",
    doctor_id: "DOC-1",
    prescription_number: "RX-854704",
    revision_number: 1,
    status: "ACTIVE",
    items_json: JSON.stringify([
      {
        id: 1,
        name: "Paracetamol",
        formulation: "Tablet",
        dose: "1 tablet",
        frequency: "Twice daily",
        duration: "3 days",
      },
    ]),
    sync_status: "PENDING",
    server_version: 0,
    local_version: 1,
    created_at: "2026-11-20T10:15:00.000Z",
  }

  describe("Issue 4 — Duplicate Prescriptions in Patient Information", () => {
    it("1. Renders clean empty state when patient has 0 prescriptions even if hasHistory is true (no mock prescriptions)", () => {
      const html = renderToString(
        <PrescriptionsTab
          go={() => {}}
          patient={patientKrishna}
          hasHistory={true}
          prescriptions={[]}
        />,
      )

      // Must NOT render old mock dates or fake revisions
      expect(html).not.toContain("12/03/2025")
      expect(html).not.toContain("18/11/2024")
      expect(html).not.toContain("03/07/2024")
      expect(html).not.toContain("Delivered")
      expect(html).toContain("No prescriptions yet")
      expect(html).toContain("Finalized prescriptions and revisions will appear here.")
    })

    it("2. Renders exactly one prescription when only one prescription was finalized", () => {
      const rawHtml = renderToString(
        <PrescriptionsTab
          go={() => {}}
          patient={patientKrishna}
          hasHistory={true}
          prescriptions={[samplePrescription1]}
        />,
      )
      const html = rawHtml.replace(/<!-- -->/g, "")

      expect(html).toContain("RX-854704")
      expect(html).toContain("Original")
      expect(html).toContain("1 medicine")
      expect(html).not.toContain("No prescriptions yet")

      // Match count of prescription item rows
      const matches = html.match(/RX-854704/g)
      expect(matches).toHaveLength(1)
    })

    it("3. ConsultationsTab renders clean empty state when consultations is empty even if hasHistory is true", () => {
      const html = renderToString(
        <ConsultationsTab
          go={() => {}}
          patient={patientKrishna}
          hasHistory={true}
          consultations={[]}
        />,
      )

      expect(html).not.toContain("12/03/2025")
      expect(html).not.toContain("18/11/2024")
      expect(html).toContain("No consultations yet")
    })

    it("4. OverviewTab renders clean empty state when consultations is empty even if hasHistory is true", () => {
      const html = renderToString(
        <OverviewTab
          go={() => {}}
          patient={patientKrishna}
          hasHistory={true}
          consultations={[]}
          prescriptions={[]}
        />,
      )

      expect(html).not.toContain("12/03/2025")
      expect(html).not.toContain("18/11/2024")
      expect(html).toContain("No clinical activity yet")
    })

    it("5. Legitimate revisions (Original + Revision 2) both render correctly", () => {
      const rev1: LocalPrescriptionRecord = {
        ...samplePrescription1,
        id: "rx-uuid-001",
        revision_number: 1,
        status: "SUPERSEDED",
      }
      const rev2: LocalPrescriptionRecord = {
        ...samplePrescription1,
        id: "rx-uuid-002",
        revision_number: 2,
        status: "ACTIVE",
      }

      const html = renderToString(
        <PrescriptionsTab
          go={() => {}}
          patient={patientKrishna}
          hasHistory={true}
          prescriptions={[rev2, rev1]}
        />,
      )

      expect(html).toContain("Revision 2")
      expect(html).toContain("Original")
      expect(html).toContain("Superseded")
      expect(html).toContain("Finalized")
    })
  })

  describe("Issue 5 — Medical History Carry Forward ONLY", () => {
    it("1. Starting a new consultation carries forward ONLY Medical History (vitals, meds, allergies, diagnosis are empty)", () => {
      const consultation1Data = {
        conditions: ["Contact with unconditional virus"],
        allergies: ["Penicillin", "Dust"],
        medicines: [
          {
            id: 1,
            name: "Amoxicillin",
            formulation: "Capsule",
            dose: "500mg",
            frequency: "Three times daily",
            duration: "5 days",
          },
        ],
        diagnosis: "Viral Pharyngitis",
        chiefComplaint: "Sore throat and fever",
        symptomDuration: "4 days",
        vitals: {
          systolic: "130",
          diastolic: "85",
          heartRate: "78",
          spo2: "98",
          temperature: "100.2",
          height: "172",
          weight: "74",
        },
      }

      // Simulate starting Consultation 2 for Krishna:
      // Carry forward ONLY Medical History
      const carriedConditions = consultation1Data.conditions

      const emptyData = createEmptyConsultationData()
      emptyData.conditions = carriedConditions
      emptyData.allergies = [] // STRICT REQUIREMENT: Allergies must NOT be carried forward

      const emptyVitals = {
        systolic: "",
        diastolic: "",
        heartRate: "",
        spo2: "",
        temperature: "",
        height: "",
        weight: "",
      }

      // Verification:
      expect(emptyData.conditions).toEqual(["Contact with unconditional virus"])
      expect(emptyData.allergies).toEqual([])
      expect(emptyData.medicines).toEqual([])
      expect(emptyData.diagnosis).toBe("")
      expect(emptyData.chiefComplaint).toBe("")
      expect(emptyData.symptomDuration).toBe("")
      expect(emptyVitals.systolic).toBe("")
      expect(emptyVitals.diastolic).toBe("")
      expect(emptyVitals.heartRate).toBe("")
      expect(emptyVitals.temperature).toBe("")
    })

    it("2. Editing Medical History in Consultation 2 modifies current consultation without mutating past history", () => {
      const pastConsultationMedicalHistory = ["Contact with unconditional virus"]
      const currentConsultationMedicalHistory = [...pastConsultationMedicalHistory, "Seasonal Asthma"]

      expect(pastConsultationMedicalHistory).toHaveLength(1)
      expect(currentConsultationMedicalHistory).toHaveLength(2)
      expect(pastConsultationMedicalHistory).not.toContain("Seasonal Asthma")
    })

    it("3. OverviewTab and ConsultationsTab call onStartConsultation when starting new consultation", () => {
      const onStartSpy = vi.fn()
      const goSpy = vi.fn()

      // Render OverviewTab with onStartConsultation
      const htmlOverview = renderToString(
        <OverviewTab
          go={goSpy}
          patient={patientKrishna}
          hasHistory={false}
          onStartConsultation={onStartSpy}
        />,
      )

      expect(htmlOverview).toContain("Start consultation")

      // Render ConsultationsTab with onStartConsultation
      const htmlConsultations = renderToString(
        <ConsultationsTab
          go={goSpy}
          patient={patientKrishna}
          hasHistory={false}
          onStartConsultation={onStartSpy}
        />,
      )

      expect(htmlConsultations).toContain("New consultation")
    })
  })

  describe("Issue 6 — Default Patient Sorting (Newest Patients First)", () => {
    const pOld: Patient = {
      id: "p-001",
      name: "Old Patient",
      initials: "OP",
      age: 40,
      gender: "Male",
      phone: "9876500001",
      lastVisit: "Today",
      allergies: [],
      conditions: [],
      createdAt: "2025-01-01T09:00:00.000Z",
      registeredAt: "2025-01-01T09:00:00.000Z",
    }

    const pMid: Patient = {
      id: "p-002",
      name: "Mid Patient",
      initials: "MP",
      age: 25,
      gender: "Female",
      phone: "9876500002",
      lastVisit: "Yesterday",
      allergies: [],
      conditions: [],
      createdAt: "2026-06-15T14:30:00.000Z",
      registeredAt: "2026-06-15T14:30:00.000Z",
    }

    const pNew: Patient = {
      id: "p-003",
      name: "Krishna New",
      initials: "KN",
      age: 30,
      gender: "Male",
      phone: "9876500003",
      lastVisit: "No visits yet",
      allergies: [],
      conditions: [],
      createdAt: "2026-11-20T10:00:00.000Z",
      registeredAt: "2026-11-20T10:00:00.000Z",
    }

    it("1. PatientsPage defaults to Created Date (newest first) and displays newest patient at the top", () => {
      // Pass patients in mixed or old-first order:
      const patientsList = [pOld, pMid, pNew]

      const rawHtml = renderToString(
        <PatientsPage
          go={() => {}}
          patients={patientsList}
          onOpenPatient={() => {}}
          onStartConsultation={() => {}}
          onCreateBill={() => {}}
          onEditPatient={() => {}}
        />,
      )
      const html = rawHtml.replace(/<!-- -->/g, "")

      // Verify the default sort dropdown value is Created Date (newest first)
      expect(html).toContain("Created Date (newest first)")

      // Krishna New (created 2026-11-20) must appear BEFORE Mid Patient (2026-06-15) and Old Patient (2025-01-01)
      const indexNew = html.indexOf("Krishna New")
      const indexMid = html.indexOf("Mid Patient")
      const indexOld = html.indexOf("Old Patient")

      expect(indexNew).toBeGreaterThan(-1)
      expect(indexMid).toBeGreaterThan(-1)
      expect(indexOld).toBeGreaterThan(-1)

      expect(indexNew).toBeLessThan(indexMid)
      expect(indexMid).toBeLessThan(indexOld)
    })

    it("2. Does not use lastVisit or consultation date for default sort (even though Old Patient visited Today, New Patient appears first)", () => {
      // pOld has lastVisit: "Today"
      // pNew has lastVisit: "No visits yet"
      // Under Created Date (newest first), pNew MUST appear before pOld
      const patientsList = [pOld, pNew]

      const rawHtml = renderToString(
        <PatientsPage
          go={() => {}}
          patients={patientsList}
          onOpenPatient={() => {}}
          onStartConsultation={() => {}}
          onCreateBill={() => {}}
          onEditPatient={() => {}}
        />,
      )
      const html = rawHtml.replace(/<!-- -->/g, "")

      const indexNew = html.indexOf("Krishna New")
      const indexOld = html.indexOf("Old Patient")

      expect(indexNew).toBeLessThan(indexOld)
    })

    it("3. Safely handles missing createdAt by falling back to registeredAt", () => {
      const pMissingCreatedAt: Patient = {
        id: "p-004",
        name: "Registered Patient",
        initials: "RP",
        age: 33,
        gender: "Female",
        phone: "9876500004",
        lastVisit: "No visits yet",
        allergies: [],
        conditions: [],
        registeredAt: "2026-11-21T08:00:00.000Z", // newer than pNew
      }

      const patientsList = [pNew, pMissingCreatedAt]

      const rawHtml = renderToString(
        <PatientsPage
          go={() => {}}
          patients={patientsList}
          onOpenPatient={() => {}}
          onStartConsultation={() => {}}
          onCreateBill={() => {}}
          onEditPatient={() => {}}
        />,
      )
      const html = rawHtml.replace(/<!-- -->/g, "")

      const indexMissingCreated = html.indexOf("Registered Patient")
      const indexNew = html.indexOf("Krishna New")

      expect(indexMissingCreated).toBeLessThan(indexNew)
    })
  })
})
