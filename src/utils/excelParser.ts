/**
 * Pure TypeScript Excel (XLSX, XLS) and CSV/TSV Parser & Clinical Validator
 * Designed for offline desktop reliability with zero external runtime dependencies.
 */

import type { ClinicalImportItemInput } from "../desktop/desktop-bridge"

export type ClinicalFieldKey =
  | "name"
  | "genericName"
  | "brandName"
  | "composition"
  | "strength"
  | "formulation"
  | "dosageForm"
  | "route"
  | "manufacturer"
  | "category"
  | "packSize"
  | "mrp"
  | "storageInstructions"
  | "defaultInstructions"

export interface ColumnMapping {
  name: number | null
  genericName: number | null
  brandName: number | null
  composition: number | null
  strength: number | null
  formulation: number | null
  dosageForm: number | null
  route: number | null
  manufacturer: number | null
  category: number | null
  packSize: number | null
  mrp: number | null
  storageInstructions: number | null
  defaultInstructions: number | null
}

export interface ParsedSpreadsheet {
  fileName: string
  grid: string[][]
  detectedHeaderRow: number
  headers: string[]
  suggestedMapping: ColumnMapping
}

export interface ValidationDuplicate {
  row: number
  item: ClinicalImportItemInput
  reason: string
}

export interface ValidationError {
  row: number
  error: string
  rawRow: string[]
}

export interface ValidationResult {
  totalRows: number
  validRows: number
  duplicateRows: number
  invalidRows: number
  readyToImport: ClinicalImportItemInput[]
  duplicates: ValidationDuplicate[]
  errors: ValidationError[]
}

// Formulation normalization map
const FORMULATION_SYNONYMS: Record<string, string> = {
  tab: "Tablet",
  tabs: "Tablet",
  tablet: "Tablet",
  tablets: "Tablet",
  cap: "Capsule",
  caps: "Capsule",
  capsule: "Capsule",
  capsules: "Capsule",
  syr: "Syrup",
  syp: "Syrup",
  syrup: "Syrup",
  susp: "Suspension",
  suspension: "Suspension",
  inj: "Injection",
  injection: "Injection",
  drp: "Drops",
  drps: "Drops",
  drop: "Drops",
  drops: "Drops",
  oint: "Ointment",
  ointment: "Ointment",
  crm: "Cream",
  cream: "Cream",
  gel: "Gel",
  inh: "Inhaler",
  inhaler: "Inhaler",
  lot: "Lotion",
  lotion: "Lotion",
  sol: "Solution",
  solution: "Solution",
  pwd: "Powder",
  powder: "Powder",
  resp: "Respule",
  respule: "Respule",
  respules: "Respule",
  gargle: "Gargle",
  mouthwash: "Mouthwash",
  spray: "Nasal Spray",
}

/**
 * Normalizes formulation strings into canonical clinical formulations.
 */
export function normalizeFormulation(raw: string, medicineName = ""): string {
  const clean = raw.trim().toLowerCase()
  if (FORMULATION_SYNONYMS[clean]) {
    return FORMULATION_SYNONYMS[clean]
  }

  // If formulation column was empty or generic, check words in medicine name
  const nameLower = medicineName.toLowerCase()
  for (const [key, canonical] of Object.entries(FORMULATION_SYNONYMS)) {
    const wordPattern = new RegExp(`\\b${key}\\b`, "i")
    if (wordPattern.test(nameLower)) {
      return canonical
    }
  }

  // Capitalize first letter if unrecognized
  if (raw.trim()) {
    return raw.trim().charAt(0).toUpperCase() + raw.trim().slice(1).toLowerCase()
  }

  return "Tablet"
}

/**
 * Normalizes and extracts strength strings (e.g. "500mg" -> "500 mg").
 */
export function normalizeStrength(raw: string, medicineName = ""): string {
  let s = raw.trim()
  if (!s && medicineName) {
    // Attempt extracting strength pattern from medicine name (e.g. 500mg, 10 mg, 0.5 mcg, 250 mg/5ml)
    const match = medicineName.match(
      /\b(\d+(?:\.\d+)?\s*(?:mg|g|mcg|ml|iu|%|v\/v|w\/v|w\/w)(?:\s*\/\s*\d*(?:\.\d+)?\s*(?:mg|g|mcg|ml))?)\b/i
    )
    if (match) {
      s = match[1]
    }
  }

  if (!s) return ""

  // Format spacing between number and unit: "500mg" -> "500 mg"
  return s
    .replace(/(\d+)\s*([a-zA-Z%]+)/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Parses numeric MRP safely from strings with currency symbols or commas.
 */
export function parseMrp(raw: string | undefined): number | null {
  if (!raw || !raw.trim()) return null
  const cleaned = raw
    .replace(/[₹$€£\s]|INR|Rs\.?/gi, "")
    .replace(/,/g, "")
    .trim()
  const num = parseFloat(cleaned)
  if (isNaN(num)) return null
  return num
}

/**
 * Parses an XLSX file from raw ArrayBuffer using DecompressionStream and XML parser.
 */
export async function parseXlsxBuffer(buffer: ArrayBuffer): Promise<string[][]> {
  const uint8 = new Uint8Array(buffer)
  const files: Record<string, string> = {}

  let pos = 0
  while (pos < uint8.length - 4) {
    // Check ZIP local file header signature: 0x04034b50
    if (
      uint8[pos] === 0x50 &&
      uint8[pos + 1] === 0x4b &&
      uint8[pos + 2] === 0x03 &&
      uint8[pos + 3] === 0x04
    ) {
      const view = new DataView(uint8.buffer, uint8.byteOffset + pos)
      const compression = view.getUint16(8, true)
      const compSize = view.getUint32(18, true)
      const fnLen = view.getUint16(26, true)
      const extraLen = view.getUint16(28, true)

      const fn = new TextDecoder().decode(uint8.subarray(pos + 30, pos + 30 + fnLen))
      const dataOffset = pos + 30 + fnLen + extraLen
      const compData = uint8.subarray(dataOffset, dataOffset + compSize)

      let rawData: Uint8Array | null = null
      if (compression === 0) {
        rawData = compData
      } else if (compression === 8) {
        try {
          const ds = new DecompressionStream("deflate-raw")
          const writer = ds.writable.getWriter()
          writer.write(compData)
          writer.close()
          const reader = ds.readable.getReader()
          const chunks: Uint8Array[] = []
          let done = false
          let value: Uint8Array | undefined
          while (!done) {
            const res = await reader.read()
            done = res.done
            value = res.value
            if (value) chunks.push(value)
          }
          const total = chunks.reduce((acc, c) => acc + c.length, 0)
          rawData = new Uint8Array(total)
          let off = 0
          for (const c of chunks) {
            rawData.set(c, off)
            off += c.length
          }
        } catch (err) {
          console.warn("Failed decompressing zip entry:", fn, err)
        }
      }

      if (rawData) {
        files[fn] = new TextDecoder().decode(rawData)
      }
      pos = dataOffset + compSize
    } else {
      pos++
    }
  }

  // 1. Extract shared strings if present
  const sharedStrings: string[] = []
  if (files["xl/sharedStrings.xml"]) {
    const sstXml = files["xl/sharedStrings.xml"]
    const siMatches = sstXml.match(/<si>(.*?)<\/si>/gs) || []
    for (const si of siMatches) {
      // Collect all text tags inside this string item
      const tMatches = si.match(/<t[^>]*>(.*?)<\/t>/gs) || []
      const text = tMatches
        .map((t) => t.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"'))
        .join("")
      sharedStrings.push(text)
    }
  }

  // 2. Locate active sheet (default sheet1.xml)
  const sheetKey = Object.keys(files).find((k) => k.startsWith("xl/worksheets/sheet") && k.endsWith(".xml")) || "xl/worksheets/sheet1.xml"
  const sheetXml = files[sheetKey]
  if (!sheetXml) {
    throw new Error("No worksheet found in XLSX archive")
  }

  // 3. Parse row and cell data
  const grid: string[][] = []
  const rowMatches = sheetXml.match(/<row[^>]*>(.*?)<\/row>/gs) || []

  for (const rowXml of rowMatches) {
    const cells: { col: number; val: string }[] = []
    const cellMatches = rowXml.match(/<c[^>]*>(.*?)<\/c>/gs) || []

    for (const cXml of cellMatches) {
      // Cell coordinate, e.g. r="A1" or r="BC4"
      const rMatch = cXml.match(/r="([A-Z]+)\d+"/i)
      const colLetters = rMatch ? rMatch[1].toUpperCase() : ""
      let colIdx = 0
      for (let i = 0; i < colLetters.length; i++) {
        colIdx = colIdx * 26 + (colLetters.charCodeAt(i) - 64)
      }
      colIdx = Math.max(0, colIdx - 1)

      const isSharedString = /t="s"/i.test(cXml)
      const isInlineString = /t="inlineStr"/i.test(cXml)

      let val = ""
      if (isSharedString) {
        const vMatch = cXml.match(/<v>(\d+)<\/v>/)
        if (vMatch) {
          const sIdx = parseInt(vMatch[1], 10)
          val = sharedStrings[sIdx] || ""
        }
      } else if (isInlineString) {
        const tMatch = cXml.match(/<t[^>]*>(.*?)<\/t>/s)
        if (tMatch) {
          val = tMatch[1]
        }
      } else {
        const vMatch = cXml.match(/<v>(.*?)<\/v>/s)
        if (vMatch) {
          val = vMatch[1]
        }
      }

      val = val
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#8377;/g, "₹")
        .trim()

      cells.push({ col: colIdx, val })
    }

    if (cells.length > 0) {
      const maxCol = Math.max(...cells.map((c) => c.col))
      const rowArr = new Array(maxCol + 1).fill("")
      for (const c of cells) {
        rowArr[c.col] = c.val
      }
      grid.push(rowArr)
    }
  }

  return grid
}

/**
 * Parses CSV/TSV text into 2D string array.
 */
export function parseCsvText(text: string): string[][] {
  const lines = text.split(/\r?\n/)
  const grid: string[][] = []

  // Detect delimiter from first non-empty line
  const sample = lines.find((l) => l.trim().length > 0) || ""
  let delimiter = ","
  if ((sample.match(/\t/g) || []).length > (sample.match(/,/g) || []).length) {
    delimiter = "\t"
  } else if ((sample.match(/;/g) || []).length > (sample.match(/,/g) || []).length) {
    delimiter = ";"
  }

  for (const line of lines) {
    if (!line.trim()) continue
    const row: string[] = []
    let inQuotes = false
    let currentCell = ""

    for (let i = 0; i < line.length; i++) {
      const char = line[i]
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          currentCell += '"'
          i++
        } else {
          inQuotes = !inQuotes
        }
      } else if (char === delimiter && !inQuotes) {
        row.push(currentCell.trim())
        currentCell = ""
      } else {
        currentCell += char
      }
    }
    row.push(currentCell.trim())
    grid.push(row)
  }

  return grid
}

/**
 * Intelligent Header Detection
 * Scans first 10 rows to detect true table header row by matching domain keywords.
 */
export function detectHeaderRow(grid: string[][]): {
  headerRowIndex: number
  headers: string[]
} {
  const keywords = [
    "medicine",
    "product",
    "item",
    "drug",
    "brand",
    "generic",
    "composition",
    "salt",
    "strength",
    "formulation",
    "form",
    "dosage",
    "unit",
    "qty",
    "quantity",
    "mrp",
    "rate",
    "price",
    "company",
    "manufacturer",
    "pack",
  ]

  let bestIndex = 0
  let bestScore = -1

  const checkCount = Math.min(grid.length, 12)
  for (let i = 0; i < checkCount; i++) {
    const row = grid[i]
    let score = 0
    for (const cell of row) {
      const c = cell.toLowerCase().trim()
      if (keywords.some((kw) => c.includes(kw))) {
        score++
      }
    }
    if (score > bestScore) {
      bestScore = score
      bestIndex = i
    }
  }

  const headerRowIndex = bestScore >= 2 ? bestIndex : 0
  const headers = (grid[headerRowIndex] || []).map((h, i) => h.trim() || `Column ${i + 1}`)

  return { headerRowIndex, headers }
}

/**
 * Intelligent Column Mapper
 * Scores headers against canonical fields to recommend column assignments.
 */
export function autoMapColumns(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {
    name: null,
    genericName: null,
    brandName: null,
    composition: null,
    strength: null,
    formulation: null,
    dosageForm: null,
    route: null,
    manufacturer: null,
    category: null,
    packSize: null,
    mrp: null,
    storageInstructions: null,
    defaultInstructions: null,
  }

  const cleanHeaders = headers.map((h) => h.toLowerCase().trim())

  const patterns: Record<ClinicalFieldKey, RegExp[]> = {
    name: [
      /^(?:medicine|product|drug|item)\s*(?:name)?$/i,
      /product\s*name/i,
      /medicine\s*name/i,
      /drug\s*name/i,
      /item\s*name/i,
      /^name$/i,
      /brand\s*name/i,
    ],
    genericName: [
      /generic\s*name/i,
      /^generic$/i,
      /active\s*ingredient/i,
      /^salt(?:\s*name)?$/i,
      /^molecule$/i,
    ],
    brandName: [/^brand(?:\s*name)?$/i, /^trade\s*name$/i],
    composition: [/composition/i, /contents/i, /ingredients/i, /formula/i],
    strength: [/strength/i, /potency/i, /^power$/i, /^dose$/i, /^str$/i],
    formulation: [/formulation/i, /^dosage\s*form$/i, /^form$/i, /^type$/i, /^unit$/i],
    dosageForm: [/dosage\s*form/i, /presentation/i],
    route: [/^route(?:\s*of\s*admin(?:istration)?)?$/i],
    manufacturer: [/manufacturer/i, /^company$/i, /mfg(?:\s*by)?/i, /mkt(?:\s*by)?/i, /pharma/i],
    category: [/category/i, /schedule/i, /therapeutic/i, /drug\s*class/i, /^class$/i],
    packSize: [/pack\s*size/i, /^pack$/i, /packaging/i, /^pkg$/i],
    mrp: [
      /m\.?r\.?p/i,
      /^price$/i,
      /^rate$/i,
      /^cost$/i,
      /^value/i,
      /retail\s*price/i,
      /selling\s*price/i,
    ],
    storageInstructions: [/storage/i, /temperature/i],
    defaultInstructions: [/instructions/i, /directions/i, /usage/i, /remarks/i, /^notes$/i],
  }

  const assignedCols = new Set<number>()

  for (const [key, regexList] of Object.entries(patterns) as [ClinicalFieldKey, RegExp[]][]) {
    for (const regex of regexList) {
      const idx = cleanHeaders.findIndex((h, i) => !assignedCols.has(i) && regex.test(h))
      if (idx !== -1) {
        mapping[key] = idx
        assignedCols.add(idx)
        break
      }
    }
  }

  // Fallback for name: if name not found, take first column with values
  if (mapping.name === null && headers.length > 0) {
    mapping.name = 0
  }

  return mapping
}

/**
 * Parses an entire spreadsheet file (XLSX, XLS, CSV).
 */
export async function parseSpreadsheetFile(
  file: File | ArrayBuffer,
  fileName: string
): Promise<ParsedSpreadsheet> {
  let grid: string[][] = []
  const isXlsx = /\.xlsx$/i.test(fileName)
  const isCsv = /\.(?:csv|tsv|txt)$/i.test(fileName)

  if (file instanceof File) {
    if (isXlsx) {
      const buffer = await file.arrayBuffer()
      grid = await parseXlsxBuffer(buffer)
    } else if (isCsv) {
      const text = await file.text()
      grid = parseCsvText(text)
    } else {
      // Legacy .xls: test if HTML/XML or fallback text
      const text = await file.text()
      if (text.includes("<table") || text.includes("<Workbook")) {
        grid = parseXmlSpreadsheet(text)
      } else {
        grid = parseCsvText(text)
      }
    }
  } else {
    // ArrayBuffer passed directly
    if (isXlsx) {
      grid = await parseXlsxBuffer(file)
    } else {
      const text = new TextDecoder().decode(file)
      grid = parseCsvText(text)
    }
  }

  const { headerRowIndex, headers } = detectHeaderRow(grid)
  const suggestedMapping = autoMapColumns(headers)

  return {
    fileName,
    grid,
    detectedHeaderRow: headerRowIndex,
    headers,
    suggestedMapping,
  }
}

/**
 * Parses XML/HTML spreadsheet format (frequently saved with .xls extension).
 */
function parseXmlSpreadsheet(content: string): string[][] {
  const grid: string[][] = []
  const rowMatches = content.match(/<tr[^>]*>(.*?)<\/tr>/gis) || content.match(/<Row[^>]*>(.*?)<\/Row>/gis) || []

  for (const rXml of rowMatches) {
    const cells: string[] = []
    const cellMatches =
      rXml.match(/<t[dh][^>]*>(.*?)<\/t[dh]>/gis) || rXml.match(/<Cell[^>]*>(.*?)<\/Cell>/gis) || []
    for (const cXml of cellMatches) {
      const text = cXml.replace(/<[^>]+>/g, "").trim()
      cells.push(text)
    }
    if (cells.length > 0) {
      grid.push(cells)
    }
  }

  return grid
}

/**
 * Validates and normalizes records extracted via column mapping.
 * Performs duplicate detection against batch and against existing clinic library.
 */
export function validateAndNormalizeRecords(
  grid: string[][],
  headerRowIndex: number,
  mapping: ColumnMapping,
  existingMedicines: { name: string; formulation: string; strength: string }[] = []
): ValidationResult {
  const readyToImport: ClinicalImportItemInput[] = []
  const duplicates: ValidationDuplicate[] = []
  const errors: ValidationError[] = []

  // Pre-populate deduplication set with existing clinic medicines
  const existingKeySet = new Set<string>()
  for (const m of existingMedicines) {
    const key = `${m.name.toLowerCase().trim()}::${m.formulation.toLowerCase().trim()}::${(m.strength || "").toLowerCase().trim()}`
    existingKeySet.add(key)
  }

  const inBatchKeySet = new Set<string>()

  const getCell = (row: string[], colIdx: number | null): string => {
    if (colIdx === null || colIdx === undefined || colIdx < 0 || colIdx >= row.length) {
      return ""
    }
    return (row[colIdx] || "").trim()
  }

  const dataRows = grid.slice(headerRowIndex + 1)
  let totalRows = 0

  for (let idx = 0; idx < dataRows.length; idx++) {
    const row = dataRows[idx]
    const rowNumber = headerRowIndex + 2 + idx

    // Skip entirely blank rows
    if (row.every((cell) => !cell || !cell.trim())) {
      continue
    }

    totalRows++

    const rawName = getCell(row, mapping.name)
    if (!rawName) {
      errors.push({
        row: rowNumber,
        error: "Missing required medicine name",
        rawRow: row,
      })
      continue
    }

    const rawForm = getCell(row, mapping.formulation)
    const rawStrength = getCell(row, mapping.strength)
    const formulation = normalizeFormulation(rawForm, rawName)
    const strength = normalizeStrength(rawStrength, rawName)

    const rawMrp = getCell(row, mapping.mrp)
    const mrp = parseMrp(rawMrp)

    if (mrp !== null && mrp < 0) {
      errors.push({
        row: rowNumber,
        error: `Negative MRP amount: ₹${mrp}`,
        rawRow: row,
      })
      continue
    }

    const item: ClinicalImportItemInput = {
      name: rawName,
      generic_name: getCell(row, mapping.genericName) || undefined,
      brand_name: getCell(row, mapping.brandName) || undefined,
      composition: getCell(row, mapping.composition) || undefined,
      strength,
      formulation,
      dosage_form: getCell(row, mapping.dosageForm) || formulation,
      route: getCell(row, mapping.route) || undefined,
      manufacturer: getCell(row, mapping.manufacturer) || undefined,
      category: getCell(row, mapping.category) || undefined,
      pack_size: getCell(row, mapping.packSize) || undefined,
      mrp: mrp !== null ? mrp : undefined,
      storage_instructions: getCell(row, mapping.storageInstructions) || undefined,
      default_instructions: getCell(row, mapping.defaultInstructions) || undefined,
      default_dosage: undefined,
      default_frequency: undefined,
      default_duration: undefined,
    }

    const dedupeKey = `${item.name.toLowerCase().trim()}::${item.formulation.toLowerCase().trim()}::${item.strength.toLowerCase().trim()}`

    // Check duplicate within the same batch
    if (inBatchKeySet.has(dedupeKey)) {
      duplicates.push({
        row: rowNumber,
        item,
        reason: `Duplicate of earlier record in file ("${item.name}", ${item.formulation} ${item.strength})`,
      })
      continue
    }

    // Check duplicate against existing clinic library
    if (existingKeySet.has(dedupeKey)) {
      duplicates.push({
        row: rowNumber,
        item,
        reason: `Already exists in Clinic Library ("${item.name}", ${item.formulation} ${item.strength})`,
      })
      continue
    }

    inBatchKeySet.add(dedupeKey)
    readyToImport.push(item)
  }

  return {
    totalRows,
    validRows: readyToImport.length,
    duplicateRows: duplicates.length,
    invalidRows: errors.length,
    readyToImport,
    duplicates,
    errors,
  }
}
