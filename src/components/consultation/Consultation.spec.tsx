import { describe, it, expect } from "vitest"
import { renderToString } from "react-dom/server"
import { CompactField } from "./CompactField"
import { Consultation } from "./Consultation"
import { PrescriptionPreview } from "./PrescriptionPreview"
import type {
  Patient,
  Vitals,
  ConsultationData,
  ClinicalLibrary,
} from "../../types"
import { loadClinicalLibrary } from "../../types"

describe("Consultation Components & UX", () => {
  const samplePatient: Patient = {
    id: "PC-1001",
    name: "Aarav Sharma",
    initials: "AS",
    age: 45,
    gender: "Male",
    phone: "+91 98765 00001",
    lastVisit: "Today",
    allergies: ["Amoxicillin"],
    conditions: [],
  }

  const sampleVitals: Vitals = {
    systolic: "125",
    diastolic: "82",
    heartRate: "72",
    spo2: "98",
    temperature: "98.4",
    height: "172",
    weight: "68",
  }

  const sampleData: ConsultationData = {
    date: "2026-10-28",
    time: "10:30",
    chiefComplaint: "Acute throat pain and fever",
    symptomDuration: "3 days",
    diagnosis: "Acute Pharyngitis",
    medicines: [
      {
        id: 1,
        name: "Paracetamol",
        formulation: "Tablet",
        strength: "650 mg",
        dose: "1",
        route: "Oral",
        frequency: "Three times daily",
        duration: "5 days",
        food: "After food",
        directions: "Take with water",
        activeIngredient: "Paracetamol",
      },
    ],
    followUpDate: "2026-11-02",
    followUpInstructions: "Review if fever persists",
  }

  const library: ClinicalLibrary = loadClinicalLibrary()

  describe("CompactField", () => {
    it("renders label, placeholder, suffix and values", () => {
      const rawHtml = renderToString(
        <CompactField
          label="Blood pressure"
          suffix="mmHg"
          placeholder="120"
          secondaryPlaceholder="80"
          value="120"
          secondaryValue="80"
          onChange={() => {}}
          onSecondaryChange={() => {}}
          wide
        />,
      )
      const html = rawHtml.replace(/<!-- -->/g, "")

      expect(html).toContain("compact-field")
      expect(html).toContain("wide")
      expect(html).toContain("Blood pressure")
      expect(html).toContain("mmHg")
      expect(html).toContain('value="120"')
      expect(html).toContain('value="80"')
    })
  })

  describe("Consultation Form", () => {
    it("renders patient strip, vitals section, clinical notes and medicine rows", () => {
      const rawHtml = renderToString(
        <Consultation
          go={() => {}}
          patient={samplePatient}
          clinicalLibrary={library}
          vitals={sampleVitals}
          onVitalsChange={() => {}}
          data={sampleData}
          onDataChange={() => {}}
        />,
      )
      const html = rawHtml.replace(/<!-- -->/g, "")

      expect(html).toContain("New consultation")
      expect(html).toContain("Aarav Sharma")
      expect(html).toContain("Allergy: Amoxicillin")
      expect(html).toContain("Acute throat pain and fever")
      expect(html).toContain("Acute Pharyngitis")
      expect(html).toContain("Paracetamol")
      expect(html).toContain("Finalize prescription")
    })

    it("confirms 'Additional directions' section is removed for oral formulations", () => {
      const rawHtml = renderToString(
        <Consultation
          go={() => {}}
          patient={samplePatient}
          clinicalLibrary={library}
          vitals={sampleVitals}
          onVitalsChange={() => {}}
          data={sampleData} // medicine is Tablet
          onDataChange={() => {}}
        />,
      )
      const html = rawHtml.replace(/<!-- -->/g, "")

      expect(html).not.toContain("Additional directions")
      expect(html).not.toContain("Application instructions")
    })

    it("renders 'Application instructions' only for topical formulations and not 'Additional directions'", () => {
      const topicalData: ConsultationData = {
        ...sampleData,
        medicines: [
          {
            id: 1,
            name: "Mupirocin",
            formulation: "Ointment",
            strength: "2%",
            dose: "",
            route: "Topical",
            frequency: "Twice daily",
            duration: "7 days",
            food: "",
            directions: "Apply thin layer to affected area",
            activeIngredient: "Mupirocin",
          },
        ],
      }
      const rawHtml = renderToString(
        <Consultation
          go={() => {}}
          patient={samplePatient}
          clinicalLibrary={library}
          vitals={sampleVitals}
          onVitalsChange={() => {}}
          data={topicalData}
          onDataChange={() => {}}
        />,
      )
      const html = rawHtml.replace(/<!-- -->/g, "")

      expect(html).not.toContain("Additional directions")
      expect(html).toContain("Application instructions (Required)")
    })
  })

  describe("PrescriptionPreview", () => {
    it("renders printable prescription paper with authenticated doctor and clinic identity", () => {
      const rawHtml = renderToString(
        <PrescriptionPreview
          go={() => {}}
          patient={samplePatient}
          vitals={sampleVitals}
          data={sampleData}
          bannerVisible={true}
          bannerImage={null}
          signatureImage={null}
          showClinicLogo={true}
          showClinicEmail={true}
          showAllergyWarning={true}
          returnPage="consultation"
          desktopSession={{
            doctor_id: "doc-sarah-1",
            clinic_id: "clinic-apollo-99",
            doctor_name: "Dr. Sarah Jenkins",
            doctor_email: "sarah@apollocare.in",
            role: "OWNER",
            expires_at: 9999999999,
          }}
        />,
      )
      const html = rawHtml.replace(/<!-- -->/g, "")

      expect(html).toContain("Prescription preview")
      expect(html).toContain("printable-prescription")
      expect(html).toContain("Dr. Sarah Jenkins")
      expect(html).toContain("Clinic clinic-apollo-99")
      expect(html).not.toContain("Dr. Nikhil Kanade")
      expect(html).not.toContain("Nishti Hospital")
      expect(html).toContain("Paracetamol")
      expect(html).toContain("125/82 mmHg")
      expect(html).toContain("Allergy alert")
      expect(html).toContain("Amoxicillin")
      expect(html).toContain("Print prescription")
      expect(html).toContain("Send on WhatsApp")
    })

    it("displays clean incomplete-profile state without session and never leaks another doctor's profile", () => {
      const rawHtml = renderToString(
        <PrescriptionPreview
          go={() => {}}
          patient={samplePatient}
          vitals={sampleVitals}
          data={sampleData}
          bannerVisible={true}
          bannerImage={null}
          signatureImage={null}
          showClinicLogo={true}
          showClinicEmail={true}
          showAllergyWarning={true}
          returnPage="consultation"
          desktopSession={null}
        />,
      )
      const html = rawHtml.replace(/<!-- -->/g, "")

      expect(html).toContain("Medical Clinic")
      expect(html).toContain("Local Clinic Workspace")
      expect(html).not.toContain("Dr. Nikhil Kanade")
      expect(html).not.toContain("Nishti Hospital")
    })
  })
})
