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
import { validateMedicineFormulation } from "../../utils/billing"

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
      expect(reopenedConsultationHtml).toContain("Clean skin before application")

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

    it("verifies custom medicine appears in Clinical Formulary settings", async () => {
      const { ClinicalLibrarySettings } = await import("../settings/ClinicalLibrarySettings")
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

      expect(html).toContain("CustomKuffex")
      expect(html).toContain("Syrup · 100 ml")
      expect(html).toContain("(Dextromethorphan + CPM)")
    })
  })

  describe("Stock Report Integration & Autocomplete Search (BODYPROOF, ZYTEE, EMRYS)", () => {
    it("searches bundled stock report offline for BODYPROOF, ZYTEE, and EMRYS", async () => {
      const { searchCatalogue } = await import("../../desktop/desktop-bridge")

      // 1. Search BODYPROOF
      const bodyproofResult = await searchCatalogue("BODYPROOF")
      expect(bodyproofResult.items.length).toBeGreaterThan(0)
      const bodyproofItem = bodyproofResult.items.find((it) =>
        it.productName?.includes("BODYPROOF") || it.name.includes("BODYPROOF"),
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
      const zyteeItem = zyteeResult.items.find((it) =>
        it.productName?.includes("ZYTEE") || it.name.includes("ZYTEE"),
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
      expect(emrysResult.items.some((it) => it.productName === "6D BODYPROOF")).toBe(true)
      expect(emrysResult.items.some((it) => it.productName === "AAIBU SYP")).toBe(true)
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
  })
})
