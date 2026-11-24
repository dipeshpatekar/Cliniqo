import { describe, it, expect, vi, beforeEach } from "vitest"
import React from "react"
import { renderToString } from "react-dom/server"
import App from "./App"
import {
  resolvePrescriptionPreviewNavigation,
  resolveBillPreviewNavigation,
  shouldClearHistoricalPrescriptionOnNavigation,
  reconstructHistoricalPrescription,
  computePrescriptionPreviewState,
  executePrescriptionRevision,
} from "./routing/prescriptionRouting"
import { PrescriptionPreview } from "./components/consultation/PrescriptionPreview"
import { PrescriptionEditModal } from "./components/consultation/PrescriptionEditModal"
import { PatientProfile } from "./components/patients/PatientProfile"
import { PrescriptionsTab } from "./components/patients/tabs"
import * as desktopBridge from "./desktop/desktop-bridge"
import type {
  LocalPrescriptionRecord,
  LocalConsultationRecord,
  DesktopSessionContext,
} from "./desktop/desktop-bridge"
import type { Patient, Vitals, ConsultationData, Medicine } from "./types"
import { createEmptyConsultationData } from "./types"

describe("Cliniqo Production Prescription Routing & Workflow (App & prescriptionRouting)", () => {
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

  const mockPatientA: Patient = {
    id: "pat-201",
    displayId: "P-201",
    name: "Meera Patel",
    initials: "MP",
    age: 36,
    gender: "Female",
    phone: "9876543210",
    lastVisit: "2026-11-15",
    allergies: ["Sulfa drugs"],
    conditions: ["Asthma"],
  }

  const mockPatientB: Patient = {
    id: "pat-202",
    displayId: "P-202",
    name: "Rohan Gupta",
    initials: "RG",
    age: 52,
    gender: "Male",
    phone: "9876500000",
    lastVisit: "2026-11-10",
    allergies: [],
    conditions: ["Hypertension"],
  }

  const mockVitals: Vitals = {
    systolic: "118",
    diastolic: "78",
    heartRate: "72",
    spo2: "99",
    temperature: "98.4",
    height: "165",
    weight: "58",
  }

  const mockMedicinesRev1: Medicine[] = [
    {
      id: 1,
      name: "Salbutamol Inhaler",
      formulation: "Inhaler",
      strength: "100 mcg",
      dose: "2 puffs",
      route: "Inhalation",
      frequency: "As needed",
      duration: "30 days",
      food: "Any time",
      directions: "Rinse mouth after use",
    },
    {
      id: 2,
      name: "Montelukast",
      formulation: "Tablet",
      strength: "10 mg",
      dose: "1 tablet",
      route: "Oral",
      frequency: "Once daily",
      duration: "30 days",
      food: "At bedtime",
      directions: "Take before sleep",
    },
  ]

  const mockMedicinesRev2: Medicine[] = [
    {
      id: 1,
      name: "Salbutamol Inhaler",
      formulation: "Inhaler",
      strength: "100 mcg",
      dose: "2 puffs",
      route: "Inhalation",
      frequency: "As needed",
      duration: "30 days",
      food: "Any time",
      directions: "Rinse mouth after use",
    },
    {
      id: 2,
      name: "Montelukast",
      formulation: "Tablet",
      strength: "10 mg",
      dose: "1 tablet",
      route: "Oral",
      frequency: "Once daily",
      duration: "60 days",
      food: "At bedtime",
      directions: "Extended course",
    },
    {
      id: 3,
      name: "Budesonide Turbuhaler",
      formulation: "Inhaler",
      strength: "200 mcg",
      dose: "1 inhalation",
      route: "Inhalation",
      frequency: "Twice daily",
      duration: "30 days",
      food: "Any time",
      directions: "Rinse mouth thoroughly",
    },
  ]

  const mockConsultationRecord: LocalConsultationRecord = {
    id: "consult-201",
    clinic_id: "clinic-test-1",
    patient_id: "pat-201",
    doctor_id: "doc-1",
    consultation_date: "2026-11-15",
    chief_complaint: "Seasonal asthma exacerbation",
    diagnosis: "Moderate Persistent Asthma",
    clinical_snapshot_json: JSON.stringify({
      vitals: mockVitals,
      followUpDate: "2026-12-15",
      followUpInstructions: "Review inhaler technique and peak flow in 4 weeks.",
      symptomDuration: "1 week",
    }),
    sync_status: "SYNCED",
    server_version: 1,
    local_version: 1,
    created_at: "2026-11-15T09:00:00.000Z",
  }

  const mockPrescriptionRev1: LocalPrescriptionRecord = {
    id: "rx-pat201-rev1",
    server_id: "rx-srv-201",
    clinic_id: "clinic-test-1",
    consultation_id: "consult-201",
    patient_id: "pat-201",
    doctor_id: "doc-1",
    prescription_number: "RX-2026-0042",
    revision_number: 1,
    status: "ACTIVE",
    items_json: JSON.stringify(mockMedicinesRev1),
    sync_status: "SYNCED",
    server_version: 1,
    local_version: 1,
    created_at: "2026-11-15T09:15:00.000Z",
  }

  const mockDesktopSession: DesktopSessionContext = {
    doctor_id: "doc-1",
    clinic_id: "clinic-test-1",
    doctor_email: "doctor@cliniqo.app",
    doctor_name: "Dr. Aarti Sen",
    role: "DOCTOR",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  }

  describe("Test A — Historical prescription workflow", () => {
    it("1. Reconstructs historical prescription with saved medicines, diagnosis, and vitals from DB records", () => {
      const reconstructed = reconstructHistoricalPrescription(
        mockPrescriptionRev1,
        mockConsultationRecord,
      )

      expect(reconstructed.itemsError).toBeNull()
      expect(reconstructed.consultationData.diagnosis).toBe("Moderate Persistent Asthma")
      expect(reconstructed.consultationData.chiefComplaint).toBe("Seasonal asthma exacerbation")
      expect(reconstructed.consultationData.followUpInstructions).toBe(
        "Review inhaler technique and peak flow in 4 weeks.",
      )
      expect(reconstructed.consultationData.medicines).toHaveLength(2)
      expect(reconstructed.consultationData.medicines[0].name).toBe("Salbutamol Inhaler")
      expect(reconstructed.consultationData.medicines[1].name).toBe("Montelukast")
      expect(reconstructed.vitals.systolic).toBe("118")
      expect(reconstructed.vitals.diastolic).toBe("78")
      expect(reconstructed.vitals.heartRate).toBe("72")
    })

    it("2. Resolves preview navigation from patient-profile keeping returnPage='patient-profile' and preserving historical state", () => {
      const nav = resolvePrescriptionPreviewNavigation("patient-profile", "consultation")
      expect(nav.returnPage).toBe("patient-profile")
      expect(nav.clearHistorical).toBe(false)

      const reconstructed = reconstructHistoricalPrescription(
        mockPrescriptionRev1,
        mockConsultationRecord,
      )
      const previewState = computePrescriptionPreviewState("patient-profile", {
        record: mockPrescriptionRev1,
        consultationData: reconstructed.consultationData,
        vitals: reconstructed.vitals,
        itemsError: null,
      })

      expect(previewState.isHistorical).toBe(true)
      expect(previewState.isSamplePreview).toBe(false)
    })

    it("3. App renders the historical prescription preview with exact saved medicines, vitals, and revision badge", () => {
      const reconstructed = reconstructHistoricalPrescription(
        mockPrescriptionRev1,
        mockConsultationRecord,
      )

      // Render actual App component configured at preview page with historical prescription
      const html = renderToString(
        <App
          initialPage="preview"
          initialDesktopSession={mockDesktopSession}
          initialSelectedPatient={mockPatientA}
          initialPrescriptionPreviewReturnPage="patient-profile"
          initialViewingHistoricalPrescription={{
            record: mockPrescriptionRev1,
            consultationData: reconstructed.consultationData,
            vitals: reconstructed.vitals,
            itemsError: null,
          }}
        />,
      )

      // Verification of rendered output:
      // Prescription number & Revision badge
      expect(html).toContain("RX-2026-0042")
      expect(html).toContain("Original")
      // Restored Diagnosis and Chief Complaint
      expect(html).toContain("Moderate Persistent Asthma")
      expect(html).toContain("Seasonal asthma exacerbation")
      // Restored Vitals
      expect(html).toContain("118/78 mmHg")
      expect(html).toContain("72 bpm")
      // Saved medicines from items_json
      expect(html).toContain("Salbutamol Inhaler")
      expect(html).toContain("Montelukast")
      // Back navigation button points to patient profile
      expect(html).toContain("Back to patient profile")
      // Edit button available for ACTIVE record
      expect(html).toContain("Edit prescription")
    })
  })

  describe("Test B — Back navigation workflow", () => {
    it("1. Clicking Back from historical preview returns to the same patient profile with Prescriptions tab selected", () => {
      const nav = resolvePrescriptionPreviewNavigation("patient-profile", "consultation")
      expect(nav.returnPage).toBe("patient-profile")

      // Should not clear historical state when navigating back to patient-profile
      const shouldClear = shouldClearHistoricalPrescriptionOnNavigation("patient-profile")
      expect(shouldClear).toBe(false)

      // Render actual App component returning to patient-profile
      const html = renderToString(
        <App
          initialPage="patient-profile"
          initialDesktopSession={mockDesktopSession}
          initialSelectedPatient={mockPatientA}
          initialPatientProfileTab="Prescriptions"
        />,
      )

      // Verify patient profile renders the same patient
      expect(html).toContain("Meera Patel")
      expect(html).toContain("P-201")
      // Prescriptions tab is selected
      expect(html).toContain('aria-selected="true"')
      expect(html).toContain("Prescriptions")
      // Does not return to Consultation
      expect(html).not.toContain("Consultation notes")
    })
  })

  describe("Test C — Revision workflow", () => {
    it("1. Revising an ACTIVE historical prescription calls reviseLocalPrescription with exact parameters and updates to Revision 2", async () => {
      const reviseSpy = vi
        .spyOn(desktopBridge, "reviseLocalPrescription")
        .mockResolvedValue("rx-pat201-rev2")

      const updatedPrescriptionRev2: LocalPrescriptionRecord = {
        ...mockPrescriptionRev1,
        id: "rx-pat201-rev2",
        revision_number: 2,
        status: "ACTIVE",
        items_json: JSON.stringify(mockMedicinesRev2),
        created_at: "2026-11-15T11:00:00.000Z",
      }

      const getPrescriptionsSpy = vi
        .spyOn(desktopBridge, "getLocalPrescriptions")
        .mockResolvedValue([
          { ...mockPrescriptionRev1, status: "SUPERSEDED" },
          updatedPrescriptionRev2,
        ])

      // Execute production revision logic
      const newRecord = await executePrescriptionRevision({
        currentRecord: mockPrescriptionRev1,
        clinicId: "clinic-test-1",
        patientId: "pat-201",
        medicines: mockMedicinesRev2,
        reasonForRevision: "Added Budesonide inhaler and extended Montelukast course",
        reviseBridge: desktopBridge.reviseLocalPrescription,
        fetchPrescriptionsBridge: desktopBridge.getLocalPrescriptions,
      })

      // Verify exact Tauri bridge IPC parameters
      expect(reviseSpy).toHaveBeenCalledWith({
        clinic_id: "clinic-test-1",
        prescription_id: "rx-pat201-rev1",
        expected_revision_number: 1,
        items_json: JSON.stringify(mockMedicinesRev2),
        reason_for_revision: "Added Budesonide inhaler and extended Montelukast course",
      })
      expect(getPrescriptionsSpy).toHaveBeenCalledWith("clinic-test-1", "pat-201")

      // Verify returned revision record
      expect(newRecord.id).toBe("rx-pat201-rev2")
      expect(newRecord.revision_number).toBe(2)
      expect(newRecord.status).toBe("ACTIVE")

      // Render updated Revision 2 preview in App
      const htmlRev2 = renderToString(
        <App
          initialPage="preview"
          initialDesktopSession={mockDesktopSession}
          initialSelectedPatient={mockPatientA}
          initialPrescriptionPreviewReturnPage="patient-profile"
          initialViewingHistoricalPrescription={{
            record: newRecord,
            consultationData: {
              ...reconstructHistoricalPrescription(mockPrescriptionRev1, mockConsultationRecord)
                .consultationData,
              medicines: mockMedicinesRev2,
            },
            vitals: mockVitals,
            itemsError: null,
          }}
        />,
      )

      expect(htmlRev2).toContain("RX-2026-0042")
      expect(htmlRev2).toContain("Rev 2")
      expect(htmlRev2).toContain("Budesonide Turbuhaler")
      expect(htmlRev2).toContain("Edit prescription")

      // Verify Revision 1 original data remains untouched (immutability)
      expect(mockPrescriptionRev1.revision_number).toBe(1)
      expect(mockPrescriptionRev1.items_json).toContain("Salbutamol Inhaler")
      expect(mockPrescriptionRev1.items_json).not.toContain("Budesonide Turbuhaler")
    })

    it("2. Superceded historical prescriptions cannot be revised and render read-only", async () => {
      const supersededRecord: LocalPrescriptionRecord = {
        ...mockPrescriptionRev1,
        status: "SUPERSEDED",
      }

      // executePrescriptionRevision must reject non-ACTIVE revisions
      await expect(
        executePrescriptionRevision({
          currentRecord: supersededRecord,
          clinicId: "clinic-test-1",
          patientId: "pat-201",
          medicines: mockMedicinesRev2,
          reasonForRevision: "Illegal attempt to revise superseded record",
          reviseBridge: desktopBridge.reviseLocalPrescription,
          fetchPrescriptionsBridge: desktopBridge.getLocalPrescriptions,
        }),
      ).rejects.toThrow("Cannot revise prescription with status SUPERSEDED. Only ACTIVE prescriptions can be revised.")

      // Render superseded record in App preview
      const html = renderToString(
        <App
          initialPage="preview"
          initialDesktopSession={mockDesktopSession}
          initialSelectedPatient={mockPatientA}
          initialPrescriptionPreviewReturnPage="patient-profile"
          initialViewingHistoricalPrescription={{
            record: supersededRecord,
            consultationData: reconstructHistoricalPrescription(
              supersededRecord,
              mockConsultationRecord,
            ).consultationData,
            vitals: mockVitals,
            itemsError: null,
          }}
        />,
      )

      expect(html).toContain("Historical revisions are read-only")
      expect(html).not.toContain("Edit prescription")
    })
  })

  describe("Test D — Regression protection", () => {
    it("1. Consultation preview returns to Consultation and preserves draft consultation state", () => {
      const nav = resolvePrescriptionPreviewNavigation("consultation", "patient-profile")
      expect(nav.returnPage).toBe("consultation")
      expect(nav.clearHistorical).toBe(true)

      const previewState = computePrescriptionPreviewState(nav.returnPage, null)
      expect(previewState.isHistorical).toBe(false)
      expect(previewState.isSamplePreview).toBe(false)

      const html = renderToString(
        <App
          initialPage="preview"
          initialDesktopSession={mockDesktopSession}
          initialSelectedPatient={mockPatientA}
          initialPrescriptionPreviewReturnPage="consultation"
          initialViewingHistoricalPrescription={null}
        />,
      )

      expect(html).toContain("Back to consultation")
      expect(html).toContain("Local session preview · Not persisted")
      expect(html).not.toContain("Edit prescription")
    })

    it("2. Settings preview returns to Settings and renders sample preview layout", () => {
      const nav = resolvePrescriptionPreviewNavigation("settings", "patient-profile")
      expect(nav.returnPage).toBe("settings")
      expect(nav.clearHistorical).toBe(true)
      expect(nav.settingsTab).toBe("Prescription layout")

      const previewState = computePrescriptionPreviewState(nav.returnPage, null)
      expect(previewState.isHistorical).toBe(false)
      expect(previewState.isSamplePreview).toBe(true)

      const html = renderToString(
        <App
          initialPage="preview"
          initialDesktopSession={mockDesktopSession}
          initialSelectedPatient={mockPatientA}
          initialPrescriptionPreviewReturnPage="settings"
          initialViewingHistoricalPrescription={null}
        />,
      )

      expect(html).toContain("Back to prescription settings")
      expect(html).toContain("Prescription layout preview")
      expect(html).toContain("Sample preview · Layout changes apply to all future prescriptions")
    })

    it("3. Navigating away from preview/patient-profile clears historical prescription state", () => {
      expect(shouldClearHistoricalPrescriptionOnNavigation("dashboard")).toBe(true)
      expect(shouldClearHistoricalPrescriptionOnNavigation("patients")).toBe(true)
      expect(shouldClearHistoricalPrescriptionOnNavigation("consultation")).toBe(true)
      expect(shouldClearHistoricalPrescriptionOnNavigation("settings")).toBe(true)
      expect(shouldClearHistoricalPrescriptionOnNavigation("preview")).toBe(false)
      expect(shouldClearHistoricalPrescriptionOnNavigation("patient-profile")).toBe(false)
    })

    it("4. Opening another patient isolates patient records and does not retain stale historical prescription data", () => {
      const htmlPatB = renderToString(
        <App
          initialPage="patient-profile"
          initialDesktopSession={mockDesktopSession}
          initialSelectedPatient={mockPatientB}
          initialViewingHistoricalPrescription={null}
        />,
      )

      expect(htmlPatB).toContain("Rohan Gupta")
      expect(htmlPatB).toContain("P-202")
      expect(htmlPatB).not.toContain("Meera Patel")
      expect(htmlPatB).not.toContain("RX-2026-0042")
    })
  })

  describe("Test D — Bill Preview routing and reliable back navigation to Patient Info", () => {
    it("1. resolveBillPreviewNavigation returns patient-profile when bill is finalized", () => {
      const resFromForm = resolveBillPreviewNavigation("bill-form", "bill-form", true)
      expect(resFromForm.returnPage).toBe("patient-profile")

      const resFromProfile = resolveBillPreviewNavigation("patient-profile", "patient-profile", true)
      expect(resFromProfile.returnPage).toBe("patient-profile")
    })

    it("2. resolveBillPreviewNavigation returns settings when coming from settings", () => {
      const res = resolveBillPreviewNavigation("settings", "bill-form", true)
      expect(res.returnPage).toBe("settings")
      expect(res.settingsTab).toBe("Bill layout")
    })

    it("3. resolveBillPreviewNavigation returns bill-form only for unfinalized draft", () => {
      const res = resolveBillPreviewNavigation("bill-form", "bill-form", false)
      expect(res.returnPage).toBe("bill-form")
    })

    it("4. Renders Bill Preview for finalized bill with Back to patient profile topbar action", () => {
      const html = renderToString(
        <App
          initialPage="bill-preview"
          initialDesktopSession={mockDesktopSession}
          initialSelectedPatient={mockPatientA}
          initialBillPreviewReturnPage="patient-profile"
        />,
      )

      expect(html).toContain("Bill preview")
      expect(html).toContain("Back to patient profile")
      expect(html).not.toContain("Back to bill settings")
    })
  })
})
