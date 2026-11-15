import { describe, it, expect, vi } from "vitest"
import { renderToString } from "react-dom/server"
import React from "react"
import { PrescriptionPreview } from "./components/consultation/PrescriptionPreview"
import { PrescriptionEditModal } from "./components/consultation/PrescriptionEditModal"
import { PrescriptionsTab } from "./components/patients/tabs"
import { PatientProfile } from "./components/patients/PatientProfile"
import type { Patient, Vitals, ConsultationData, Medicine } from "./types"
import type { LocalPrescriptionRecord } from "./desktop/desktop-bridge"

describe("Prescription History Viewing and Revision Workflow", () => {
  const mockPatient: Patient = {
    id: "pat-101",
    displayId: "P-101",
    name: "Aarav Sharma",
    initials: "AS",
    age: 42,
    gender: "Male",
    phone: "9876543210",
    lastVisit: "2026-11-14",
    allergies: ["Penicillin"],
    conditions: ["Hypertension"],
  }

  const mockVitals: Vitals = {
    systolic: "130",
    diastolic: "85",
    heartRate: "76",
    spo2: "98",
    temperature: "98.6",
    height: "172",
    weight: "74",
  }

  const mockMedicinesRev1: Medicine[] = [
    {
      id: 1,
      name: "Amoxicillin",
      formulation: "Capsule",
      strength: "500 mg",
      dose: "1 capsule",
      route: "",
      frequency: "Three times daily",
      duration: "5 days",
      food: "After food",
      directions: "",
    },
    {
      id: 2,
      name: "Paracetamol",
      formulation: "Tablet",
      strength: "650 mg",
      dose: "1 tablet",
      route: "",
      frequency: "As needed",
      duration: "3 days",
      food: "After food",
      directions: "",
    },
  ]

  const mockConsultationData: ConsultationData = {
    date: "2026-11-14",
    time: "10:30 AM",
    chiefComplaint: "High fever and cough for 3 days",
    symptomDuration: "3 days",
    diagnosis: "Acute Bronchitis",
    medicines: mockMedicinesRev1,
    followUpDate: "2026-11-21",
    followUpInstructions: "Drink warm fluids and rest. Review if fever persists.",
  }

  const mockPrescriptionRev1: LocalPrescriptionRecord = {
    id: "rx-local-1",
    server_id: "rx-server-1",
    clinic_id: "clinic-test-1",
    consultation_id: "c-local-1",
    patient_id: "pat-101",
    doctor_id: "doc-1",
    prescription_number: "RX-2026-0001",
    revision_number: 1,
    status: "ACTIVE",
    items_json: JSON.stringify(mockMedicinesRev1),
    sync_status: "SYNCED",
    server_version: 1,
    local_version: 1,
    created_at: "2026-11-14T10:30:00.000Z",
  }

  const mockPrescriptionRev2: LocalPrescriptionRecord = {
    id: "rx-local-2",
    server_id: "rx-server-1",
    clinic_id: "clinic-test-1",
    consultation_id: "c-local-1",
    patient_id: "pat-101",
    doctor_id: "doc-1",
    prescription_number: "RX-2026-0001",
    revision_number: 2,
    status: "ACTIVE",
    items_json: JSON.stringify([
      {
        id: 1,
        name: "Amoxicillin",
        formulation: "Capsule",
        strength: "500 mg",
        dose: "1 capsule",
        route: "",
        frequency: "Three times daily",
        duration: "7 days",
        food: "After food",
        directions: "",
      },
      {
        id: 3,
        name: "Cetirizine",
        formulation: "Tablet",
        strength: "10 mg",
        dose: "1 tablet",
        route: "",
        frequency: "Once daily",
        duration: "5 days",
        food: "At bedtime",
        directions: "",
      },
    ]),
    sync_status: "PENDING",
    server_version: 1,
    local_version: 2,
    created_at: "2026-11-14T14:00:00.000Z",
  }

  it("1. PrescriptionsTab renders prescription details and revision badge", () => {
    const onViewPrescription = vi.fn()
    const go = vi.fn()

    const html = renderToString(
      <PrescriptionsTab
        go={go}
        patient={mockPatient}
        prescriptions={[mockPrescriptionRev1]}
        hasHistory={true}
        onViewPrescription={onViewPrescription}
      />,
    )

    expect(html).toContain("RX-2026-0001")
    expect(html).toContain("Original")
    expect(html).toContain("medicines")
    expect(html).toContain("Finalized")
  })

  it("2. PrescriptionPreview restores saved historical fields and displays prescription number & revision", () => {
    const go = vi.fn()

    const html = renderToString(
      <PrescriptionPreview
        go={go}
        patient={mockPatient}
        vitals={mockVitals}
        data={mockConsultationData}
        bannerVisible={true}
        bannerImage={null}
        signatureImage={null}
        showClinicLogo={true}
        showClinicEmail={true}
        showAllergyWarning={true}
        returnPage="patient-profile"
        prescriptionRecord={mockPrescriptionRev1}
      />,
    )

    // Patient info
    expect(html).toContain("Aarav Sharma")
    // Prescription number & Revision badge
    expect(html).toContain("RX-2026-0001")
    expect(html).toContain("Original")
    // Vitals
    expect(html).toContain("130/85 mmHg")
    expect(html).toContain("76 bpm")
    // Diagnosis & Chief complaint
    expect(html).toContain("Acute Bronchitis")
    expect(html).toContain("High fever and cough for 3 days")
    // Follow-up & Advice
    expect(html).toContain("Drink warm fluids and rest. Review if fever persists.")
    // Medicines
    expect(html).toContain("Amoxicillin")
    expect(html).toContain("Paracetamol")
    // Edit prescription button present for ACTIVE record
    expect(html).toContain("Edit prescription")
  })

  it("3. Displays 'Edit prescription' action for ACTIVE prescription and renders edit UI", () => {
    const go = vi.fn()
    const onRevise = vi.fn().mockResolvedValue(undefined)

    const previewHtml = renderToString(
      <PrescriptionPreview
        go={go}
        patient={mockPatient}
        vitals={mockVitals}
        data={mockConsultationData}
        bannerVisible={true}
        bannerImage={null}
        signatureImage={null}
        showClinicLogo={true}
        showClinicEmail={true}
        showAllergyWarning={true}
        returnPage="patient-profile"
        prescriptionRecord={mockPrescriptionRev1}
        onRevisePrescription={onRevise}
      />,
    )

    expect(previewHtml).toContain("Edit prescription")

    // Test modal rendering
    const modalHtml = renderToString(
      <PrescriptionEditModal
        isOpen={true}
        onClose={vi.fn()}
        prescriptionNumber="RX-2026-0001"
        currentRevisionNumber={1}
        initialMedicines={mockMedicinesRev1}
        onSaveRevision={onRevise}
      />,
    )

    expect(modalHtml).toContain("Edit Prescription")
    expect(modalHtml).toContain("RX-2026-0001")
    expect(modalHtml).toContain("Amoxicillin")
    expect(modalHtml).toContain("Paracetamol")
    expect(modalHtml).toContain("Reason for revision")
  })

  it("4. Superceded prescription records are read-only and hide the edit action", () => {
    const go = vi.fn()
    const onRevise = vi.fn()

    const supersededRx: LocalPrescriptionRecord = {
      ...mockPrescriptionRev1,
      status: "SUPERSEDED",
    }

    const html = renderToString(
      <PrescriptionPreview
        go={go}
        patient={mockPatient}
        vitals={mockVitals}
        data={mockConsultationData}
        bannerVisible={true}
        bannerImage={null}
        signatureImage={null}
        showClinicLogo={true}
        showClinicEmail={true}
        showAllergyWarning={true}
        returnPage="patient-profile"
        prescriptionRecord={supersededRx}
        onRevisePrescription={onRevise}
      />,
    )

    // "Edit prescription" button must NOT be rendered for non-ACTIVE prescriptions
    expect(html).not.toContain("Edit prescription")
    expect(html).toContain("Historical revisions are read-only")
  })

  it("5. Renders Revision 2 in preview with updated medicines while Revision 1 data remains intact", () => {
    const go = vi.fn()

    // Revision 1 preview
    const rev1Html = renderToString(
      <PrescriptionPreview
        go={go}
        patient={mockPatient}
        vitals={mockVitals}
        data={mockConsultationData}
        bannerVisible={true}
        bannerImage={null}
        signatureImage={null}
        showClinicLogo={true}
        showClinicEmail={true}
        showAllergyWarning={true}
        returnPage="patient-profile"
        prescriptionRecord={mockPrescriptionRev1}
      />,
    )

    expect(rev1Html).toContain("RX-2026-0001")
    expect(rev1Html).toContain("Original")
    expect(rev1Html).toContain("Paracetamol")

    // Revision 2 preview
    const rev2Data: ConsultationData = {
      ...mockConsultationData,
      medicines: JSON.parse(mockPrescriptionRev2.items_json!),
    }

    const rev2Html = renderToString(
      <PrescriptionPreview
        go={go}
        patient={mockPatient}
        vitals={mockVitals}
        data={rev2Data}
        bannerVisible={true}
        bannerImage={null}
        signatureImage={null}
        showClinicLogo={true}
        showClinicEmail={true}
        showAllergyWarning={true}
        returnPage="patient-profile"
        prescriptionRecord={mockPrescriptionRev2}
      />,
    )

    expect(rev2Html).toContain("RX-2026-0001")
    expect(rev2Html).toContain("Rev 2")
    expect(rev2Html).toContain("Cetirizine")
    expect(rev2Html).not.toContain("Paracetamol")
    // Re-verify Rev 1 still has Paracetamol (immutability check)
    expect(mockConsultationData.medicines[1].name).toBe("Paracetamol")
  })

  it("6. Displays explicit error state identifying prescription ID when items_json is corrupt or missing", () => {
    const go = vi.fn()
    const malformedError =
      "Prescription record RX-2026-0001 contains malformed or unreadable medicine data."

    const html = renderToString(
      <PrescriptionPreview
        go={go}
        patient={mockPatient}
        vitals={mockVitals}
        data={{
          ...mockConsultationData,
          medicines: [],
        }}
        bannerVisible={true}
        bannerImage={null}
        signatureImage={null}
        showClinicLogo={true}
        showClinicEmail={true}
        showAllergyWarning={true}
        returnPage="patient-profile"
        prescriptionRecord={mockPrescriptionRev1}
        itemsError={malformedError}
      />,
    )

    // Must show clear error banner and table error identifying the prescription
    expect(html).toContain("Prescription Data Warning")
    expect(html).toContain("Unable to load medicines")
    expect(html).toContain(malformedError)
    // Must NOT mislead the doctor with "blank until entered" message
    expect(html).not.toContain("Medicine fields remain blank until entered")
  })

  it("7. Back navigation configures 'Back to patient profile' and preserves Prescriptions tab in PatientProfile", () => {
    const go = vi.fn()

    const previewHtml = renderToString(
      <PrescriptionPreview
        go={go}
        patient={mockPatient}
        vitals={mockVitals}
        data={mockConsultationData}
        bannerVisible={true}
        bannerImage={null}
        signatureImage={null}
        showClinicLogo={true}
        showClinicEmail={true}
        showAllergyWarning={true}
        returnPage="patient-profile"
        prescriptionRecord={mockPrescriptionRev1}
      />,
    )

    // Verify back button label targets patient profile
    expect(previewHtml).toContain("Back to patient profile")

    // Render PatientProfile with activeTab="Prescriptions" (simulating return to profile)
    const profileHtml = renderToString(
      <PatientProfile
        go={go}
        patient={mockPatient}
        saveFeedback={null}
        activeTab="Prescriptions"
      />,
    )

    // Prescriptions tab should be selected
    expect(profileHtml).toContain('aria-selected="true"')
    expect(profileHtml).toContain("Prescriptions")
  })

  it("8. Opening two different historical prescriptions renders each record independently without cross-talk", () => {
    const go = vi.fn()

    const mockMedicinesRxB: Medicine[] = [
      {
        id: 99,
        name: "Metformin",
        formulation: "Tablet",
        strength: "500 mg",
        dose: "1 tablet",
        route: "Oral",
        frequency: "Twice daily",
        duration: "30 days",
        food: "With meals",
        directions: "",
      },
    ]

    const mockConsultationDataB: ConsultationData = {
      date: "2026-11-10",
      time: "11:15 AM",
      chiefComplaint: "Routine diabetes checkup",
      symptomDuration: "",
      diagnosis: "Type 2 Diabetes Mellitus",
      medicines: mockMedicinesRxB,
      followUpDate: "2026-12-10",
      followUpInstructions: "Monitor fasting blood glucose daily.",
    }

    const mockPrescriptionB: LocalPrescriptionRecord = {
      id: "rx-local-b",
      server_id: "rx-server-b",
      clinic_id: "clinic-test-1",
      consultation_id: "c-local-b",
      patient_id: "pat-101",
      doctor_id: "doc-1",
      prescription_number: "RX-2026-0002",
      revision_number: 1,
      status: "ACTIVE",
      items_json: JSON.stringify(mockMedicinesRxB),
      sync_status: "SYNCED",
      server_version: 1,
      local_version: 1,
      created_at: "2026-11-10T11:15:00.000Z",
    }

    // Render Rx A (Bronchitis / Amoxicillin)
    const htmlA = renderToString(
      <PrescriptionPreview
        go={go}
        patient={mockPatient}
        vitals={mockVitals}
        data={mockConsultationData}
        bannerVisible={true}
        bannerImage={null}
        signatureImage={null}
        showClinicLogo={true}
        showClinicEmail={true}
        showAllergyWarning={true}
        returnPage="patient-profile"
        prescriptionRecord={mockPrescriptionRev1}
      />,
    )

    // Render Rx B (Diabetes / Metformin)
    const htmlB = renderToString(
      <PrescriptionPreview
        go={go}
        patient={mockPatient}
        vitals={mockVitals}
        data={mockConsultationDataB}
        bannerVisible={true}
        bannerImage={null}
        signatureImage={null}
        showClinicLogo={true}
        showClinicEmail={true}
        showAllergyWarning={true}
        returnPage="patient-profile"
        prescriptionRecord={mockPrescriptionB}
      />,
    )

    // Verify Rx A contains its own data and none of Rx B's data
    expect(htmlA).toContain("RX-2026-0001")
    expect(htmlA).toContain("Acute Bronchitis")
    expect(htmlA).toContain("Amoxicillin")
    expect(htmlA).not.toContain("RX-2026-0002")
    expect(htmlA).not.toContain("Type 2 Diabetes Mellitus")
    expect(htmlA).not.toContain("Metformin")

    // Verify Rx B contains its own data and none of Rx A's data
    expect(htmlB).toContain("RX-2026-0002")
    expect(htmlB).toContain("Type 2 Diabetes Mellitus")
    expect(htmlB).toContain("Metformin")
    expect(htmlB).not.toContain("RX-2026-0001")
    expect(htmlB).not.toContain("Acute Bronchitis")
    expect(htmlB).not.toContain("Amoxicillin")
  })
})
