import type { LocalPatientRecord } from "../desktop/desktop-bridge"

export type Page = "login" | "register" | "setup" | "dashboard" | "patients" | "patient-form" | "patient-profile" | "consultation" | "preview" | "bill-form" | "bill-preview" | "settings"

export type Patient = {
  id: string
  displayId?: string
  patientCode?: string
  name: string
  initials: string
  age: number
  gender: string
  phone: string
  lastVisit: string
  allergies: string[]
  conditions: string[]
  dateOfBirth?: string
  alternatePhone?: string
  address?: string
  registeredAt?: string
  syncStatus?: "PENDING" | "SYNCED" | "CONFLICT"
  updatedAt?: string
  createdAt?: string
}

export type Medicine = {
  id: number
  name: string
  formulation: string
  strength: string
  dose: string
  route: string
  frequency: string
  duration: string
  food: string
  directions: string
  activeIngredient?: string
  sourceIdentifier?: string
  sourceProvenance?: string
  isCombination?: boolean
  isStrengthVerified?: boolean
  isCustom?: boolean
  brandName?: string
  genericName?: string
  productName?: string
  releaseType?: string
  manufacturer?: string
}

export type CatalogueStrength = {
  ingredient?: string
  rawStrength: string
  value?: number
  unit?: string
}

export type CatalogueItem = {
  id: string
  sourceIdentifier: string
  type: "BRAND" | "GENERIC"
  name: string
  brandName?: string
  genericName?: string
  productName?: string
  dosageForm?: string
  route?: string
  strengths: CatalogueStrength[]
  rawStrengthSummary: string
  releaseType?: string
  manufacturer?: string
  isCombination: boolean
  isStrengthVerified: boolean
  sourceProvenance: string
  cachedAt?: string
}

export type CatalogueSearchResult = {
  items: CatalogueItem[]
  total: number
  page: number
  limit: number
  totalPages: number
  attribution: string
  isOfflineCache?: boolean
}

export type Vitals = {
  systolic: string
  diastolic: string
  heartRate: string
  spo2: string
  temperature: string
  height: string
  weight: string
}

export type ConsultationData = {
  date: string
  time: string
  chiefComplaint: string
  symptomDuration: string
  diagnosis: string
  medicines: Medicine[]
  followUpDate: string
  followUpInstructions: string
  allergies?: string[]
  conditions?: string[]
}

export type PatientFormFieldPreferences = {
  showDob: boolean
  showPhone: boolean
  showAlternatePhone: boolean
  showAddress: boolean
}

export const defaultPatientFormFieldPreferences: PatientFormFieldPreferences = {
  showDob: true,
  showPhone: true,
  showAlternatePhone: true,
  showAddress: true,
}

export const loadPatientFormFieldPreferences =
  (): PatientFormFieldPreferences => {
    try {
      const saved = JSON.parse(
        window.localStorage.getItem("cliniqo-patient-form-preferences") || "{}",
      )
      return { ...defaultPatientFormFieldPreferences, ...saved }
    } catch {
      return defaultPatientFormFieldPreferences
    }
  }

export type BillItem = {
  id: number
  description: string
  quantity: number
  rate: number
}

export type BillData = {
  id?: string
  invoiceNumber: string
  date: string
  status: "DRAFT" | "FINALIZED" | "CANCELLED"
  paymentStatus: "Unpaid" | "Paid"
  discount: number
  taxRatePercent: number
  notes?: string
  items: BillItem[]
}

export type BillLayoutPreferences = {
  showBanner: boolean
  showClinicLogo: boolean
  showClinicEmail: boolean
  showSignature: boolean
  showPaymentNote: boolean
}

export type ClinicalLibraryCategory = "Medicines" | "Formulations" | "Strengths" | "Doses" | "Durations"

export type ClinicalMedicineDefinition = {
  id?: string
  name: string
  formulation: string
  strength: string
  activeIngredient?: string
  defaultDosage?: string
  defaultRoute?: string
  defaultFrequency?: string
  defaultDuration?: string
  defaultInstructions?: string
}

export type ClinicalLibrary = Record<ClinicalLibraryCategory, string[]> & {
  MedicineDefinitions: ClinicalMedicineDefinition[]
}

export const clinicalLibraryCategories: ClinicalLibraryCategory[] = [
  "Medicines",
  "Formulations",
  "Strengths",
  "Doses",
  "Durations",
]

export const initialPatients: Patient[] = [
  {
    id: "PC-1048",
    name: "Ananya Iyer",
    initials: "AI",
    age: 34,
    gender: "Female",
    phone: "+91 98765 43210",
    lastVisit: "Today, 10:30 AM",
    allergies: ["Penicillin"],
    conditions: ["Seasonal allergic rhinitis"],
    registeredAt: "2026-11-07T10:30",
  },
  {
    id: "PC-1047",
    name: "Vikram Mehta",
    initials: "VM",
    age: 52,
    gender: "Male",
    phone: "+91 98204 11882",
    lastVisit: "24/06/2025",
    allergies: [],
    conditions: ["Hypertension"],
    registeredAt: "2025-06-24T09:15",
  },
  {
    id: "PC-1046",
    name: "Sana Kapoor",
    initials: "SK",
    age: 28,
    gender: "Female",
    phone: "+91 99876 22109",
    lastVisit: "22/06/2025",
    allergies: ["Sulfonamides"],
    conditions: [],
    registeredAt: "2025-06-22T14:00",
  },
  {
    id: "PC-1045",
    name: "Rohan Shah",
    initials: "RS",
    age: 41,
    gender: "Male",
    phone: "+91 98921 88276",
    lastVisit: "18/06/2025",
    allergies: [],
    conditions: ["Type 2 diabetes"],
    registeredAt: "2025-06-18T11:45",
  },
  {
    id: "PC-1044",
    name: "Meera Nair",
    initials: "MN",
    age: 66,
    gender: "Female",
    phone: "+91 97694 33721",
    lastVisit: "15/06/2025",
    allergies: [],
    conditions: ["Osteoarthritis"],
    registeredAt: "2025-06-15T16:20",
  },
]

const INDIA_TIME_ZONE = "Asia/Kolkata"

const SHORT_MONTH_MAP: Record<string, string> = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
  january: "01",
  february: "02",
  march: "03",
  april: "04",
  june: "06",
  july: "07",
  august: "08",
  september: "09",
  october: "10",
  november: "11",
  december: "12",
}

function parseTextualDateComponents(
  str: string,
): { day: string; month: string; year: string } | null {
  // "24 Jun 2025" or "24 June 2025"
  const m1 = str.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/)
  if (m1) {
    const month = SHORT_MONTH_MAP[m1[2].toLowerCase()]
    if (month) {
      return { day: m1[1].padStart(2, "0"), month, year: m1[3] }
    }
  }
  // "Jun 24, 2025" or "June 24 2025"
  const m2 = str.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/)
  if (m2) {
    const month = SHORT_MONTH_MAP[m2[1].toLowerCase()]
    if (month) {
      return { day: m2[2].padStart(2, "0"), month, year: m2[3] }
    }
  }
  return null
}

/**
 * Safely parses a Date, timestamp number, or date string in the context of India clinic time (Asia/Kolkata).
 *
 * Key handling:
 * - Naive local ISO datetime strings without timezone offset (e.g. "2026-11-07T20:45:00" or "2026-11-07 20:45")
 *   are treated as local India clinic datetimes (UTC+05:30), avoiding host/runner timezone shifts.
 * - Date-only strings ("2026-11-07") are parsed at midnight in Asia/Kolkata (+05:30).
 * - Full ISO strings with UTC/offset (e.g. "2026-11-07T15:15:00.000Z" or "+05:30") are parsed as exact instants.
 * - Textual date strings ("24 Jun 2025") are parsed without host timezone dependency.
 * - Numeric timestamps (milliseconds or Unix seconds) are converted to Date.
 */
export function parseIndiaDateTime(
  input?: Date | string | number | null,
): Date | null {
  if (input === null || input === undefined) return null
  if (input instanceof Date) {
    return isNaN(input.getTime()) ? null : input
  }
  if (typeof input === "number") {
    const ms = input < 10000000000 ? input * 1000 : input
    const d = new Date(ms)
    return isNaN(d.getTime()) ? null : d
  }
  const str = String(input).trim()
  if (!str) return null

  // Numeric timestamp string (ms or Unix seconds)
  if (/^\d{10,13}$/.test(str)) {
    const num = Number(str)
    const ms = num < 10000000000 ? num * 1000 : num
    const d = new Date(ms)
    return isNaN(d.getTime()) ? null : d
  }

  // Naive local ISO-like datetime without timezone (e.g. YYYY-MM-DDTHH:mm or YYYY-MM-DD HH:mm:ss)
  // In Cliniqo, dates recorded without offset represent India clinic wall-clock time (Asia/Kolkata, UTC+05:30)
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(str)) {
    return new Date(str.replace(" ", "T") + "+05:30")
  }

  // Date-only ISO YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return new Date(`${str}T00:00:00+05:30`)
  }

  // Date-only DD/MM/YYYY or DD-MM-YYYY
  const ddmmyyyy = str.match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{4})$/)
  if (ddmmyyyy) {
    return new Date(
      `${ddmmyyyy[3]}-${ddmmyyyy[2]}-${ddmmyyyy[1]}T00:00:00+05:30`,
    )
  }

  // Textual dates like "24 Jun 2025" or "Jun 24, 2025"
  const textual = parseTextualDateComponents(str)
  if (textual) {
    return new Date(
      `${textual.year}-${textual.month}-${textual.day}T00:00:00+05:30`,
    )
  }

  const d = new Date(str)
  return isNaN(d.getTime()) ? null : d
}

export function getIndiaDateTimeLocalString(
  input?: Date | string | number | null,
): string {
  if (!input) {
    const d = new Date()
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: INDIA_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(d)
    const map: Record<string, string> = {}
    for (const p of parts) map[p.type] = p.value
    let hour = map.hour || "00"
    if (hour === "24") hour = "00"
    return `${map.year}-${map.month}-${map.day}T${hour}:${map.minute}`
  }

  if (typeof input === "string") {
    // If it is already a naive local ISO datetime string (YYYY-MM-DDTHH:mm), preserve as is
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(input.trim())) {
      return input.trim()
    }
  }

  const d = parseIndiaDateTime(input)
  if (!d || isNaN(d.getTime())) return ""

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: INDIA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d)
  const map: Record<string, string> = {}
  for (const p of parts) map[p.type] = p.value
  let hour = map.hour || "00"
  if (hour === "24") hour = "00"
  return `${map.year}-${map.month}-${map.day}T${hour}:${map.minute}`
}

export function formatDateDDMMYYYY(
  input?: string | Date | number | null,
): string {
  if (!input) return ""
  if (typeof input === "string") {
    const str = input.trim()
    if (!str) return ""
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(str)) return str

    // Date-only ISO like YYYY-MM-DD
    const isoDateMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})$/)
    if (isoDateMatch) {
      return `${isoDateMatch[3]}/${isoDateMatch[2]}/${isoDateMatch[1]}`
    }

    // Date-only DD-MM-YYYY
    const dashMatch = str.match(/^(\d{2})-(\d{2})-(\d{4})$/)
    if (dashMatch) {
      return `${dashMatch[1]}/${dashMatch[2]}/${dashMatch[3]}`
    }

    // Textual date like "24 Jun 2025"
    const textual = parseTextualDateComponents(str)
    if (textual) {
      return `${textual.day}/${textual.month}/${textual.year}`
    }
  }

  const d = parseIndiaDateTime(input)
  if (!d || isNaN(d.getTime())) {
    return typeof input === "string" ? input.trim() : ""
  }

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: INDIA_TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(d)
  const map: Record<string, string> = {}
  for (const p of parts) map[p.type] = p.value
  return `${map.day}/${map.month}/${map.year}`
}

export function formatDateTimeDDMMYYYY(
  input?: string | Date | number | null,
  includeTime = true,
): string {
  if (!input) return ""

  // If input is a pure date-only string (e.g. YYYY-MM-DD or DD/MM/YYYY or DD-MM-YYYY or "24 Jun 2025"),
  // format without fictitious time
  if (typeof input === "string") {
    const trimmed = input.trim()
    if (!trimmed) return ""
    if (
      /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ||
      /^\d{2}\/\d{2}\/\d{4}$/.test(trimmed) ||
      /^\d{2}-\d{2}-\d{4}$/.test(trimmed) ||
      parseTextualDateComponents(trimmed) !== null
    ) {
      return formatDateDDMMYYYY(trimmed)
    }
  }

  const d = parseIndiaDateTime(input)
  if (!d || isNaN(d.getTime())) {
    return formatDateDDMMYYYY(input)
  }

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: INDIA_TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(d)
  const map: Record<string, string> = {}
  for (const p of parts) map[p.type] = p.value
  const dateStr = `${map.day}/${map.month}/${map.year}`
  if (!includeTime || !map.hour || !map.minute) {
    return dateStr
  }
  const period = map.dayPeriod ? ` ${map.dayPeriod.toUpperCase()}` : ""
  return `${dateStr}, ${map.hour}:${map.minute}${period}`
}

export function formatIndiaDateTime(
  input?: string | Date | number | null,
): string {
  return formatDateTimeDDMMYYYY(input, true)
}

export function formatSequentialPatientId(seq: number): string {
  const safeSeq = Math.max(1, Math.floor(seq || 1))
  const zeroIndex = safeSeq - 1
  const prefixIndex = Math.floor(zeroIndex / 9999)
  const numPart = (zeroIndex % 9999) + 1

  const c1 = String.fromCharCode(65 + (Math.floor(prefixIndex / (26 * 26)) % 26))
  const c2 = String.fromCharCode(65 + (Math.floor(prefixIndex / 26) % 26))
  const c3 = String.fromCharCode(65 + (prefixIndex % 26))

  return `${c1}${c2}${c3}-${numPart.toString().padStart(4, "0")}`
}

export function parseSequentialPatientId(id: string): number | null {
  if (!id || typeof id !== "string") return null
  const trimmed = id.trim().toUpperCase()
  const match = trimmed.match(/^([A-Z]{3})-(\d{4})$/)
  if (!match) return null

  const prefix = match[1]
  const num = parseInt(match[2], 10)
  if (num < 1 || num > 9999) return null

  const p0 = prefix.charCodeAt(0) - 65
  const p1 = prefix.charCodeAt(1) - 65
  const p2 = prefix.charCodeAt(2) - 65
  if (p0 < 0 || p0 > 25 || p1 < 0 || p1 > 25 || p2 < 0 || p2 > 25) return null

  const prefixIndex = p0 * 676 + p1 * 26 + p2
  return prefixIndex * 9999 + num
}

export function isSequentialPatientId(id: string): boolean {
  return parseSequentialPatientId(id) !== null
}

export function getPublicPatientId(
  patient?: { displayId?: string; patientCode?: string; id?: string } | null,
): string {
  if (!patient) return ""
  const candidate = (
    patient.displayId?.trim() ||
    patient.patientCode?.trim() ||
    patient.id?.trim() ||
    ""
  )
  if (!candidate) return ""

  // Never expose raw MongoDB ObjectIds (24 hex characters) or UUIDs as patient IDs
  const isMongoId = /^[0-9a-f]{24}$/i.test(candidate)
  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      candidate,
    )

  if (isMongoId || isUuid) {
    if (
      patient.displayId &&
      !/^[0-9a-f]{24}$/i.test(patient.displayId) &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}/i.test(patient.displayId)
    ) {
      return patient.displayId.trim()
    }
    if (
      patient.patientCode &&
      !/^[0-9a-f]{24}$/i.test(patient.patientCode) &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}/i.test(patient.patientCode)
    ) {
      return patient.patientCode.trim()
    }
    return "AAA-0001"
  }

  return candidate
}

export function mapLocalRecordToPatient(rec: LocalPatientRecord): Patient {
  const name = rec.name || "Unnamed Patient"
  const initials =
    name
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase() || "PT"

  let displayId = ""
  if (rec.patient_code && rec.patient_code.trim().length > 0) {
    const trimmed = rec.patient_code.trim().toUpperCase()
    if (/^[A-Z]{3}-\d{4}$/.test(trimmed)) {
      displayId = trimmed
    } else if (
      /^PC-\d+/i.test(trimmed) ||
      /^P-\d+/i.test(trimmed) ||
      /^PT-\d+/i.test(trimmed)
    ) {
      // Historical IDs preserved as-is
      displayId = trimmed
    } else if (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        trimmed,
      ) ||
      /^[0-9a-f]{24}$/i.test(trimmed)
    ) {
      // Never expose UUID or Mongo ObjectId
      displayId = ""
    } else {
      displayId = trimmed
    }
  }

  if (!displayId) {
    const isIdUuidOrMongo =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        rec.id,
      ) || /^[0-9a-f]{24}$/i.test(rec.id)
    if (!isIdUuidOrMongo && rec.id) {
      displayId = rec.id
    }
  }

  let registeredAt: string | undefined = undefined
  let alternatePhone: string | undefined = undefined
  let address: string | undefined = undefined

  if (rec.sensitive_notes) {
    try {
      const parsed = JSON.parse(rec.sensitive_notes)
      if (typeof parsed === "object" && parsed !== null) {
        if (parsed.registeredAt) registeredAt = String(parsed.registeredAt)
        if (parsed.alternatePhone)
          alternatePhone = String(parsed.alternatePhone)
        if (parsed.address) address = String(parsed.address)
      }
    } catch {
      // not json, leave as plain note
    }
  }

  return {
    id: rec.id,
    displayId,
    patientCode: displayId,
    name,
    initials,
    age: rec.age ?? 0,
    gender: rec.gender || "Other",
    phone: rec.phone || "",
    lastVisit: "No visits yet",
    allergies: Array.isArray(rec.allergies) ? rec.allergies : [],
    conditions: Array.isArray(rec.conditions) ? rec.conditions : [],
    dateOfBirth: rec.date_of_birth || undefined,
    alternatePhone,
    address,
    registeredAt,
    syncStatus: rec.sync_status,
    updatedAt: rec.updated_at,
  }
}

export const emptyMedicine = (id: number): Medicine => ({
  id,
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
})

export const createEmptyConsultationData = (): ConsultationData => ({
  date: new Date().toISOString().slice(0, 10),
  time: new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }),
  chiefComplaint: "",
  symptomDuration: "",
  diagnosis: "",
  medicines: [],
  followUpDate: "",
  followUpInstructions: "",
  allergies: [],
  conditions: [],
})

export const getDoseConfig = (formulation: string) => {
  switch (formulation) {
    case "Tablet":
      return { unit: "tablet(s)", step: "0.5", placeholder: "0" }
    case "Capsule":
      return { unit: "capsule(s)", step: "1", placeholder: "0" }
    case "Syrup":
    case "Suspension":
    case "Mouthwash":
    case "Injection":
      return { unit: "mL", step: "0.5", placeholder: "0" }
    case "Cream":
    case "Ointment":
    case "Gel":
    case "Lotion":
      return { unit: "application(s)", step: "1", placeholder: "0" }
    case "Drops":
    case "Eye Drops":
    case "Ear Drops":
      return { unit: "drop(s)", step: "1", placeholder: "0" }
    case "Inhaler":
      return { unit: "puff(s)", step: "1", placeholder: "0" }
    case "Powder":
      return { unit: "sachet(s)", step: "1", placeholder: "0" }
    case "Suppository":
      return { unit: "suppository(ies)", step: "1", placeholder: "0" }
    default:
      return { unit: "unit(s)", step: "0.5", placeholder: "0" }
  }
}

export const formatMedicineDose = (dose: string, formulation: string) => {
  if (!dose) return ""
  return /[a-zA-Z]/.test(dose)
    ? dose
    : `${dose} ${getDoseConfig(formulation).unit}`
}

export const oralFormulations = new Set([
  "Tablet",
  "Capsule",
  "Syrup",
  "Suspension",
  "Powder",
])
export const topicalFormulations = new Set([
  "Cream",
  "Ointment",
  "Gel",
  "Lotion",
])

export const FORMULATION_SHORTCUTS: Record<string, string> = {
  t: "Tablet",
  c: "Capsule",
  s: "Syrup",
  d: "Drops",
  i: "Injection",
  o: "Ointment",
  r: "Cream",
  g: "Gel",
  p: "Powder",
  l: "Lotion",
  n: "Suspension",
  m: "Mouthwash",
  h: "Inhaler",
  e: "Eye Drops",
  u: "Ear Drops",
  b: "Suppository",
}

export const FORMULATION_LETTER_MAP: Record<string, string> = {
  Tablet: "T",
  Capsule: "C",
  Syrup: "S",
  Drops: "D",
  Injection: "I",
  Ointment: "O",
  Cream: "R",
  Gel: "G",
  Powder: "P",
  Lotion: "L",
  Suspension: "N",
  Mouthwash: "M",
  Inhaler: "H",
  "Eye Drops": "E",
  "Ear Drops": "U",
  Suppository: "B",
}

export const medicineOptions = [
  "Amlodipine",
  "Amoxicillin",
  "Azithromycin",
  "Cetirizine",
  "Ibuprofen",
  "Levocetirizine",
  "Metformin",
  "Pantoprazole",
  "Paracetamol",
]

export const complaintOptions = [
  "Fever",
  "Cough",
  "Headache",
  "Abdominal pain",
  "Breathing difficulty",
  "Body ache",
  "Follow-up / review",
]

export const symptomDurationOptions = [
  "Less than 24 hours",
  "1–3 days",
  "4–7 days",
  "1–2 weeks",
  "2–4 weeks",
  "More than 1 month",
]

export const diagnosisOptions = [
  "Upper respiratory tract infection",
  "Viral fever",
  "Hypertension",
  "Type 2 diabetes mellitus",
  "Allergic rhinitis",
  "Gastritis",
  "Migraine",
]

export const defaultClinicalLibrary: ClinicalLibrary = {
  Medicines: medicineOptions,
  Formulations: [
    "Tablet",
    "Capsule",
    "Syrup",
    "Drops",
    "Injection",
    "Ointment",
    "Cream",
    "Gel",
    "Powder",
    "Lotion",
    "Suspension",
    "Mouthwash",
    "Inhaler",
    "Eye Drops",
    "Ear Drops",
    "Suppository",
  ],
  Strengths: [
    "2.5 mg",
    "5 mg",
    "10 mg",
    "20 mg",
    "40 mg",
    "100 mg",
    "250 mg",
    "500 mg",
    "650 mg",
    "1 g",
  ],
  Doses: [
    "½ tablet",
    "1 tablet",
    "2 tablets",
    "1 capsule",
    "5 mL",
    "10 mL",
    "1 puff",
    "2 puffs",
  ],
  Durations: [
    "1 day",
    "3 days",
    "5 days",
    "7 days",
    "10 days",
    "14 days",
    "30 days",
    "Until review",
  ],
  MedicineDefinitions: [],
}

export const loadClinicalLibrary = (): ClinicalLibrary => {
  try {
    const saved = JSON.parse(
      window.localStorage.getItem("cliniqo-clinical-library") || "{}",
    ) as Partial<ClinicalLibrary>
    const formulations = Array.isArray(saved.Formulations)
      ? Array.from(
          new Set([
            ...defaultClinicalLibrary.Formulations,
            ...saved.Formulations,
          ]),
        )
      : defaultClinicalLibrary.Formulations
    return { ...defaultClinicalLibrary, ...saved, Formulations: formulations }
  } catch {
    return defaultClinicalLibrary
  }
}
