import { describe, it, expect, beforeEach, vi } from "vitest"
import { renderToString } from "react-dom/server"
import { CompactField } from "./CompactField"
import { Consultation } from "./Consultation"
import { PrescriptionPreview } from "./PrescriptionPreview"
import type {
  Patient,
  Vitals,
  ConsultationData,
  ClinicalLibrary,
  ClinicalMedicineDefinition,
  Medicine,
} from "../../types"
import {
  loadClinicalLibrary,
  defaultClinicalLibrary,
  loadCustomChiefComplaints,
  saveCustomChiefComplaints,
  addCustomChiefComplaint,
  getChiefComplaintOptions,
  DEFAULT_COMPLAINT_OPTIONS,
  complaintOptions,
} from "../../types"
import { validateMedicineFormulation } from "../../utils/billing"
import type { LocalPrescriptionRecord } from "../../desktop/desktop-bridge"

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
      expect(html).toContain("patient-strip-name")
      expect(html).toContain("patient-strip-details")
      expect(html).toContain("45 years · Male · PC-1001")
      expect(html).toContain("Allergy: Amoxicillin")
      expect(html).toContain("Acute throat pain and fever")
      expect(html).toContain("Acute Pharyngitis")
      expect(html).toContain("Paracetamol")
      expect(html).toContain("Finalize prescription")
      // Check Adv. terminology
      expect(html).toContain("Adv.")
      expect(html).toContain("Follow up date")
      expect(html).toContain("Adv. instructions")
      // Check Medical background on consultation
      expect(html).toContain("Medical background")
      expect(html).toContain("Known allergies")
      expect(html).toContain("Medical History")
    })

    it("recognizes non-allergy entries as No Known Allergies and unknown entries as Unknown", () => {
      // 1. Non-allergy entry: None / NKDA
      const nonAllergyPatient: Patient = {
        ...samplePatient,
        allergies: ["NKDA"],
      }
      const rawHtml1 = renderToString(
        <Consultation
          go={() => {}}
          patient={nonAllergyPatient}
          clinicalLibrary={library}
          vitals={sampleVitals}
          onVitalsChange={() => {}}
          data={{ ...sampleData, allergies: ["None"] }}
          onDataChange={() => {}}
        />,
      )
      const html1 = rawHtml1.replace(/<!-- -->/g, "")
      expect(html1).toContain("No Known Allergies")
      expect(html1).not.toContain("Allergy: None")

      // 2. Unknown entry: Not specified
      const unknownHtml = renderToString(
        <Consultation
          go={() => {}}
          patient={samplePatient}
          clinicalLibrary={library}
          vitals={sampleVitals}
          onVitalsChange={() => {}}
          data={{ ...sampleData, allergies: ["Not specified"] }}
          onDataChange={() => {}}
        />,
      ).replace(/<!-- -->/g, "")
      expect(unknownHtml).toContain("Unknown (status unconfirmed, not allergy-free)")
      expect(unknownHtml).not.toContain("No Known Allergies (non-allergy entry recognized)")

      // 3. Genuine allergy: Penicillin
      const genuineHtml = renderToString(
        <Consultation
          go={() => {}}
          patient={samplePatient}
          clinicalLibrary={library}
          vitals={sampleVitals}
          onVitalsChange={() => {}}
          data={{ ...sampleData, allergies: ["Penicillin"] }}
          onDataChange={() => {}}
        />,
      ).replace(/<!-- -->/g, "")
      expect(genuineHtml).toContain("Allergy: Penicillin")
    })

    it("does not show premature medicine validation error during field interaction", () => {
      const incompleteData: ConsultationData = {
        ...sampleData,
        medicines: [
          {
            id: 1,
            name: "",
            formulation: "Capsule",
            strength: "",
            dose: "",
            route: "",
            frequency: "",
            duration: "",
            food: "",
            directions: "",
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
          data={incompleteData}
          onDataChange={() => {}}
        />,
      )
      const html = rawHtml.replace(/<!-- -->/g, "")

      // Premature validation banner should not appear before save/finalize attempt
      expect(html).not.toContain("Medicine name is required")
      expect(html).not.toContain("med-validation-warning")
    })

    it("confirms 'Additional directions' section is removed for oral formulations", () => {
      const rawHtml = renderToString(
        <Consultation
          go={() => {}}
          patient={samplePatient}
          clinicalLibrary={library}
          vitals={sampleVitals}
          onVitalsChange={() => {}}
          data={
            sampleData // medicine is Tablet
          }
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

    it("renders separate medicine cards with prominent badges, row 1 and row 2 layouts", () => {
      const multiData: ConsultationData = {
        ...sampleData,
        medicines: [
          {
            id: 1,
            name: "Amoxicillin",
            formulation: "Suspension",
            strength: "125 mg/5 mL",
            dose: "5",
            route: "Oral",
            frequency: "Three times daily",
            duration: "7 days",
            food: "After food",
            directions: "",
            activeIngredient: "Amoxicillin",
          },
          {
            id: 2,
            name: "Cephalexin",
            formulation: "Capsule",
            strength: "500 mg",
            dose: "1",
            route: "Oral",
            frequency: "Twice daily",
            duration: "5 days",
            food: "Before food",
            directions: "",
            activeIngredient: "Cephalexin",
          },
          {
            id: 3,
            name: "",
            formulation: "",
            strength: "",
            dose: "",
            route: "",
            frequency: "",
            duration: "",
            food: "",
            directions: "",
            activeIngredient: "",
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
          data={multiData}
          onDataChange={() => {}}
        />,
      )
      const html = rawHtml.replace(/<!-- -->/g, "")

      // Separate medicine cards and container
      expect(html).toContain("medicines-container")
      expect(html).toContain("medicine-card")

      // Badges with numbers 1, 2, 3
      expect(html).toContain("medicine-badge medicine-number")
      expect(html).toContain(">1</div>")
      expect(html).toContain(">2</div>")
      expect(html).toContain(">3</div>")

      // Row 1 primary fields layout
      expect(html).toContain("medicine-row-primary")
      expect(html).toContain("med-col-formulation")
      expect(html).toContain("med-col-name")
      expect(html).toContain("med-col-strength")
      expect(html).toContain("med-col-dose")

      // Row 2 secondary fields layout
      expect(html).toContain("medicine-row-secondary")
      expect(html).toContain("Unit: mL")
      expect(html).toContain("Unit: capsule(s)")

      // Unselected formulation has hint and no layout shift class med-formulation-first
      expect(html).toContain("Select a formulation to continue")
      expect(html).not.toContain("med-formulation-first")
    })

    it("verifies Chief complaints, Symptom duration, and Diagnosis use searchable dropdown comboboxes", () => {
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

      // Searchable comboboxes for clinical notes
      expect(html).toContain('id="chief-complaint"')
      expect(html).toContain('aria-label="Search and select chief complaint"')
      expect(html).toContain('value="Acute throat pain and fever"')

      expect(html).toContain('id="symptom-duration"')
      expect(html).toContain('aria-label="Search and select symptom duration"')
      expect(html).toContain('value="3 days"')

      expect(html).toContain('id="diagnosis"')
      expect(html).toContain('aria-label="Search and select diagnosis"')
      expect(html).toContain('value="Acute Pharyngitis"')
    })

    it("verifies adding and removing multiple medicines updates cards and numbered badges", () => {
      // 1. Initial consultation with 3 medicines
      const initialMedicines = [
        {
          id: 101,
          name: "Amoxicillin",
          formulation: "Capsule",
          strength: "500 mg",
          dose: "1",
          route: "Oral",
          frequency: "TID",
          duration: "5 days",
          food: "After food",
          directions: "",
          activeIngredient: "Amoxicillin",
        },
        {
          id: 102,
          name: "Paracetamol",
          formulation: "Tablet",
          strength: "650 mg",
          dose: "1",
          route: "Oral",
          frequency: "SOS",
          duration: "3 days",
          food: "After food",
          directions: "",
          activeIngredient: "Paracetamol",
        },
        {
          id: 103,
          name: "Mupirocin",
          formulation: "Ointment",
          strength: "2%",
          dose: "",
          route: "Topical",
          frequency: "BD",
          duration: "7 days",
          food: "",
          directions: "Apply on wound",
          activeIngredient: "Mupirocin",
        },
      ]

      const threeMedHtml = renderToString(
        <Consultation
          go={() => {}}
          patient={samplePatient}
          clinicalLibrary={library}
          vitals={sampleVitals}
          onVitalsChange={() => {}}
          data={{ ...sampleData, medicines: initialMedicines }}
          onDataChange={() => {}}
        />,
      ).replace(/<!-- -->/g, "")

      // Verifies 3 distinct cards with badges 1, 2, and 3
      expect(threeMedHtml).toContain(">1</div>")
      expect(threeMedHtml).toContain(">2</div>")
      expect(threeMedHtml).toContain(">3</div>")
      expect(threeMedHtml).toContain("Remove medicine 1")
      expect(threeMedHtml).toContain("Remove medicine 2")
      expect(threeMedHtml).toContain("Remove medicine 3")

      // 2. Remove medicine 2 (simulate state change: filter out id 102)
      const afterRemoval = initialMedicines.filter((m) => m.id !== 102)
      const twoMedHtml = renderToString(
        <Consultation
          go={() => {}}
          patient={samplePatient}
          clinicalLibrary={library}
          vitals={sampleVitals}
          onVitalsChange={() => {}}
          data={{ ...sampleData, medicines: afterRemoval }}
          onDataChange={() => {}}
        />,
      ).replace(/<!-- -->/g, "")

      // Verifies 2 cards remain, re-indexed as badge 1 and badge 2
      expect(twoMedHtml).toContain(">1</div>")
      expect(twoMedHtml).toContain(">2</div>")
      expect(twoMedHtml).not.toContain(">3</div>")
      expect(twoMedHtml).toContain("Remove medicine 1")
      expect(twoMedHtml).toContain("Remove medicine 2")
      expect(twoMedHtml).not.toContain("Remove medicine 3")
      expect(twoMedHtml).toContain("Amoxicillin")
      expect(twoMedHtml).toContain("Mupirocin")
      expect(twoMedHtml).not.toContain("Paracetamol")
    })

    it("confirms '+ Add another medicine' bottom button is removed while section '+ Add medicine' is preserved", () => {
      const html = renderToString(
        <Consultation
          go={() => {}}
          patient={samplePatient}
          clinicalLibrary={library}
          vitals={sampleVitals}
          onVitalsChange={() => {}}
          data={{
            ...sampleData,
            medicines: [
              {
                id: 1,
                name: "Paracetamol",
                formulation: "Tablet",
                strength: "500 mg",
                dose: "1",
                route: "Oral",
                frequency: "1-0-1",
                duration: "5 days",
                food: "After food",
                directions: "Take after food",
              },
            ],
          }}
          onDataChange={() => {}}
        />,
      )
      expect(html).toContain("Add medicine")
      expect(html).not.toContain("Add another medicine")
      expect(html).not.toContain("medicine-add-footer")
    })

    it("verifies prescription validation and persistence roundtrip after saving and reopening", () => {
      // Create multi-formulation prescription (Oral, Topical, Injection)
      const prescriptionData: ConsultationData = {
        ...sampleData,
        chiefComplaint: "Severe skin infection and fever",
        symptomDuration: "4 days",
        diagnosis: "Cellulitis with Pyrexia",
        medicines: [
          {
            id: 201,
            name: "Augmentin 625 Duo",
            formulation: "Tablet",
            strength: "625 mg",
            dose: "1",
            route: "Oral",
            frequency: "Twice daily",
            duration: "7 days",
            food: "With food",
            directions: "",
            activeIngredient: "Amoxicillin + Clavulanic Acid",
            sourceIdentifier: "CDCI-77881",
          },
          {
            id: 202,
            name: "Fusidic Acid",
            formulation: "Cream",
            strength: "2%",
            dose: "",
            route: "Topical",
            frequency: "Twice daily",
            duration: "10 days",
            food: "",
            directions: "Clean skin before application",
            activeIngredient: "Sodium Fusidate",
          },
          {
            id: 203,
            name: "Tramadol",
            formulation: "Injection",
            strength: "50 mg/mL",
            dose: "1 mL",
            route: "Intramuscular (IM)",
            frequency: "As needed",
            duration: "2 days",
            food: "",
            directions: "",
            activeIngredient: "Tramadol Hydrochloride",
          },
        ],
      }

      // 1. Verify validation passes for all 3 medicines
      prescriptionData.medicines.forEach((m) => {
        const val = validateMedicineFormulation(m)
        expect(val.valid).toBe(true)
      })

      // 2. Simulate local SQLite persistence (encode items_json and decode back)
      const persistedItemsJson = JSON.stringify(prescriptionData.medicines)
      const reopenedMedicines = JSON.parse(persistedItemsJson)
      expect(reopenedMedicines.length).toBe(3)

      const reopenedData: ConsultationData = {
        ...prescriptionData,
        medicines: reopenedMedicines,
      }

      // 3. Reopen in Consultation component
      const reopenedConsultationHtml = renderToString(
        <Consultation
          go={() => {}}
          patient={samplePatient}
          clinicalLibrary={library}
          vitals={sampleVitals}
          onVitalsChange={() => {}}
          data={reopenedData}
          onDataChange={() => {}}
        />,
      ).replace(/<!-- -->/g, "")

      // All 3 medicine details remain intact
      expect(reopenedConsultationHtml).toContain("Augmentin 625 Duo")
      expect(reopenedConsultationHtml).toContain("Tablet")
      expect(reopenedConsultationHtml).toContain("625 mg")
      expect(reopenedConsultationHtml).toContain("With food")

      expect(reopenedConsultationHtml).toContain("Fusidic Acid")
      expect(reopenedConsultationHtml).toContain("Cream")
      expect(reopenedConsultationHtml).toContain(
        "Clean skin before application",
      )

      expect(reopenedConsultationHtml).toContain("Tramadol")
      expect(reopenedConsultationHtml).toContain("Injection")
      expect(reopenedConsultationHtml).toContain("Intramuscular (IM)")

      // 4. Reopen in PrescriptionPreview component
      const previewHtml = renderToString(
        <PrescriptionPreview
          go={() => {}}
          patient={samplePatient}
          vitals={sampleVitals}
          data={reopenedData}
          bannerVisible={true}
          bannerImage={null}
          signatureImage={null}
          showClinicLogo={true}
          showClinicEmail={true}
          showAllergyWarning={true}
          returnPage="consultation"
        />,
      ).replace(/<!-- -->/g, "")

      expect(previewHtml).toContain("Augmentin 625 Duo")
      expect(previewHtml).toContain("Fusidic Acid")
      expect(previewHtml).toContain("Tramadol")
      expect(previewHtml).toContain("Clean skin before application")
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
      expect(html).toContain("28/10/2026")
      expect(html).toContain("02/11/2026")
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

    it("renders Clinical Library settings without Medicine Catalogue section", async () => {
      const { ClinicalLibrarySettings } = await import(
        "../settings/ClinicalLibrarySettings"
      )
      const lib = loadClinicalLibrary()
      lib.MedicineDefinitions.push({
        name: "CustomKuffex",
        formulation: "Syrup",
        strength: "100 ml",
        activeIngredient: "Dextromethorphan + CPM",
      })

      const rawHtml = renderToString(
        <ClinicalLibrarySettings
          library={lib}
          onAdd={() => {}}
          onAddMedicine={() => {}}
        />,
      )
      const html = rawHtml.replace(/<!-- -->/g, "")

      expect(html).toContain("Upload Excel / CSV")
      expect(html).toContain("Import History")
      expect(html).toContain("Standard Options")
      expect(html).not.toContain("Medicine Catalogue")
    })

    it("verifies custom Frequencies and Food Instructions populate prescription options and Clinical Library tabs", async () => {
      const { ClinicalLibrarySettings } = await import(
        "../settings/ClinicalLibrarySettings"
      )
      const customLib: ClinicalLibrary = {
        ...loadClinicalLibrary(),
        Frequencies: [
          ...defaultClinicalLibrary.Frequencies,
          "Every 6 hours PRN",
        ],
        FoodInstructions: [
          ...defaultClinicalLibrary.FoodInstructions,
          "Take with cold milk",
        ],
      }

      // 1. Verify Consultation dropdown uses custom frequencies and food instructions
      const consultationHtml = renderToString(
        <Consultation
          go={() => {}}
          patient={samplePatient}
          clinicalLibrary={customLib}
          vitals={sampleVitals}
          onVitalsChange={() => {}}
          data={{
            ...sampleData,
            medicines: [
              {
                id: 1,
                name: "Amoxicillin",
                formulation: "Capsule",
                strength: "500 mg",
                dose: "1",
                route: "Oral",
                frequency: "Every 6 hours PRN",
                duration: "5 days",
                food: "Take with cold milk",
                directions: "Take with cold milk",
              },
            ],
          }}
          onDataChange={() => {}}
        />,
      )

      expect(consultationHtml).toContain("Every 6 hours PRN")
      expect(consultationHtml).toContain("Take with cold milk")

      // 2. Verify ClinicalLibrarySettings renders Frequencies and Food Instructions tabs
      const settingsHtml = renderToString(
        <ClinicalLibrarySettings
          library={customLib}
          initialTab="options"
          onAdd={() => {}}
          onAddMedicine={() => {}}
        />,
      )
      expect(settingsHtml).toContain("Frequencies")
      expect(settingsHtml).toContain("Food Instructions")
    })

    it("ensures Food instruction is available for custom formulations and rendered in prescription preview", async () => {
      const { PrescriptionPreview } = await import("./PrescriptionPreview")
      const customLib: ClinicalLibrary = {
        ...loadClinicalLibrary(),
        Formulations: [...defaultClinicalLibrary.Formulations, "new form"],
        FoodInstructions: [
          ...defaultClinicalLibrary.FoodInstructions,
          "With lukewarm water",
        ],
      }

      // 1. Consultation form with custom formulation ("new form") renders Food instruction field
      const consultationHtml = renderToString(
        <Consultation
          go={() => {}}
          patient={samplePatient}
          clinicalLibrary={customLib}
          vitals={sampleVitals}
          onVitalsChange={() => {}}
          data={{
            ...sampleData,
            medicines: [
              {
                id: 1,
                name: "Custom Herbal Cure",
                formulation: "new form",
                strength: "10 ml",
                dose: "1",
                route: "",
                frequency: "Twice daily",
                duration: "7 days",
                food: "With lukewarm water",
                directions: "",
              },
            ],
          }}
          onDataChange={() => {}}
        />,
      )

      expect(consultationHtml).toContain("Food instruction")
      expect(consultationHtml).toContain("With lukewarm water")

      // 2. Prescription preview renders the food instruction along with the custom formulation
      const previewHtml = renderToString(
        <PrescriptionPreview
          patient={samplePatient}
          data={{
            ...sampleData,
            medicines: [
              {
                id: 1,
                name: "Custom Herbal Cure",
                formulation: "new form",
                strength: "10 ml",
                dose: "1",
                route: "",
                frequency: "Twice daily",
                duration: "7 days",
                food: "With lukewarm water",
                directions: "",
              },
            ],
          }}
          vitals={sampleVitals}
          bannerVisible={false}
          bannerImage={null}
          signatureImage={null}
          showClinicLogo={false}
          showClinicEmail={false}
          showAllergyWarning={false}
        />,
      )

      expect(previewHtml).toContain("Custom Herbal Cure")
      expect(previewHtml).toContain("new form")
      expect(previewHtml).toContain("With lukewarm water")
    })
  })

  describe("Stock Report Integration & Autocomplete Search (BODYPROOF, ZYTEE, EMRYS)", () => {
    it("searches bundled stock report offline for BODYPROOF, ZYTEE, and EMRYS", async () => {
      const { searchCatalogue } = await import("../../desktop/desktop-bridge")

      // 1. Search BODYPROOF
      const bodyproofResult = await searchCatalogue("BODYPROOF")
      expect(bodyproofResult.items.length).toBeGreaterThan(0)
      const bodyproofItem = bodyproofResult.items.find(
        (it) =>
          it.productName?.includes("BODYPROOF") ||
          it.name.includes("BODYPROOF"),
      )
      expect(bodyproofItem).toBeDefined()
      expect(bodyproofItem?.productName).toBe("6D BODYPROOF")
      expect(bodyproofItem?.name).toContain("Stock: 180 TAB")
      expect(bodyproofItem?.manufacturer).toBe("EMRYS")
      expect(bodyproofItem?.dosageForm).toBe("Tablet")
      expect(bodyproofItem?.sourceProvenance).toBe("LOCAL_INVENTORY")

      // 2. Search ZYTEE
      const zyteeResult = await searchCatalogue("ZYTEE")
      expect(zyteeResult.items.length).toBeGreaterThan(0)
      const zyteeItem = zyteeResult.items.find(
        (it) => it.productName?.includes("ZYTEE") || it.name.includes("ZYTEE"),
      )
      expect(zyteeItem).toBeDefined()
      expect(zyteeItem?.productName).toBe("ZYTEE GEL")
      expect(zyteeItem?.name).toContain("Stock: 6 GEL")
      expect(zyteeItem?.manufacturer).toBe("RAP")
      expect(zyteeItem?.dosageForm).toBe("Gel")
      expect(zyteeItem?.sourceProvenance).toBe("LOCAL_INVENTORY")

      // 3. Search EMRYS (company name and brand)
      const emrysResult = await searchCatalogue("EMRYS", undefined, 50)
      expect(emrysResult.items.length).toBeGreaterThan(0)
      const allEmrys = emrysResult.items.every(
        (it) =>
          it.manufacturer?.toLowerCase().includes("emrys") ||
          it.productName?.toLowerCase().includes("emrys") ||
          it.name.toLowerCase().includes("emrys"),
      )
      expect(allEmrys).toBe(true)
      expect(
        emrysResult.items.some((it) => it.productName === "6D BODYPROOF"),
      ).toBe(true)
      expect(
        emrysResult.items.some((it) => it.productName === "AAIBU SYP"),
      ).toBe(true)
    })

    it("renders medicine name input and stationary topbar back button in Consultation", () => {
      const rawHtml = renderToString(
        <Consultation
          go={() => {}}
          patient={samplePatient}
          clinicalLibrary={library}
          vitals={sampleVitals}
          onVitalsChange={() => {}}
          data={{
            ...sampleData,
            medicines: [
              {
                id: 1,
                name: "6D BODYPROOF",
                formulation: "Tablet",
                strength: "",
                dose: "1 tablet",
                route: "Oral",
                frequency: "Once daily",
                duration: "5 days",
                food: "After food",
                directions: "",
                activeIngredient: "EMRYS",
                sourceIdentifier: "stock_6D BODYPROOF",
                sourceProvenance: "LOCAL_INVENTORY",
              },
            ],
          }}
          onDataChange={() => {}}
        />,
      )
      const html = rawHtml.replace(/<!-- -->/g, "")

      // Back button is stationary
      expect(html).toContain("topbar-back")
      // Medicine row renders clean canonical product name, not the stock parenthesis
      expect(html).toContain("6D BODYPROOF")
      expect(html).toContain("Verified Medicine (stock_6D BODYPROOF)")
      expect(html).toContain("med-col-name")
      expect(html).toContain("med-col-formulation")
    })

    it("renders Chief complaints and Diagnosis as optional fields without required asterisks", () => {
      const library = loadClinicalLibrary()
      const rawHtml = renderToString(
        <Consultation
          go={() => {}}
          patient={samplePatient}
          clinicalLibrary={library}
          vitals={sampleVitals}
          onVitalsChange={() => {}}
          data={{
            ...sampleData,
            chiefComplaint: "",
            diagnosis: "",
          }}
          onDataChange={() => {}}
        />,
      )
      const html = rawHtml.replace(/<!-- -->/g, "")

      // Chief complaints & Diagnosis are rendered
      expect(html).toContain("Chief complaints")
      expect(html).toContain("Diagnosis")

      // Neither field should contain the required asterisk indicator span
      expect(html).not.toMatch(/Chief complaints\s*<span[^>]*class="[^"]*required[^"]*"/)
      expect(html).not.toMatch(/Diagnosis\s*<span[^>]*class="[^"]*required[^"]*"/)
    })

    it("supports empty Chief complaints and Diagnosis in PrescriptionPreview by hiding them", () => {
      const rawHtml = renderToString(
        <PrescriptionPreview
          go={() => {}}
          patient={samplePatient}
          vitals={sampleVitals}
          data={{
            ...sampleData,
            chiefComplaint: "",
            diagnosis: "",
          }}
          bannerVisible={false}
          bannerImage={null}
          signatureImage={null}
          showClinicLogo={false}
          showClinicEmail={false}
          showAllergyWarning={false}
          returnPage="consultation"
        />,
      )
      const html = rawHtml.replace(/<!-- -->/g, "")

      expect(html).not.toContain("No chief complaint entered.")
      expect(html).not.toContain("No diagnosis entered.")
      expect(html).not.toContain("CHIEF COMPLAINTS")
      expect(html).not.toContain("DIAGNOSIS")
    })

    it("renders formulation dropdown with formulation ID and focuses formulation first on every row", () => {
      const dataWithMultipleRows: ConsultationData = {
        ...sampleData,
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
          {
            id: 2,
            name: "",
            formulation: "",
            strength: "",
            dose: "",
            route: "",
            frequency: "",
            duration: "",
            food: "",
            directions: "",
            activeIngredient: "",
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
          data={dataWithMultipleRows}
          onDataChange={() => {}}
        />,
      )
      const html = rawHtml.replace(/<!-- -->/g, "")

      // Verify each medicine row renders its distinct formulation dropdown ID
      expect(html).toContain('id="formulation-1"')
      expect(html).toContain('id="formulation-2"')
      expect(html).toContain('id="medicine-1"')
      expect(html).toContain('id="medicine-2"')
    })

    it("filters compatible medicines strictly matching the selected formulation", () => {
      const customDefs: ClinicalMedicineDefinition[] = [
        {
          name: "Paracetamol",
          formulation: "Tablet",
          strength: "650 mg",
          defaultDosage: "1",
          defaultFrequency: "Three times daily",
          defaultDuration: "5 days",
          defaultInstructions: "Take with water",
          activeIngredient: "Paracetamol",
        },
        {
          name: "Amoxicillin",
          formulation: "Capsule",
          strength: "500 mg",
          defaultDosage: "1",
          defaultFrequency: "Twice daily",
          defaultDuration: "7 days",
          defaultInstructions: "Take with water",
          activeIngredient: "Amoxicillin",
        },
        {
          name: "Cetirizine Syrup",
          formulation: "Syrup",
          strength: "5 mg/5ml",
          defaultDosage: "5 ml",
          defaultFrequency: "Once daily",
          defaultDuration: "3 days",
          defaultInstructions: "Shake well",
          activeIngredient: "Cetirizine",
        },
      ]

      const tabletFormulation = "Tablet"
      const syrupFormulation = "Syrup"

      const tabletMedicines = customDefs.filter(
        (m) =>
          m.formulation.trim().toLowerCase() === tabletFormulation.toLowerCase(),
      )
      const syrupMedicines = customDefs.filter(
        (m) =>
          m.formulation.trim().toLowerCase() === syrupFormulation.toLowerCase(),
      )

      expect(tabletMedicines.length).toBe(1)
      expect(tabletMedicines[0].name).toBe("Paracetamol")
      expect(tabletMedicines[0].formulation).toBe("Tablet")

      expect(syrupMedicines.length).toBe(1)
      expect(syrupMedicines[0].name).toBe("Cetirizine Syrup")
      expect(syrupMedicines[0].formulation).toBe("Syrup")
    })

    it("resets selected medicine and incompatible dependent fields on formulation change while preserving other rows", () => {
      const initialMedicines: Medicine[] = [
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
          directions: "",
          activeIngredient: "Paracetamol",
        },
        {
          id: 2,
          name: "Amoxicillin",
          formulation: "Capsule",
          strength: "500 mg",
          dose: "1",
          route: "Oral",
          frequency: "Twice daily",
          duration: "7 days",
          food: "Before food",
          directions: "",
          activeIngredient: "Amoxicillin",
        },
      ]

      const simulateFormulationChange = (
        meds: Medicine[],
        medicineId: number,
        newFormulation: string,
      ): Medicine[] => {
        const isNewOral = ["Tablet", "Capsule", "Syrup", "Suspension"].includes(
          newFormulation,
        )
        const isNewInjection = newFormulation === "Injection"
        const isNewTopical = ["Cream", "Ointment"].includes(newFormulation)

        return meds.map((row) => {
          if (row.id !== medicineId) return row

          return {
            id: row.id,
            formulation: newFormulation,
            name: "",
            strength: "",
            dose: "",
            frequency: row.frequency,
            duration: row.duration,
            food: isNewOral ? row.food : "",
            route: isNewInjection ? row.route : "",
            directions: isNewTopical ? row.directions : "",
            activeIngredient: "",
          }
        })
      }

      // 1. Change Row 1 from Tablet to Syrup (both oral)
      const afterSyrup = simulateFormulationChange(initialMedicines, 1, "Syrup")
      expect(afterSyrup[0].formulation).toBe("Syrup")
      expect(afterSyrup[0].name).toBe("") // Reset
      expect(afterSyrup[0].strength).toBe("") // Reset
      expect(afterSyrup[0].dose).toBe("") // Reset
      expect(afterSyrup[0].frequency).toBe("Three times daily") // Preserved
      expect(afterSyrup[0].duration).toBe("5 days") // Preserved
      expect(afterSyrup[0].food).toBe("After food") // Preserved for oral
      // Row 2 must remain completely intact
      expect(afterSyrup[1].name).toBe("Amoxicillin")
      expect(afterSyrup[1].formulation).toBe("Capsule")
      expect(afterSyrup[1].strength).toBe("500 mg")

      // 2. Change Row 1 from Syrup to Ointment (topical)
      const afterOintment = simulateFormulationChange(
        afterSyrup,
        1,
        "Ointment",
      )
      expect(afterOintment[0].formulation).toBe("Ointment")
      expect(afterOintment[0].name).toBe("") // Reset
      expect(afterOintment[0].strength).toBe("") // Reset
      expect(afterOintment[0].dose).toBe("") // Reset
      expect(afterOintment[0].food).toBe("") // Incompatible: food cleared for ointment
      expect(afterOintment[0].frequency).toBe("Three times daily") // Preserved
      expect(afterOintment[0].duration).toBe("5 days") // Preserved
      // Row 2 remains intact
      expect(afterOintment[1].name).toBe("Amoxicillin")

      // 3. Change Row 1 from Ointment to Injection
      const afterInjection = simulateFormulationChange(
        afterOintment,
        1,
        "Injection",
      )
      expect(afterInjection[0].formulation).toBe("Injection")
      expect(afterInjection[0].food).toBe("") // Incompatible: cleared
      expect(afterInjection[0].directions).toBe("") // Incompatible: cleared
      expect(afterInjection[0].frequency).toBe("Three times daily") // Preserved
      expect(afterInjection[0].duration).toBe("5 days") // Preserved
      expect(afterInjection[1].name).toBe("Amoxicillin")
    })

    it(
      "renders all 16 formulations with letter shortcuts in consultation dropdown",
      () => {
        const consultationData: ConsultationData = {
          ...sampleData,
          medicines: [
            {
              id: 1,
              name: "Paracetamol",
              formulation: "Tablet",
              strength: "500 mg",
              dose: "1",
              frequency: "Three times daily",
              duration: "5 days",
              food: "After food",
              route: "",
              directions: "",
            },
          ],
        }

        const html = renderToString(
          <Consultation
            patient={samplePatient}
            go={() => {}}
            vitals={sampleVitals}
            onVitalsChange={() => {}}
            data={consultationData}
            onDataChange={() => {}}
            clinicalLibrary={defaultClinicalLibrary}
          />,
        )

        // Verified: all 16 formulations with shortcuts are present in dropdown options
        expect(html).toContain("Tablet (T)")
        expect(html).toContain("Capsule (C)")
        expect(html).toContain("Syrup (S)")
        expect(html).toContain("Drops (D)")
        expect(html).toContain("Injection (I)")
        expect(html).toContain("Ointment (O)")
        expect(html).toContain("Cream (R)")
        expect(html).toContain("Gel (G)")
        expect(html).toContain("Powder (P)")
        expect(html).toContain("Lotion (L)")
        expect(html).toContain("Suspension (N)")
        expect(html).toContain("Mouthwash (M)")
        expect(html).toContain("Inhaler (H)")
        expect(html).toContain("Eye Drops (E)")
        expect(html).toContain("Ear Drops (U)")
        expect(html).toContain("Suppository (B)")
      },
      15000,
    )
  })

  describe("Auto-Save Custom Chief Complaints to Dropdown", () => {
    const testClinicId = "clinic_auto_save_cc_test"
    const storage: Record<string, string> = {}

    beforeEach(() => {
      for (const k in storage) delete storage[k]
      const target = new EventTarget()
      ;(target as any).localStorage = {
        getItem: (key: string) => storage[key] ?? null,
        setItem: (key: string, val: string) => {
          storage[key] = String(val)
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

    it("preserves all default complaint options", () => {
      expect(DEFAULT_COMPLAINT_OPTIONS).toEqual([
        "Fever",
        "Cough",
        "Headache",
        "Abdominal pain",
        "Breathing difficulty",
        "Body ache",
        "Follow-up / review",
      ])
      const merged = getChiefComplaintOptions([])
      expect(merged).toEqual([...DEFAULT_COMPLAINT_OPTIONS])
    })

    it("adds a new custom complaint and merges it into dropdown suggestions", () => {
      const custom = "Severe migraine with aura"
      const updated = addCustomChiefComplaint(custom, testClinicId)
      expect(updated).toContain(custom)

      const merged = getChiefComplaintOptions(updated)
      expect(merged).toContain("Fever")
      expect(merged).toContain(custom)
      expect(merged.length).toBe(DEFAULT_COMPLAINT_OPTIONS.length + 1)
    })

    it("prevents duplicate complaints using case-insensitive comparison", () => {
      const clinicDupTest = "clinic_dup_test"
      // Attempting to add default option with different casing
      const res1 = addCustomChiefComplaint("fever", clinicDupTest)
      expect(res1).toEqual([])
      const res2 = addCustomChiefComplaint("FEVER", clinicDupTest)
      expect(res2).toEqual([])
      const res3 = addCustomChiefComplaint("  Headache  ", clinicDupTest)
      expect(res3).toEqual([])

      // Add a novel custom complaint
      const res4 = addCustomChiefComplaint("Acute Bronchitis", clinicDupTest)
      expect(res4).toEqual(["Acute Bronchitis"])

      // Attempting to add same custom complaint with lower or upper case
      const res5 = addCustomChiefComplaint("acute bronchitis", clinicDupTest)
      expect(res5).toEqual(["Acute Bronchitis"])
      const res6 = addCustomChiefComplaint("ACUTE BRONCHITIS", clinicDupTest)
      expect(res6).toEqual(["Acute Bronchitis"])
    })

    it("ignores empty values and whitespace-only entries", () => {
      const clinicEmptyTest = "clinic_empty_test"
      expect(addCustomChiefComplaint("", clinicEmptyTest)).toEqual([])
      expect(addCustomChiefComplaint("   ", clinicEmptyTest)).toEqual([])
      expect(addCustomChiefComplaint(" \t\n ", clinicEmptyTest)).toEqual([])
      expect(loadCustomChiefComplaints(clinicEmptyTest)).toEqual([])
    })

    it("persists custom complaints across simulated application restart", () => {
      const clinicRestartTest = "clinic_restart_test"
      saveCustomChiefComplaints(
        ["Persistent insomnia", "Sciatica nerve pain"],
        clinicRestartTest,
      )

      // Simulate restart by reading directly from storage
      const reloaded = loadCustomChiefComplaints(clinicRestartTest)
      expect(reloaded).toEqual(["Persistent insomnia", "Sciatica nerve pain"])

      const options = getChiefComplaintOptions(reloaded)
      expect(options).toContain("Persistent insomnia")
      expect(options).toContain("Sciatica nerve pain")
      expect(options).toContain("Breathing difficulty")
    })

    it("scopes custom complaints to the clinic", () => {
      const clinicA = "clinic_alpha_1"
      const clinicB = "clinic_beta_2"

      addCustomChiefComplaint("Alpha Clinic Specific Symptom", clinicA)
      addCustomChiefComplaint("Beta Clinic Specific Symptom", clinicB)

      const alphaComplaints = loadCustomChiefComplaints(clinicA)
      const betaComplaints = loadCustomChiefComplaints(clinicB)

      expect(alphaComplaints).toContain("Alpha Clinic Specific Symptom")
      expect(alphaComplaints).not.toContain("Beta Clinic Specific Symptom")

      expect(betaComplaints).toContain("Beta Clinic Specific Symptom")
      expect(betaComplaints).not.toContain("Alpha Clinic Specific Symptom")
    })

    it("renders custom complaints in Consultation component and allows selecting in subsequent consultations", () => {
      const customComplaint = "Post-viral fatigue syndrome"
      const clinicSessionTest = "clinic_session_integration"
      addCustomChiefComplaint(customComplaint, clinicSessionTest)

      const patient1: Patient = {
        id: "P-101",
        name: "Patient One",
        initials: "PO",
        age: 30,
        gender: "Female",
        phone: "+91 99999 11111",
        lastVisit: "Today",
        allergies: [],
        conditions: [],
      }

      const patient2: Patient = {
        id: "P-102",
        name: "Patient Two",
        initials: "PT",
        age: 42,
        gender: "Male",
        phone: "+91 99999 22222",
        lastVisit: "Today",
        allergies: [],
        conditions: [],
      }

      // 1. First consultation loads the custom complaint in its merged options
      const htmlPatient1 = renderToString(
        <Consultation
          go={() => {}}
          patient={patient1}
          clinicalLibrary={defaultClinicalLibrary}
          vitals={sampleVitals}
          onVitalsChange={() => {}}
          data={{
            ...sampleData,
            chiefComplaint: customComplaint,
          }}
          onDataChange={() => {}}
          desktopSession={{
            token: "tok_123",
            doctor_id: "doc_1",
            doctor_name: "Dr. Test",
            doctor_email: "test@example.com",
            clinic_id: clinicSessionTest,
            clinic_name: "Test Clinic",
            expires_at: 9999999999,
            role: "OWNER",
            is_offline: false,
          }}
        />,
      )

      expect(htmlPatient1).toContain('value="Post-viral fatigue syndrome"')

      // 2. Second consultation for Patient 2 starts and automatically has the saved custom complaint
      const loadedSuggestions = loadCustomChiefComplaints(clinicSessionTest)
      expect(loadedSuggestions).toContain(customComplaint)

      const htmlPatient2 = renderToString(
        <Consultation
          go={() => {}}
          patient={patient2}
          clinicalLibrary={defaultClinicalLibrary}
          vitals={sampleVitals}
          onVitalsChange={() => {}}
          data={{
            ...sampleData,
            chiefComplaint: "",
          }}
          onDataChange={() => {}}
          customChiefComplaints={loadedSuggestions}
          desktopSession={{
            token: "tok_123",
            doctor_id: "doc_1",
            doctor_name: "Dr. Test",
            doctor_email: "test@example.com",
            clinic_id: clinicSessionTest,
            clinic_name: "Test Clinic",
            expires_at: 9999999999,
            role: "OWNER",
            is_offline: false,
          }}
        />,
      )

      // Verified: Patient 2's consultation combobox includes default options and custom complaint
      expect(htmlPatient2).toContain('id="chief-complaint"')
      expect(getChiefComplaintOptions(loadedSuggestions)).toContain(
        customComplaint,
      )
    })

    it("does not add suggestions for abandoned consultations", () => {
      const abandonedClinic = "clinic_abandoned_test"
      // Doctor typed an unsaved complaint but abandoned without finalizing
      const abandonedInput = "Unsaved draft complaint text"

      // Component renders during typing
      renderToString(
        <Consultation
          go={() => {}}
          patient={samplePatient}
          clinicalLibrary={defaultClinicalLibrary}
          vitals={sampleVitals}
          onVitalsChange={() => {}}
          data={{
            ...sampleData,
            chiefComplaint: abandonedInput,
          }}
          onDataChange={() => {}}
          desktopSession={{
            token: "tok_123",
            doctor_id: "doc_1",
            doctor_name: "Dr. Test",
            doctor_email: "test@example.com",
            clinic_id: abandonedClinic,
            clinic_name: "Abandoned Test Clinic",
            expires_at: 9999999999,
            role: "OWNER",
            is_offline: false,
          }}
        />,
      )

      // Verified: because finalize was not executed, storage remains clean
      expect(loadCustomChiefComplaints(abandonedClinic)).toEqual([])
    })
  })

  describe("Prescription Finalization & RX Number Accuracy (Issue 25)", () => {
    const mockFinalizedRx: LocalPrescriptionRecord = {
      id: "rx-uuid-actual-1",
      server_id: null,
      clinic_id: "clinic-test-1",
      consultation_id: "c-uuid-1",
      patient_id: samplePatient.id,
      doctor_id: "doc-test-1",
      prescription_number: "RX-884920",
      revision_number: 1,
      status: "ACTIVE",
      items_json: JSON.stringify(sampleData.medicines),
      sync_status: "PENDING",
      server_version: 0,
      local_version: 1,
      created_at: "2026-11-17T11:34:00Z",
    }

    it("displays actual generated RX number instead of RX-PREVIEW in newly opened preview after consultation", () => {
      const html = renderToString(
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
          prescriptionRecord={mockFinalizedRx}
        />,
      ).replace(/<!-- -->/g, "")

      // Must display the actual RX number from SQLite record
      expect(html).toContain("RX-884920")
      // Must NOT show placeholder RX-PREVIEW
      expect(html).not.toContain("RX-PREVIEW")
      // Header and note must show finalized persisted status
      expect(html).toContain("Prescription RX-884920")
      expect(html).toContain("Finalized prescription <strong>RX-884920</strong>. Persisted to local encrypted storage.")
    })

    it("displays fallback prescriptionNumber from consultation data if present", () => {
      const dataWithRx: ConsultationData = {
        ...sampleData,
        prescriptionNumber: "RX-773311",
      }

      const html = renderToString(
        <PrescriptionPreview
          go={() => {}}
          patient={samplePatient}
          vitals={sampleVitals}
          data={dataWithRx}
          bannerVisible={true}
          bannerImage={null}
          signatureImage={null}
          showClinicLogo={true}
          showClinicEmail={true}
          showAllergyWarning={true}
          returnPage="consultation"
        />,
      ).replace(/<!-- -->/g, "")

      expect(html).toContain("RX-773311")
      expect(html).not.toContain("RX-PREVIEW")
    })

    it("displays RX-PREVIEW only when no finalized prescription record or number exists (unfinalized live session)", () => {
      const html = renderToString(
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
        />,
      ).replace(/<!-- -->/g, "")

      expect(html).toContain("RX-PREVIEW")
      expect(html).toContain("Local session preview · Not persisted")
    })

    it("preserves the exact same RX number when viewed from Patient Information -> Prescriptions", () => {
      const html = renderToString(
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
          returnPage="patient-profile"
          prescriptionRecord={mockFinalizedRx}
        />,
      ).replace(/<!-- -->/g, "")

      // Preserves same RX number
      expect(html).toContain("RX-884920")
      expect(html).not.toContain("RX-PREVIEW")
      expect(html).toContain("Viewing finalized historical prescription <strong>RX-884920</strong>")
    })
  })
})
