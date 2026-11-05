import { describe, it, expect } from "vitest"
import {
  normalizeFormulation,
  normalizeStrength,
  parseMrp,
  parseCsvText,
  detectHeaderRow,
  autoMapColumns,
  validateAndNormalizeRecords,
  parseSpreadsheetFile,
} from "./excelParser"
import * as fs from "node:fs"
import * as path from "node:path"

describe("excelParser Unit Tests", () => {
  it("normalizes formulation synonyms and abbreviations correctly", () => {
    expect(normalizeFormulation("tab")).toBe("Tablet")
    expect(normalizeFormulation("TABLETS")).toBe("Tablet")
    expect(normalizeFormulation("cap")).toBe("Capsule")
    expect(normalizeFormulation("syp")).toBe("Syrup")
    expect(normalizeFormulation("inj")).toBe("Injection")
    expect(normalizeFormulation("drp")).toBe("Drops")
    expect(normalizeFormulation("oint")).toBe("Ointment")
    expect(normalizeFormulation("", "Paracetamol Tablet 500mg")).toBe("Tablet")
    expect(normalizeFormulation("", "Cough Syrup 100ml")).toBe("Syrup")
  })

  it("normalizes and extracts strength strings with canonical units", () => {
    expect(normalizeStrength("500mg")).toBe("500 mg")
    expect(normalizeStrength("0.5mcg")).toBe("0.5 mcg")
    expect(normalizeStrength("1g")).toBe("1 g")
    expect(normalizeStrength("", "Augmentin 625 mg")).toBe("625 mg")
    expect(normalizeStrength("", "Paracetamol 650mg Tablet")).toBe("650 mg")
  })

  it("parses MRP strings and strips currency symbols", () => {
    expect(parseMrp("₹120.50")).toBe(120.50)
    expect(parseMrp("Rs. 45")).toBe(45)
    expect(parseMrp("1,250.00")).toBe(1250)
    expect(parseMrp("")).toBeNull()
  })

  it("parses CSV lines respecting quotes and delimiters", () => {
    const csv = `Product Name,Unit,Price\n"Amox, Clav",TAB,150.00\nPan D,CAP,120`
    const grid = parseCsvText(csv)
    expect(grid.length).toBe(3)
    expect(grid[1][0]).toBe("Amox, Clav")
    expect(grid[1][1]).toBe("TAB")
    expect(grid[1][2]).toBe("150.00")
  })

  it("detects table header row among preamble metadata rows", () => {
    const grid = [
      ["MEDIVISION PHARMA"],
      ["Stock report as of today"],
      ["Medicine Name", "Generic Name", "Formulation", "Strength", "MRP"],
      ["Paracetamol", "Paracetamol", "Tablet", "500 mg", "30.00"],
    ]
    const detected = detectHeaderRow(grid)
    expect(detected.headerRowIndex).toBe(2)
    expect(detected.headers).toEqual(["Medicine Name", "Generic Name", "Formulation", "Strength", "MRP"])
  })

  it("auto-maps column headers to clinical field keys", () => {
    const headers = ["Drug Name", "Active Ingredient", "Form", "Power", "Company", "M.R.P"]
    const mapping = autoMapColumns(headers)
    expect(mapping.name).toBe(0)
    expect(mapping.genericName).toBe(1)
    expect(mapping.formulation).toBe(2)
    expect(mapping.strength).toBe(3)
    expect(mapping.manufacturer).toBe(4)
    expect(mapping.mrp).toBe(5)
  })

  it("validates and normalizes records, flagging duplicates and invalid entries", () => {
    const grid = [
      ["Medicine Name", "Formulation", "Strength", "MRP"],
      ["Augmentin", "tab", "625mg", "₹210.00"], // valid 1
      ["", "tab", "500mg", "₹100"], // missing name -> error
      ["Augmentin", "tab", "625mg", "₹210.00"], // duplicate within file
      ["Pan D", "cap", "40mg", "-50"], // negative MRP -> error
      ["Paracetamol", "Tablet", "500 mg", "30"], // duplicate with existing
    ]
    const mapping = {
      name: 0,
      genericName: null,
      brandName: null,
      composition: null,
      strength: 2,
      formulation: 1,
      dosageForm: null,
      route: null,
      manufacturer: null,
      category: null,
      packSize: null,
      mrp: 3,
      storageInstructions: null,
      defaultInstructions: null,
    }
    const existing = [{ name: "Paracetamol", formulation: "Tablet", strength: "500 mg" }]
    const result = validateAndNormalizeRecords(grid, 0, mapping, existing)

    expect(result.validRows).toBe(1)
    expect(result.readyToImport[0].name).toBe("Augmentin")
    expect(result.readyToImport[0].formulation).toBe("Tablet")
    expect(result.readyToImport[0].strength).toBe("625 mg")
    expect(result.readyToImport[0].mrp).toBe(210)

    expect(result.duplicateRows).toBe(2)
    expect(result.invalidRows).toBe(2)
  })

  it("parses real XLSX file from disk using standard decompressor", async () => {
    const xlsxPath = "/Users/dipeshpatekar/.gemini/antigravity/brain/4b5c37bc-2847-4264-ad9d-17917f943ec6/.user_uploaded/media_1793817185895_a6dd45f6.xlsx"
    if (fs.existsSync(xlsxPath)) {
      const buffer = fs.readFileSync(xlsxPath).buffer
      const parsed = await parseSpreadsheetFile(buffer, "Stock_Report_Converted.xlsx")
      expect(parsed.grid.length).toBeGreaterThan(100)
      expect(parsed.detectedHeaderRow).toBeGreaterThanOrEqual(0)
      expect(parsed.headers.some((h) => /product|name|unit|company/i.test(h))).toBe(true)
    }
  })
})

