import { describe, it, expect, vi, beforeEach } from "vitest"
import React from "react"
import { renderToString } from "react-dom/server"
import { PrescriptionPreview } from "./components/consultation/PrescriptionPreview"
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

describe("Prescription Preview Routing and Navigation Integration", () => {
  beforeEach(() => {
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

  const mockConsultation: LocalConsultationRecord = {
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
      followUpInstructions:
        "Review inhaler technique and peak flow in 4 weeks.",
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

  /**
   * Harness implementing App.tsx's exact routing and historical prescription state logic.
   */
  function createAppRoutingHarness() {
    let page: string = "patient-profile"
    let prescriptionPreviewReturnPage: "consultation" | "settings" | "patient-profile" =
      "consultation"
    let viewingHistoricalPrescription: {
      record: LocalPrescriptionRecord
      consultationData: ConsultationData
      vitals: Vitals
      itemsError?: string | null
    } | null = null
    let patientProfileTab = "Overview"
    let consultationDraft: ConsultationData = createEmptyConsultationData()
    let vitalsDraft: Vitals = {
      systolic: "",
      diastolic: "",
      heartRate: "",
      spo2: "",
      temperature: "",
      height: "",
      weight: "",
    }

    const go = (next: string) => {
      if (next === "preview") {
        if (page === "settings") {
          prescriptionPreviewReturnPage = "settings"
          viewingHistoricalPrescription = null
        } else if (page === "patient-profile") {
          prescriptionPreviewReturnPage = "patient-profile"
        } else if (page === "consultation") {
          prescriptionPreviewReturnPage = "consultation"
          viewingHistoricalPrescription = null
        } else {
          prescriptionPreviewReturnPage =
            prescriptionPreviewReturnPage === "patient-profile" ||
            prescriptionPreviewReturnPage === "settings"
              ? prescriptionPreviewReturnPage
              : "consultation"
        }
      }
      if (next !== "preview" && next !== "patient-profile") {
        viewingHistoricalPrescription = null
      }
      page = next
    }

    const viewHistoricalPrescription = async (
      rx: LocalPrescriptionRecord,
      matchedConsult?: LocalConsultationRecord,
    ) => {
      let parsedMedicines: Medicine[] = []
      let itemsError: string | null = null
      try {
        if (rx.items_json && rx.items_json.trim().length > 0) {
          const parsed = JSON.parse(rx.items_json)
          if (Array.isArray(parsed)) {
            parsedMedicines = parsed
          } else {
            itemsError = `Prescription record ${rx.prescription_number || rx.id} contains invalid medicine structure (expected a list).`
          }
        } else {
          itemsError = `Prescription record ${rx.prescription_number || rx.id} has no medicine data recorded.`
        }
      } catch {
        itemsError = `Failed to parse medicines for prescription ${rx.prescription_number || rx.id}: invalid JSON.`
      }

      let parsedVitals: Vitals = {
        systolic: "",
        diastolic: "",
        heartRate: "",
        spo2: "",
        temperature: "",
        height: "",
        weight: "",
      }
      let followUpDate = ""
      let followUpInstructions = ""
      let symptomDuration = ""

      if (matchedConsult?.clinical_snapshot_json) {
        try {
          const snapshot = JSON.parse(matchedConsult.clinical_snapshot_json)
          if (snapshot.vitals) {
            parsedVitals = { ...parsedVitals, ...snapshot.vitals }
          }
          if (snapshot.followUpDate) followUpDate = snapshot.followUpDate
          if (snapshot.followUpInstructions) {
            followUpInstructions = snapshot.followUpInstructions
          }
          if (snapshot.symptomDuration) {
            symptomDuration = snapshot.symptomDuration
          }
        } catch {}
      }

      const reconstructedConsultation: ConsultationData = {
        date: rx.created_at
          ? rx.created_at.slice(0, 10)
          : matchedConsult?.consultation_date ||
            new Date().toISOString().slice(0, 10),
        time: rx.created_at
          ? new Date(rx.created_at).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              hour12: true,
            })
          : "",
        chiefComplaint: matchedConsult?.chief_complaint || "",
        symptomDuration,
        diagnosis: matchedConsult?.diagnosis || "",
        medicines: parsedMedicines,
        followUpDate,
        followUpInstructions,
      }

      viewingHistoricalPrescription = {
        record: rx,
        consultationData: reconstructedConsultation,
        vitals: parsedVitals,
        itemsError,
      }
      patientProfileTab = "Prescriptions"
      prescriptionPreviewReturnPage = "patient-profile"
      go("preview")
    }

    const handleRevisePrescription = async (
      medicines: Medicine[],
      reasonForRevision: string,
    ) => {
      if (!viewingHistoricalPrescription?.record) {
        throw new Error("No active historical prescription selected.")
      }
      const currentRecord = viewingHistoricalPrescription.record

      const newPrescriptionId = await desktopBridge.reviseLocalPrescription({
        clinic_id: mockDesktopSession.clinic_id,
        prescription_id: currentRecord.id,
        expected_revision_number: currentRecord.revision_number,
        items_json: JSON.stringify(medicines),
        reason_for_revision: reasonForRevision,
      })

      if (!newPrescriptionId) {
        throw new Error(
          "Failed to revise prescription: no revision ID returned.",
        )
      }

      const updatedList = await desktopBridge.getLocalPrescriptions(
        mockDesktopSession.clinic_id,
        mockPatient.id,
      )

      const newRecord = updatedList.find((r) => r.id === newPrescriptionId) || {
        ...currentRecord,
        id: newPrescriptionId,
        revision_number: currentRecord.revision_number + 1,
        status: "ACTIVE" as const,
        items_json: JSON.stringify(medicines),
      }

      viewingHistoricalPrescription = {
        record: newRecord,
        consultationData: {
          ...viewingHistoricalPrescription.consultationData,
          medicines,
        },
        vitals: viewingHistoricalPrescription.vitals,
        itemsError: null,
      }
    }

    const startConsultation = () => {
      viewingHistoricalPrescription = null
      consultationDraft = createEmptyConsultationData()
      go("consultation")
    }

    return {
      getState: () => ({
        page,
        prescriptionPreviewReturnPage,
        viewingHistoricalPrescription,
        patientProfileTab,
        consultationDraft,
        vitalsDraft,
        isHistorical:
          Boolean(viewingHistoricalPrescription) &&
          prescriptionPreviewReturnPage === "patient-profile",
      }),
      go,
      viewHistoricalPrescription,
      handleRevisePrescription,
      startConsultation,
      setPage: (p: string) => {
        page = p
      },
      setDraftMedicine: (name: string) => {
        consultationDraft = {
          ...consultationDraft,
          medicines: [
            {
              id: 999,
              name,
              formulation: "Tablet",
              strength: "500 mg",
              dose: "1",
              route: "Oral",
              frequency: "Once",
              duration: "1 day",
              food: "After food",
              directions: "",
            },
          ],
        }
      },
    }
  }

  it("1. Patient Profile -> Preview preserves returnPage='patient-profile' and sets isHistorical=true with restored data", async () => {
    const harness = createAppRoutingHarness()
    harness.setPage("patient-profile")

    await harness.viewHistoricalPrescription(
      mockPrescriptionRev1,
      mockConsultation,
    )

    const state = harness.getState()
    expect(state.page).toBe("preview")
    expect(state.prescriptionPreviewReturnPage).toBe("patient-profile")
    expect(state.isHistorical).toBe(true)
    expect(state.patientProfileTab).toBe("Prescriptions")

    // Verify historical data restored accurately
    expect(
      state.viewingHistoricalPrescription?.record.prescription_number,
    ).toBe("RX-2026-0042")
    expect(state.viewingHistoricalPrescription?.record.revision_number).toBe(1)
    expect(
      state.viewingHistoricalPrescription?.consultationData.diagnosis,
    ).toBe("Moderate Persistent Asthma")
    expect(
      state.viewingHistoricalPrescription?.consultationData.chiefComplaint,
    ).toBe("Seasonal asthma exacerbation")
    expect(
      state.viewingHistoricalPrescription?.consultationData.medicines,
    ).toHaveLength(2)
    expect(
      state.viewingHistoricalPrescription?.consultationData.medicines[0].name,
    ).toBe("Salbutamol Inhaler")
    expect(state.viewingHistoricalPrescription?.vitals.systolic).toBe("118")

    // Render PrescriptionPreview with the harness props and verify rendered output
    const html = renderToString(
      <PrescriptionPreview
        go={harness.go as any}
        patient={mockPatient}
        vitals={state.viewingHistoricalPrescription!.vitals}
        data={state.viewingHistoricalPrescription!.consultationData}
        bannerVisible={true}
        bannerImage={null}
        signatureImage={null}
        showClinicLogo={true}
        showClinicEmail={true}
        showAllergyWarning={true}
        returnPage={state.prescriptionPreviewReturnPage}
        prescriptionRecord={state.viewingHistoricalPrescription!.record}
        onRevisePrescription={harness.handleRevisePrescription}
      />,
    )

    expect(html).toContain("RX-2026-0042")
    expect(html).toContain("Original")
    expect(html).toContain("Moderate Persistent Asthma")
    expect(html).toContain("Salbutamol Inhaler")
    expect(html).toContain("Montelukast")
    expect(html).toContain("Back to patient profile")
    expect(html).toContain("Edit prescription")
  })

  it("2. Back button from historical preview returns directly to Patient Profile with Prescriptions tab selected", async () => {
    const harness = createAppRoutingHarness()
    harness.setPage("patient-profile")

    await harness.viewHistoricalPrescription(
      mockPrescriptionRev1,
      mockConsultation,
    )
    expect(harness.getState().page).toBe("preview")

    // Simulate clicking the back button in PrescriptionPreview
    const returnPage = harness.getState().prescriptionPreviewReturnPage
    expect(returnPage).toBe("patient-profile")
    harness.go(returnPage)

    const state = harness.getState()
    expect(state.page).toBe("patient-profile")
    expect(state.patientProfileTab).toBe("Prescriptions")

    // Verify PatientProfile renders with Prescriptions tab active
    const profileHtml = renderToString(
      <PatientProfile
        go={harness.go as any}
        patient={mockPatient}
        saveFeedback={null}
        activeTab={state.patientProfileTab}
      />,
    )

    expect(profileHtml).toContain('aria-selected="true"')
    expect(profileHtml).toContain("Prescriptions")
  })

  it("3. Revision workflow invokes reviseLocalPrescription and updates preview to Revision 2 without affecting consultation draft", async () => {
    const harness = createAppRoutingHarness()
    harness.setPage("patient-profile")
    harness.setDraftMedicine("Draft Ibuprofen")

    await harness.viewHistoricalPrescription(
      mockPrescriptionRev1,
      mockConsultation,
    )

    // Spy on desktop bridge functions
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

    // Execute revision
    await harness.handleRevisePrescription(
      mockMedicinesRev2,
      "Added Budesonide inhaler and extended Montelukast duration",
    )

    expect(reviseSpy).toHaveBeenCalledWith({
      clinic_id: "clinic-test-1",
      prescription_id: "rx-pat201-rev1",
      expected_revision_number: 1,
      items_json: JSON.stringify(mockMedicinesRev2),
      reason_for_revision:
        "Added Budesonide inhaler and extended Montelukast duration",
    })
    expect(getPrescriptionsSpy).toHaveBeenCalledWith("clinic-test-1", "pat-201")

    const state = harness.getState()
    expect(state.viewingHistoricalPrescription?.record.id).toBe(
      "rx-pat201-rev2",
    )
    expect(state.viewingHistoricalPrescription?.record.revision_number).toBe(2)
    expect(
      state.viewingHistoricalPrescription?.consultationData.medicines,
    ).toHaveLength(3)
    expect(
      state.viewingHistoricalPrescription?.consultationData.medicines[2].name,
    ).toBe("Budesonide Turbuhaler")

    // Confirm that draft consultation remains completely untouched (draft isolation)
    expect(state.consultationDraft.medicines[0].name).toBe("Draft Ibuprofen")

    // Render updated Revision 2 preview
    const previewRev2Html = renderToString(
      <PrescriptionPreview
        go={harness.go as any}
        patient={mockPatient}
        vitals={state.viewingHistoricalPrescription!.vitals}
        data={state.viewingHistoricalPrescription!.consultationData}
        bannerVisible={true}
        bannerImage={null}
        signatureImage={null}
        showClinicLogo={true}
        showClinicEmail={true}
        showAllergyWarning={true}
        returnPage={state.prescriptionPreviewReturnPage}
        prescriptionRecord={state.viewingHistoricalPrescription!.record}
        onRevisePrescription={harness.handleRevisePrescription}
      />,
    )

    expect(previewRev2Html).toContain("RX-2026-0042")
    expect(previewRev2Html).toContain("Rev 2")
    expect(previewRev2Html).toContain("Budesonide Turbuhaler")
    expect(previewRev2Html).toContain("Edit prescription")
  })

  it("4. Superceded historical prescription is read-only and hides Edit prescription action", () => {
    const harness = createAppRoutingHarness()
    const supersededRecord: LocalPrescriptionRecord = {
      ...mockPrescriptionRev1,
      status: "SUPERSEDED",
    }

    const html = renderToString(
      <PrescriptionPreview
        go={harness.go as any}
        patient={mockPatient}
        vitals={mockVitals}
        data={{
          date: "2026-11-15",
          time: "09:15 AM",
          chiefComplaint: "Asthma",
          symptomDuration: "",
          diagnosis: "Asthma",
          medicines: mockMedicinesRev1,
          followUpDate: "",
          followUpInstructions: "",
        }}
        bannerVisible={true}
        bannerImage={null}
        signatureImage={null}
        showClinicLogo={true}
        showClinicEmail={true}
        showAllergyWarning={true}
        returnPage="patient-profile"
        prescriptionRecord={supersededRecord}
        onRevisePrescription={harness.handleRevisePrescription}
      />,
    )

    expect(html).toContain("RX-2026-0042")
    expect(html).toContain("Historical revisions are read-only")
    expect(html).not.toContain("Edit prescription")
  })

  it("5. Navigating to preview from Consultation preserves returnPage='consultation' and isolates draft consultation state", () => {
    const harness = createAppRoutingHarness()
    harness.setPage("consultation")
    harness.setDraftMedicine("Azithromycin")

    harness.go("preview")

    const state = harness.getState()
    expect(state.page).toBe("preview")
    expect(state.prescriptionPreviewReturnPage).toBe("consultation")
    expect(state.isHistorical).toBe(false)
    expect(state.viewingHistoricalPrescription).toBeNull()

    // Render preview with consultation draft
    const html = renderToString(
      <PrescriptionPreview
        go={harness.go as any}
        patient={mockPatient}
        vitals={state.vitalsDraft}
        data={state.consultationDraft}
        bannerVisible={true}
        bannerImage={null}
        signatureImage={null}
        showClinicLogo={true}
        showClinicEmail={true}
        showAllergyWarning={true}
        returnPage={state.prescriptionPreviewReturnPage}
        prescriptionRecord={null}
      />,
    )

    expect(html).toContain("Back to consultation")
    expect(html).toContain("Local session preview · Not persisted")
    expect(html).toContain("Azithromycin")
    expect(html).not.toContain("Edit prescription")

    // Clicking back returns to consultation
    harness.go(state.prescriptionPreviewReturnPage)
    expect(harness.getState().page).toBe("consultation")
  })

  it("6. Navigating to preview from Settings preserves returnPage='settings' and displays sample layout preview", () => {
    const harness = createAppRoutingHarness()
    harness.setPage("settings")

    harness.go("preview")

    const state = harness.getState()
    expect(state.page).toBe("preview")
    expect(state.prescriptionPreviewReturnPage).toBe("settings")
    expect(state.isHistorical).toBe(false)
    expect(state.viewingHistoricalPrescription).toBeNull()

    // Sample preview render
    const html = renderToString(
      <PrescriptionPreview
        go={harness.go as any}
        patient={{
          id: "SAMPLE-PREVIEW-PT",
          name: "Sample Patient",
          initials: "SP",
          age: 42,
          gender: "Male",
          phone: "+91 98765 43210",
          lastVisit: "Today",
          allergies: ["Penicillin"],
          conditions: ["Hypertension"],
        }}
        vitals={{
          systolic: "120",
          diastolic: "80",
          heartRate: "72",
          spo2: "98",
          temperature: "98.6",
          height: "175",
          weight: "70",
        }}
        data={{
          date: "2026-11-09",
          time: "10:30 AM",
          chiefComplaint: "General health checkup and routine consultation",
          symptomDuration: "",
          diagnosis: "Essential Hypertension (Well Controlled)",
          medicines: [
            {
              id: 1,
              name: "Telmisartan",
              formulation: "Tablet",
              strength: "40 mg",
              dose: "1 tablet",
              route: "Oral",
              frequency: "Once daily (Morning)",
              duration: "30 days",
              food: "After food",
              directions: "Take in the morning with water",
            },
          ],
          followUpDate: "2026-12-09",
          followUpInstructions: "Monitor BP weekly at home.",
        }}
        bannerVisible={true}
        bannerImage={null}
        signatureImage={null}
        showClinicLogo={true}
        showClinicEmail={true}
        showAllergyWarning={true}
        returnPage={state.prescriptionPreviewReturnPage}
        prescriptionRecord={null}
      />,
    )

    expect(html).toContain("Back to prescription settings")
    expect(html).toContain("Sample Patient")
    expect(html).toContain("Telmisartan")
    expect(html).not.toContain("Edit prescription")

    // Back returns to settings
    harness.go(state.prescriptionPreviewReturnPage)
    expect(harness.getState().page).toBe("settings")
  })
})
