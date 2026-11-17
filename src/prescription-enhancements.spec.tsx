import { describe, it, expect, beforeEach, vi } from "vitest"
import React from "react"
import { renderToString } from "react-dom/server"
import fs from "node:fs"
import path from "node:path"
import { PrescriptionPreview } from "./components/consultation/PrescriptionPreview"
import { BillPreview } from "./components/billing/BillPreview"
import { ClinicalLibrarySettings } from "./components/settings/ClinicalLibrarySettings"
import { PrescriptionSettings } from "./components/settings/PrescriptionSettings"
import { BillLayoutSettings } from "./components/settings/BillLayoutSettings"
import {
  defaultPrescriptionLayoutPreferences,
  defaultBillLayoutPreferences,
  loadClinicalLibrary,
  defaultClinicalLibrary,
  type Patient,
  type Vitals,
  type ConsultationData,
  type BillData,
  type ClinicalLibrary,
} from "./types"

const mockPatient: Patient = {
  id: "P-101",
  name: "Vikram Mehta",
  age: "52",
  gender: "Male",
  phone: "9876543210",
  allergies: ["Penicillin"],
  medical_conditions: "Hypertension",
}

const mockVitals: Vitals = {
  systolic: "120",
  diastolic: "80",
  heartRate: "72",
  spo2: "99",
  temperature: "98.4",
  height: "175",
  weight: "70",
}

const mockConsultationData: ConsultationData = {
  date: "2026-11-17",
  time: "10:30",
  chiefComplaint: "Fever and cough",
  symptomDuration: "3 days",
  diagnosis: "Acute Bronchitis",
  conditions: ["Hypertension"],
  medicines: [
    {
      id: "med-1",
      name: "6D BODYPROOF",
      formulation: "Tablet",
      strength: "5 mg",
      dose: "1 tablet",
      frequency: "Twice daily",
      route: "Oral",
      food: "After food",
      directions: "With warm water",
      duration: "3 days",
    },
    {
      id: "med-2",
      name: "PARACETAMOL",
      formulation: "Tablet",
      strength: "650 mg",
      dose: "1 tablet",
      frequency: "As needed",
      route: "Oral",
      food: "After food",
      directions: "",
      duration: "5 days",
    },
  ],
  followUpDate: "2026-11-20",
  followUpInstructions: "Review if fever persists",
}

const mockBillData: BillData = {
  invoiceNumber: "INV-2026-001",
  date: "2026-11-17",
  status: "DRAFT",
  paymentStatus: "Unpaid",
  discount: 0,
  taxRatePercent: 0,
  items: [
    {
      id: 1,
      description: "Consultation Fee",
      quantity: 1,
      rate: 500,
    },
  ],
}

describe("Prescription, Print & UI Enhancements (Issues 13–18)", () => {
  let mockStorage: Record<string, string> = {}

  beforeEach(() => {
    mockStorage = {}
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => mockStorage[key] ?? null,
        setItem: (key: string, val: string) => {
          mockStorage[key] = String(val)
        },
        removeItem: (key: string) => {
          delete mockStorage[key]
        },
        clear: () => {
          mockStorage = {}
        },
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
  })

  describe("Issue 18: Remove Route from Prescription Instructions", () => {
    it("displays only food and directions in instructions, omitting route", () => {
      const html = renderToString(
        <PrescriptionPreview
          go={() => {}}
          patient={mockPatient}
          vitals={mockVitals}
          data={mockConsultationData}
          bannerVisible={true}
          bannerImage={null}
          signatureImage={null}
          showClinicLogo={true}
          showClinicEmail={true}
          showAllergyWarning={true}
          returnPage="consultation"
        />,
      )

      // Medicine 1 had route: "Oral", food: "After food", directions: "With warm water"
      // Visible instruction must be "After food · With warm water", NOT containing "Oral"
      expect(html).toContain("After food · With warm water")
      expect(html).not.toContain("Oral · After food · With warm water")

      // Medicine 2 had route: "Oral", food: "After food", directions: ""
      // Visible instruction must be "After food", NOT "Oral · After food"
      expect(html).toContain("After food")
      expect(html).not.toContain("Oral · After food")

      // Verify the internal medicine object still preserves route: "Oral"
      expect(mockConsultationData.medicines[0].route).toBe("Oral")
    })
  })

  describe("Issue 17: Adjustable Top Spacing for Prescription & Billing", () => {
    it("applies adjustable top spacing in millimeters to prescription preview markup", () => {
      const html = renderToString(
        <PrescriptionPreview
          go={() => {}}
          patient={mockPatient}
          vitals={mockVitals}
          data={mockConsultationData}
          bannerVisible={true}
          bannerImage={null}
          signatureImage={null}
          showClinicLogo={true}
          showClinicEmail={true}
          showAllergyWarning={true}
          returnPage="consultation"
          topSpacingMm={25}
        />,
      )

      expect(html).toContain("prescription-paper")
      expect(html).toContain("padding-top:calc(44px + 25mm)")
      expect(html).toContain("--rx-top-spacing:25mm")
    })

    it("applies adjustable top spacing in millimeters to bill preview markup", () => {
      const html = renderToString(
        <BillPreview
          go={() => {}}
          patient={mockPatient}
          bill={mockBillData}
          bannerImage={null}
          signatureImage={null}
          layout={{
            ...defaultBillLayoutPreferences,
            topSpacingMm: 30,
          }}
          returnPage="settings"
        />,
      )

      expect(html).toContain("bill-paper")
      expect(html).toContain("padding-top:calc(44px + 30mm)")
      expect(html).toContain("--bill-top-spacing:30mm")
    })

    it("renders top spacing slider with Reset to Default in PrescriptionSettings", () => {
      const html = renderToString(
        <PrescriptionSettings
          go={() => {}}
          bannerVisible={true}
          onBannerVisibleChange={() => {}}
          bannerImage={null}
          onBannerImageChange={() => {}}
          signatureImage={null}
          onSignatureImageChange={() => {}}
          showClinicLogo={true}
          onShowClinicLogoChange={() => {}}
          showClinicEmail={true}
          onShowClinicEmailChange={() => {}}
          showAllergyWarning={true}
          onShowAllergyWarningChange={() => {}}
          topSpacingMm={15}
          onTopSpacingMmChange={() => {}}
        />,
      )

      expect(html).toContain("Top page spacing")
      expect(html).toMatch(/15<!-- -->\s*mm/)
      expect(html).toContain("Reset to default")
      expect(html).toContain('aria-label="Prescription top page spacing in millimeters"')
      expect(html).toContain('value="15"')
    })

    it("renders top spacing slider with Reset to Default in BillLayoutSettings", () => {
      const html = renderToString(
        <BillLayoutSettings
          go={() => {}}
          layout={{
            ...defaultBillLayoutPreferences,
            topSpacingMm: 20,
          }}
          onChange={() => {}}
          bannerImage={null}
          signatureImage={null}
        />,
      )

      expect(html).toContain("Top page spacing")
      expect(html).toMatch(/20<!-- -->\s*mm/)
      expect(html).toContain("Reset to default")
      expect(html).toContain('aria-label="Bill top page spacing in millimeters"')
      expect(html).toContain('value="20"')
    })
  })

  describe("Issue 15: Delete Formulation & Clinical Library Values", () => {
    it("renders a remove (×) button for each clinical library option", () => {
      const testLibrary: ClinicalLibrary = {
        ...defaultClinicalLibrary,
        Formulations: ["Tablet", "Capsule", "Syrup"],
      }

      const html = renderToString(
        <ClinicalLibrarySettings
          library={testLibrary}
          onAdd={() => {}}
          onRemove={() => {}}
          onAddMedicine={() => {}}
          initialTab="options"
        />,
      )

      expect(html).toContain("Tablet")
      expect(html).toContain('aria-label="Remove Tablet"')
      expect(html).toContain('title="Remove Tablet"')
      expect(html).toContain("library-chip-remove")
    })

    it("permanently persists deletion across restarts without re-adding default values", () => {
      // Simulate doctor deleting "Tablet" from Formulations
      const customFormulations = defaultClinicalLibrary.Formulations.filter(
        (f) => f !== "Tablet",
      )
      const savedLibrary: ClinicalLibrary = {
        ...defaultClinicalLibrary,
        Formulations: customFormulations,
      }

      mockStorage["cliniqo-clinical-library"] = JSON.stringify(savedLibrary)

      // When the app restarts and calls loadClinicalLibrary()
      const loaded = loadClinicalLibrary()

      // "Tablet" MUST NOT be in Formulations!
      expect(loaded.Formulations).not.toContain("Tablet")
      expect(loaded.Formulations).toContain("Capsule")
      expect(loaded.Formulations).toContain("Syrup")
    })
  })

  describe("Issue 16: Dark Mode Document Preview Isolation", () => {
    it("renders prescription-paper with clean markup and Rx symbol in dark mode wrapper", () => {
      const html = renderToString(
        <div className="dark">
          <PrescriptionPreview
            go={() => {}}
            patient={mockPatient}
            vitals={mockVitals}
            data={mockConsultationData}
            bannerVisible={true}
            bannerImage={null}
            signatureImage={null}
            showClinicLogo={true}
            showClinicEmail={true}
            showAllergyWarning={true}
            returnPage="consultation"
          />
        </div>,
      )

      expect(html).toContain("prescription-paper")
      expect(html).toContain("6D BODYPROOF")
      expect(html).toContain("5 mg")
      expect(html).toContain("℞")
      expect(html).toContain("rx-symbol")
    })

    it("renders bill-paper in dark mode with white background, dark readable text and flat document structure", () => {
      const html = renderToString(
        <div className="dark">
          <BillPreview
            go={() => {}}
            patient={mockPatient}
            bill={{
              ...mockBillData,
              notes: "Sample preview invoice. Thank you for your consultation!",
            }}
            bannerImage={null}
            signatureImage={null}
            layout={defaultBillLayoutPreferences}
            returnPage="settings"
          />
        </div>,
      )

      // Outer bill paper
      expect(html).toContain("prescription-paper bill-paper")
      expect(html).toContain("bill-document")

      // Headers and titles
      expect(html).toContain("Patient bill")
      expect(html).toContain("Tax invoice")

      // Patient details and invoice metadata
      expect(html).toContain("Vikram Mehta")
      expect(html).toContain("INV-2026-001")
      expect(html).toContain("Billed to")

      // Table headers and items
      expect(html).toContain("Service or item")
      expect(html).toContain("Qty")
      expect(html).toContain("Rate")
      expect(html).toContain("Amount")
      expect(html).toContain("Consultation Fee")
      expect(html).toContain("500.00")

      // Totals
      expect(html).toContain("Subtotal")
      expect(html).toContain("Total amount")

      // Remarks & Payment status
      expect(html).toContain("bill-remarks")
      expect(html).toContain("Sample preview invoice")
      expect(html).toContain("Payment status:")
      expect(html).toContain("Unpaid")
      expect(html).toContain("bill-payment-note")
    })
  })

  describe("Issue 13 & 14: Typography (+20%) and Contrast in Stylesheet", () => {
    it("verifies index.css contains 20% increased font sizes and high-contrast dark text colors", () => {
      const cssPath = path.resolve(__dirname, "./index.css")
      const cssContent = fs.readFileSync(cssPath, "utf-8")

      // Header sizes (18px for clinic name, 17px for doctor name, 12px details)
      expect(cssContent).toMatch(/\.rx-clinic h2[\s\S]*?font-size:\s*18px\s*!important/)
      expect(cssContent).toMatch(/\.rx-clinic p[\s\S]*?font-size:\s*12px\s*!important/)
      expect(cssContent).toMatch(/\.rx-doctor strong[\s\S]*?font-size:\s*17px\s*!important/)
      expect(cssContent).toMatch(/\.rx-doctor span[\s\S]*?font-size:\s*12px\s*!important/)

      // Labels and section headers (10px uppercase bold, was 8.25px)
      expect(cssContent).toMatch(/\.rx-patient span[\s\S]*?font-size:\s*10px\s*!important/)
      expect(cssContent).toMatch(/\.rx-medicines th[\s\S]*?font-size:\s*10px\s*!important/)

      // Values and medicine rows (13.2px, was 11px)
      expect(cssContent).toMatch(/\.rx-patient strong[\s\S]*?font-size:\s*13\.2px\s*!important/)
      expect(cssContent).toMatch(/\.rx-medicines td[\s\S]*?font-size:\s*13\.2px\s*!important/)
      expect(cssContent).toMatch(/\.rx-med-name[\s\S]*?font-size:\s*13\.2px\s*!important/)
      expect(cssContent).toMatch(/\.rx-med-strength[\s\S]*?font-size:\s*10px\s*!important/)

      // ℞ symbol (26px, was 22px)
      expect(cssContent).toMatch(/\.rx-symbol[\s\S]*?font-size:\s*26px/)

      // High-contrast text colors (no faint #64748b on labels or text)
      expect(cssContent).toMatch(/\.rx-clinic p[\s\S]*?color:\s*#1e293b/)
      expect(cssContent).toMatch(/\.rx-patient span[\s\S]*?color:\s*#334155/)
      expect(cssContent).toMatch(/\.rx-med-strength[\s\S]*?color:\s*#334155/)

      // Dark mode document isolation rules
      expect(cssContent).toMatch(/\.dark\s+\.prescription-paper,\s*\.dark\s+\.bill-paper/)
      expect(cssContent).toContain(".dark .bill-document")
      expect(cssContent).toMatch(/\.dark\s+\.bill-document[\s\S]*?box-shadow:\s*none\s*!important/)
      expect(cssContent).toContain("color-scheme: light !important;")

      // Top spacing CSS variable in print
      expect(cssContent).toMatch(/padding-top:\s*var\(--rx-top-spacing,\s*0mm\)\s*!important/)
      expect(cssContent).toMatch(/padding-top:\s*var\(--bill-top-spacing,\s*0mm\)\s*!important/)
    })
  })
})
