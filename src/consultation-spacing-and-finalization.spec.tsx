import { describe, it, expect, vi, beforeEach } from "vitest"
import React from "react"
import { renderToString } from "react-dom/server"
import fs from "node:fs"
import path from "node:path"
import {
  validateMedicineFormulation,
  isMedicineEmpty,
} from "./utils/billing"
import {
  normalizeMedicineList,
  emptyMedicine,
  createEmptyConsultationData,
} from "./types"
import type { Patient, Vitals, ConsultationData, Medicine } from "./types"
import * as desktopBridge from "./desktop/desktop-bridge"
import type { LocalPrescriptionRecord, LocalConsultationRecord } from "./desktop/desktop-bridge"

describe("Cliniqo — UI Spacing & Prescription Finalization Fixes", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  describe("1. Consultation UI — Correct Section Heading Spacing & Restored Field Spacing", () => {
    it("verifies original field gap is restored and section heading spacing is reduced by ~30%", () => {
      const cssContent = fs.readFileSync(
        path.resolve(process.cwd(), "src/index.css"),
        "utf-8",
      )

      // Standard field gap restored to original 7px
      expect(cssContent).toMatch(/\.field\s*\{[^}]*gap:\s*7px/)

      // Compact vitals field gap restored to original 6px
      expect(cssContent).toMatch(/\.compact-field\s*\{[^}]*gap:\s*6px/)

      // Section heading-to-content spacing reduced by ~30% plus additional 20% (to 9.6px)
      expect(cssContent).toMatch(
        /\.consultation-shell\s+\.form-section-head,\s*\.consultation-main\s+\.form-section-head\s*\{[^}]*padding-bottom:\s*9\.6px;[^}]*margin-bottom:\s*9\.6px;/,
      )

      // No artificial label line-height overrides in consultation
      expect(cssContent).not.toMatch(/\.consultation-shell\s+\.field-label/)
    })
  })

  describe("2. Validation Rules & Non-Silent Feedback", () => {
    it("isMedicineEmpty accurately identifies completely empty placeholder medicines", () => {
      expect(isMedicineEmpty(emptyMedicine(1))).toBe(true)
      expect(isMedicineEmpty(null)).toBe(true)
      expect(isMedicineEmpty(undefined)).toBe(true)
      expect(
        isMedicineEmpty({
          id: 1,
          name: "",
          formulation: "",
          dose: "",
          frequency: "",
          duration: "",
        }),
      ).toBe(true)

      // Any entered field makes it non-empty
      expect(
        isMedicineEmpty({
          id: 1,
          name: "Paracetamol",
          formulation: "",
        }),
      ).toBe(false)
      expect(
        isMedicineEmpty({
          id: 1,
          name: "",
          formulation: "Tablet",
        }),
      ).toBe(false)
    })

    it("validateMedicineFormulation safely handles numeric dose, null fields, and returns explicit errors", () => {
      // Missing formulation
      const res1 = validateMedicineFormulation({ name: "Paracetamol" })
      expect(res1.valid).toBe(false)
      expect(res1.error).toBe("Formulation is required")

      // Missing medicine name
      const res2 = validateMedicineFormulation({ formulation: "Tablet" })
      expect(res2.valid).toBe(false)
      expect(res2.error).toBe("Medicine name is required")

      // Injection requires route and dose
      const resInjectionNoRoute = validateMedicineFormulation({
        name: "Ceftriaxone",
        formulation: "Injection",
        dose: "1 g",
      })
      expect(resInjectionNoRoute.valid).toBe(false)
      expect(resInjectionNoRoute.error).toContain("Route")

      // Topical requires application instructions (directions), frequency, and duration
      const resTopicalNoDir = validateMedicineFormulation({
        name: "Betamethasone",
        formulation: "Cream",
        frequency: "Twice daily",
        duration: "7 days",
      })
      expect(resTopicalNoDir.valid).toBe(false)
      expect(resTopicalNoDir.error).toContain("Application instructions")

      // Valid Tablet with numeric dose safely coerced without crashing
      const resValid = validateMedicineFormulation({
        name: "Paracetamol",
        formulation: "Tablet",
        dose: 1 as any, // numeric dose
        frequency: "Three times daily",
        duration: "5 days",
      })
      expect(resValid.valid).toBe(true)
    })

    it("verifies Consultation.tsx never fails silently and shows actionable error banners", () => {
      const consultSource = fs.readFileSync(
        path.resolve(
          process.cwd(),
          "src/components/consultation/Consultation.tsx",
        ),
        "utf-8",
      )

      // Must set finalizeError with specific medication details
      expect(consultSource).toContain("Cannot finalize prescription: Please complete required medication details")
      // Must scroll to invalid element
      expect(consultSource).toContain("scrollIntoView")
      // Must prune untouched empty rows so phantom rows don't block
      expect(consultSource).toContain("isMedicineEmpty")
      // Validation warning on card does not hide when formulation is missing
      expect(consultSource).not.toMatch(/validation\.valid\s*&&\s*medicine\.formulation\s*&&/)
    })
  })

  describe("3. Consultation Restoration & Draft Scoping", () => {
    it("normalizeMedicineList normalizes legacy dosage, missing routes, and numeric durations", () => {
      const rawMedicines = [
        {
          id: 1,
          medicineName: "Amoxicillin",
          dosageForm: "CAPSULE",
          dosage: "500 mg",
          frequency: "TDS",
          duration: 7,
          foodTiming: "AFTER_FOOD",
        },
      ]

      const normalized = normalizeMedicineList(rawMedicines)
      expect(normalized).toHaveLength(1)
      expect(normalized[0].name).toBe("Amoxicillin")
      expect(normalized[0].formulation).toBe("Capsule")
      expect(normalized[0].dose).toBe("500 mg")
      expect(normalized[0].frequency).toBe("Three times daily")
      expect(normalized[0].duration).toBe("7 days")
      expect(normalized[0].food).toBe("After food")
    })

    it("verifies App.tsx resumeConsultation normalizes restored snapshot medicines and scopes localStorage draft", () => {
      const appSource = fs.readFileSync(
        path.resolve(process.cwd(), "src/App.tsx"),
        "utf-8",
      )

      // Must normalize medicines when resuming from snapshot
      expect(appSource).toMatch(
        /medicines:\s*Array\.isArray\(snap\.medicines\)\s*\?\s*normalizeMedicineList\(snap\.medicines\)\s*:\s*\[\]/,
      )

      // Must verify localStorage draft belongs to the consultation being resumed
      expect(appSource).toContain("parsed.consultationId === draftRecord.id")
    })

    it("verifies Consultation.tsx draft load verifies consultation ID match before overriding state", () => {
      const consultSource = fs.readFileSync(
        path.resolve(
          process.cwd(),
          "src/components/consultation/Consultation.tsx",
        ),
        "utf-8",
      )

      // Checks activeDraftConsultationId match before restoring
      expect(consultSource).toContain("parsed.consultationId === activeDraftConsultationId")
      // Normalizes medicines from localStorage draft
      expect(consultSource).toMatch(/normalizeMedicineList\(parsed\.data\.medicines\)/)
    })
  })

  describe("4. Keyboard Shortcut Strict Separation", () => {
    it("verifies PrescriptionPreview.tsx Ctrl+P only opens window.print and blocks Ctrl+F", () => {
      const previewSource = fs.readFileSync(
        path.resolve(
          process.cwd(),
          "src/components/consultation/PrescriptionPreview.tsx",
        ),
        "utf-8",
      )

      // Must call handlePrint which calls window.print()
      expect(previewSource).toContain("handlePrint()")
      // Must not call saveLocalConsultation or saveLocalPrescription
      expect(previewSource).not.toContain("saveLocalConsultation")
      expect(previewSource).not.toContain("saveLocalPrescription")
      // Must block Ctrl+F
      expect(previewSource).toContain('e.key.toLowerCase() === "f"')
      expect(previewSource).toContain("e.stopPropagation()")
    })

    it("verifies Consultation.tsx keyboard handlers trigger finalization on both Ctrl+P and Ctrl+F", () => {
      const consultSource = fs.readFileSync(
        path.resolve(
          process.cwd(),
          "src/components/consultation/Consultation.tsx",
        ),
        "utf-8",
      )

      // Keydown handler handles both p and f
      expect(consultSource).toMatch(
        /e\.key\.toLowerCase\(\)\s*===\s*"p"\s*\|\|\s*e\.key\.toLowerCase\(\)\s*===\s*"f"/,
      )
      // Dispatches trigger finalize ref
      expect(consultSource).toContain("handleTriggerFinalizeRef.current()")
    })
  })

  describe("5. Inter-Section Add Medicine Button", () => {
    it("verifies Consultation.tsx renders an additional Add Medicine button between Medicines and Adv sections", () => {
      const consultSource = fs.readFileSync(
        path.resolve(
          process.cwd(),
          "src/components/consultation/Consultation.tsx",
        ),
        "utf-8",
      )

      // Button wrapper between sections
      expect(consultSource).toContain("add-medicine-divider-wrap")
      expect(consultSource).toContain("consultation-add-medicine-between")

      // Appears between Medicines section close and Adv section
      const medSectionIdx = consultSource.indexOf('className="form-section medicines-section"')
      const betweenBtnIdx = consultSource.indexOf('consultation-add-medicine-between')
      const advSectionIdx = consultSource.indexOf('title="Adv."')

      expect(medSectionIdx).toBeGreaterThan(-1)
      expect(betweenBtnIdx).toBeGreaterThan(medSectionIdx)
      expect(advSectionIdx).toBeGreaterThan(betweenBtnIdx)

      // Reuses exact same addMedicine handler
      const snippet = consultSource.slice(betweenBtnIdx - 200, betweenBtnIdx + 200)
      expect(snippet).toContain("onClick={addMedicine}")
      expect(snippet).toContain('variant="secondary"')
      expect(snippet).toContain('size="sm"')
      expect(snippet).toContain("icon={Plus}")
    })
  })

  describe("6. Medicine UI Cleanup & Empty State Button Deduplication", () => {
    it("verifies empty state displays only Pill icon and 'No medicines added' without a duplicate button", () => {
      const consultSource = fs.readFileSync(
        path.resolve(
          process.cwd(),
          "src/components/consultation/Consultation.tsx",
        ),
        "utf-8",
      )

      // Find the medicine-empty block
      const emptyStart = consultSource.indexOf('className="medicine-empty')
      expect(emptyStart).toBeGreaterThan(-1)
      const emptyEnd = consultSource.indexOf("</div>", emptyStart)
      const emptyBlock = consultSource.slice(emptyStart, emptyEnd + 6)

      expect(emptyBlock).toContain("No medicines added")
      expect(emptyBlock).toContain("<Pill")
      expect(emptyBlock).not.toContain("<Button")
      expect(emptyBlock).not.toContain("Add medicine")
    })

    it("verifies informational alerts and status text are removed from medicine fields while preserving validation errors", () => {
      const consultSource = fs.readFileSync(
        path.resolve(
          process.cwd(),
          "src/components/consultation/Consultation.tsx",
        ),
        "utf-8",
      )

      // Verified Medicine, Active, Custom uncatalogued medicine, Combination must not be in UI
      expect(consultSource).not.toContain("Verified Medicine (")
      expect(consultSource).not.toContain("Active: {medicine.activeIngredient}")
      expect(consultSource).not.toContain("Custom uncatalogued medicine")
      expect(consultSource).not.toContain("verified strengths available")
      expect(consultSource).not.toContain("Auto-selected verified strength")
      expect(consultSource).not.toContain("Unit: ${doseConfig.unit}")

      // Preserves validation error display for actual submission blocks
      expect(consultSource).toContain("med-validation-warning")
      expect(consultSource).toContain("validation.error")
    })
  })

  describe("7. Medical Background Helper Text Cleanup", () => {
    it("verifies optional helper messages under Known allergies and Medical History are removed while preserving labels and placeholders", () => {
      const consultSource = fs.readFileSync(
        path.resolve(
          process.cwd(),
          "src/components/consultation/Consultation.tsx",
        ),
        "utf-8",
      )

      // Known allergies field has no hint
      expect(consultSource).not.toContain("Optional, comma-separated (e.g. Penicillin, or 'None' / 'NKDA')")
      // Medical History field has no hint
      expect(consultSource).not.toContain('hint="Optional, comma-separated"')

      // Labels and textareas are preserved
      expect(consultSource).toContain('label="Known allergies"')
      expect(consultSource).toContain('label="Medical History"')
      expect(consultSource).toContain('placeholder="e.g. Drug, food, or environmental allergies (or \'NKDA\' / \'None\')"')
      expect(consultSource).toContain('placeholder="Existing or chronic conditions"')
    })
  })

  describe("8. Consultation Date & Time UI Adjustment", () => {
    it("verifies Consultation date and time section removes field labels and keeps single-row input layout", () => {
      const consultSource = fs.readFileSync(
        path.resolve(
          process.cwd(),
          "src/components/consultation/Consultation.tsx",
        ),
        "utf-8",
      )

      // Section heading and icon preserved
      expect(consultSource).toContain("<h2>Consultation date and time</h2>")
      expect(consultSource).toContain("<CalendarDays")

      // Field labels removed (<Field label="Consultation date"> and <Field label="Consultation time">)
      expect(consultSource).not.toMatch(/<Field\s+[^>]*label="Consultation date"/)
      expect(consultSource).not.toMatch(/<Field\s+[^>]*label="Consultation time"/)

      // Direct inputs present with aria-labels and correct classes
      expect(consultSource).toContain('className="consultation-datetime-inputs')
      expect(consultSource).toContain('type="date"')
      expect(consultSource).toContain('aria-label="Consultation date"')
      expect(consultSource).toContain('type="time"')
      expect(consultSource).toContain('aria-label="Consultation time"')
      expect(consultSource).toContain("value={data.date}")
      expect(consultSource).toContain("value={data.time}")
    })

    it("verifies scoped CSS rules for consultation-datetime-section in src/index.css", () => {
      const cssSource = fs.readFileSync(
        path.resolve(process.cwd(), "src/index.css"),
        "utf-8",
      )

      expect(cssSource).toContain(".consultation-datetime-section")
      expect(cssSource).toContain(".consultation-datetime-inputs")
      expect(cssSource).toContain(".consultation-date-input")
      expect(cssSource).toContain(".consultation-time-input")
    })
  })
})
