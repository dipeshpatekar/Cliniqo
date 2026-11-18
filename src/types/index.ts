import type { LocalPatientRecord } from "../desktop/desktop-bridge"

export type Page = "login" | "register" | "setup" | "dashboard" | "patients" | "patient-form" | "patient-profile" | "consultation" | "preview" | "bill-form" | "bill-preview" | "settings"

export type Patient = {
  id: string
  displayId?: string
  patientCode?: string
  name: string
  initials: string
  age: number
  ageMonths?: number
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
  prescriptionNumber?: string
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

export const loadPatientFormFieldPreferences = (
  clinicId?: string,
): PatientFormFieldPreferences => {
  if (typeof window === "undefined" || !window.localStorage) {
    return { ...defaultPatientFormFieldPreferences }
  }
  try {
    const scopedKey = clinicId
      ? `cliniqo-patient-form-preferences_${clinicId}`
      : "cliniqo-patient-form-preferences"
    const raw =
      window.localStorage.getItem(scopedKey) ||
      window.localStorage.getItem("cliniqo-patient-form-preferences")
    if (raw) {
      const saved = JSON.parse(raw)
      return {
        showDob:
          typeof saved.showDob === "boolean"
            ? saved.showDob
            : defaultPatientFormFieldPreferences.showDob,
        showPhone:
          typeof saved.showPhone === "boolean"
            ? saved.showPhone
            : defaultPatientFormFieldPreferences.showPhone,
        showAlternatePhone:
          typeof saved.showAlternatePhone === "boolean"
            ? saved.showAlternatePhone
            : defaultPatientFormFieldPreferences.showAlternatePhone,
        showAddress:
          typeof saved.showAddress === "boolean"
            ? saved.showAddress
            : defaultPatientFormFieldPreferences.showAddress,
      }
    }
  } catch {}
  return { ...defaultPatientFormFieldPreferences }
}

export const savePatientFormFieldPreferences = (
  prefs: PatientFormFieldPreferences,
  clinicId?: string,
): void => {
  if (typeof window === "undefined" || !window.localStorage) return
  try {
    const raw = JSON.stringify(prefs)
    window.localStorage.setItem("cliniqo-patient-form-preferences", raw)
    if (clinicId) {
      window.localStorage.setItem(
        `cliniqo-patient-form-preferences_${clinicId}`,
        raw,
      )
    }
  } catch {}
}

export type PrescriptionLayoutPreferences = {
  bannerVisible: boolean
  showClinicLogo: boolean
  showClinicEmail: boolean
  showAllergyWarning: boolean
  topSpacingMm: number
  bannerImage: { src: string; name: string } | null
  signatureImage: { src: string; name: string } | null
}

export const defaultPrescriptionLayoutPreferences: PrescriptionLayoutPreferences = {
  bannerVisible: true,
  showClinicLogo: true,
  showClinicEmail: true,
  showAllergyWarning: true,
  topSpacingMm: 0,
  bannerImage: null,
  signatureImage: null,
}

export const loadPrescriptionLayoutPreferences = (
  clinicId?: string,
): PrescriptionLayoutPreferences => {
  if (typeof window === "undefined" || !window.localStorage) {
    return { ...defaultPrescriptionLayoutPreferences }
  }
  try {
    const scopedKey = clinicId
      ? `cliniqo-prescription-layout-preferences_${clinicId}`
      : "cliniqo-prescription-layout-preferences"
    const raw =
      window.localStorage.getItem(scopedKey) ||
      window.localStorage.getItem("cliniqo-prescription-layout-preferences")
    if (raw) {
      const saved = JSON.parse(raw)
      return {
        bannerVisible:
          typeof saved.bannerVisible === "boolean"
            ? saved.bannerVisible
            : defaultPrescriptionLayoutPreferences.bannerVisible,
        showClinicLogo:
          typeof saved.showClinicLogo === "boolean"
            ? saved.showClinicLogo
            : defaultPrescriptionLayoutPreferences.showClinicLogo,
        showClinicEmail:
          typeof saved.showClinicEmail === "boolean"
            ? saved.showClinicEmail
            : defaultPrescriptionLayoutPreferences.showClinicEmail,
        showAllergyWarning:
          typeof saved.showAllergyWarning === "boolean"
            ? saved.showAllergyWarning
            : defaultPrescriptionLayoutPreferences.showAllergyWarning,
        topSpacingMm:
          typeof saved.topSpacingMm === "number" && !isNaN(saved.topSpacingMm)
            ? Math.max(0, Math.min(100, saved.topSpacingMm))
            : defaultPrescriptionLayoutPreferences.topSpacingMm,
        bannerImage: saved.bannerImage ?? null,
        signatureImage: saved.signatureImage ?? null,
      }
    }
  } catch {}
  return { ...defaultPrescriptionLayoutPreferences }
}

export const savePrescriptionLayoutPreferences = (
  prefs: PrescriptionLayoutPreferences,
  clinicId?: string,
): void => {
  if (typeof window === "undefined" || !window.localStorage) return
  try {
    const raw = JSON.stringify(prefs)
    window.localStorage.setItem("cliniqo-prescription-layout-preferences", raw)
    if (clinicId) {
      window.localStorage.setItem(
        `cliniqo-prescription-layout-preferences_${clinicId}`,
        raw,
      )
    }
  } catch {}
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
  topSpacingMm: number
}

export const defaultBillLayoutPreferences: BillLayoutPreferences = {
  showBanner: true,
  showClinicLogo: true,
  showClinicEmail: true,
  showSignature: true,
  showPaymentNote: true,
  topSpacingMm: 0,
}

export const loadBillLayoutPreferences = (
  clinicId?: string,
): BillLayoutPreferences => {
  if (typeof window === "undefined" || !window.localStorage) {
    return { ...defaultBillLayoutPreferences }
  }
  try {
    const scopedKey = clinicId
      ? `cliniqo-bill-layout-preferences_${clinicId}`
      : "cliniqo-bill-layout-preferences"
    const raw =
      window.localStorage.getItem(scopedKey) ||
      window.localStorage.getItem("cliniqo-bill-layout-preferences")
    if (raw) {
      const saved = JSON.parse(raw)
      return {
        showBanner:
          typeof saved.showBanner === "boolean"
            ? saved.showBanner
            : defaultBillLayoutPreferences.showBanner,
        showClinicLogo:
          typeof saved.showClinicLogo === "boolean"
            ? saved.showClinicLogo
            : defaultBillLayoutPreferences.showClinicLogo,
        showClinicEmail:
          typeof saved.showClinicEmail === "boolean"
            ? saved.showClinicEmail
            : defaultBillLayoutPreferences.showClinicEmail,
        showSignature:
          typeof saved.showSignature === "boolean"
            ? saved.showSignature
            : defaultBillLayoutPreferences.showSignature,
        showPaymentNote:
          typeof saved.showPaymentNote === "boolean"
            ? saved.showPaymentNote
            : defaultBillLayoutPreferences.showPaymentNote,
        topSpacingMm:
          typeof saved.topSpacingMm === "number" && !isNaN(saved.topSpacingMm)
            ? Math.max(0, Math.min(100, saved.topSpacingMm))
            : defaultBillLayoutPreferences.topSpacingMm,
      }
    }
  } catch {}
  return { ...defaultBillLayoutPreferences }
}

export const saveBillLayoutPreferences = (
  prefs: BillLayoutPreferences,
  clinicId?: string,
): void => {
  if (typeof window === "undefined" || !window.localStorage) return
  try {
    const raw = JSON.stringify(prefs)
    window.localStorage.setItem("cliniqo-bill-layout-preferences", raw)
    if (clinicId) {
      window.localStorage.setItem(
        `cliniqo-bill-layout-preferences_${clinicId}`,
        raw,
      )
    }
  } catch {}
}

export type ClinicalLibraryCategory =
  | "Medicines"
  | "Formulations"
  | "Strengths"
  | "Doses"
  | "Durations"
  | "Frequencies"
  | "FoodInstructions"

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
  "Frequencies",
  "FoodInstructions",
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

export function formatPrescriptionDateWithTime(
  date?: string | null,
  time?: string | null,
): string {
  if (!date && !time) return "—"

  if (date && (date.includes("T") || (date.includes(":") && date.length > 10))) {
    return formatDateTimeDDMMYYYY(date, true) || "—"
  }

  const datePart = formatDateDDMMYYYY(date) || (date ? date.trim() : "")

  if (!time || !time.trim()) {
    return datePart || "—"
  }

  const trimmedTime = time.trim()

  const ampmMatch = trimmedTime.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)$/i)
  if (ampmMatch) {
    const hh = ampmMatch[1].padStart(2, "0")
    const mm = ampmMatch[2]
    const period = ampmMatch[3].toUpperCase()
    const formattedTime = `${hh}:${mm} ${period}`
    return datePart ? `${datePart}, ${formattedTime}` : formattedTime
  }

  const time24Match = trimmedTime.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/)
  if (time24Match) {
    let hours = parseInt(time24Match[1], 10)
    const minutes = time24Match[2]
    const period = hours >= 12 ? "PM" : "AM"
    hours = hours % 12
    if (hours === 0) hours = 12
    const hh = String(hours).padStart(2, "0")
    const formattedTime = `${hh}:${minutes} ${period}`
    return datePart ? `${datePart}, ${formattedTime}` : formattedTime
  }

  return datePart ? `${datePart}, ${trimmedTime}` : trimmedTime
}

export function isMissingAge(
  age?: number | null,
  ageMonths?: number | null,
): boolean {
  const hasYears =
    age !== undefined &&
    age !== null &&
    !isNaN(Number(age)) &&
    Number(age) > 0
  const hasMonths =
    ageMonths !== undefined &&
    ageMonths !== null &&
    !isNaN(Number(ageMonths)) &&
    Number(ageMonths) > 0
  return !hasYears && !hasMonths
}

export function isMissingGender(gender?: string | null): boolean {
  if (!gender) return true
  const trimmed = gender.trim()
  return (
    !trimmed ||
    trimmed === "—" ||
    trimmed === "-" ||
    trimmed.toLowerCase() === "other"
  )
}

export function formatPatientAge(
  age?: number | null,
  unit: "yrs" | "years" = "yrs",
  ageMonths?: number | null,
): string {
  const safeYears =
    age !== undefined && age !== null && !isNaN(Number(age))
      ? Math.max(0, Math.floor(Number(age)))
      : 0
  const safeMonths =
    ageMonths !== undefined && ageMonths !== null && !isNaN(Number(ageMonths))
      ? Math.min(11, Math.max(0, Math.floor(Number(ageMonths))))
      : 0

  const hasYears = safeYears > 0
  const hasMonths = safeMonths > 0

  if (!hasYears && !hasMonths) {
    return "—"
  }

  const yearUnit =
    unit === "years"
      ? safeYears === 1
        ? "year"
        : "years"
      : safeYears === 1
        ? "yr"
        : "yrs"
  const monthUnit =
    unit === "years"
      ? safeMonths === 1
        ? "month"
        : "months"
      : safeMonths === 1
        ? "mo"
        : "mos"

  if (hasYears && hasMonths) {
    return `${safeYears} ${yearUnit} ${safeMonths} ${monthUnit}`
  }
  if (hasYears) {
    return `${safeYears} ${yearUnit}`
  }
  return safeMonths === 1 ? "1 month" : `${safeMonths} months`
}

export function formatPatientGender(gender?: string | null): string {
  if (isMissingGender(gender)) return "—"
  return (gender as string).trim()
}

export function formatPatientAgeGender(
  age?: number | null,
  gender?: string | null,
  ageUnit: "yrs" | "years" = "yrs",
  ageMonths?: number | null,
): string {
  const missingAge = isMissingAge(age, ageMonths)
  const missingGender = isMissingGender(gender)

  if (missingAge && missingGender) {
    return "— · —"
  }
  if (missingAge) {
    return `— · ${formatPatientGender(gender)}`
  }
  if (missingGender) {
    return `${formatPatientAge(age, ageUnit, ageMonths)} · —`
  }
  return `${formatPatientAge(age, ageUnit, ageMonths)} · ${formatPatientGender(gender)}`
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
  let ageMonths: number | undefined = undefined

  if (rec.age_months !== undefined && rec.age_months !== null) {
    const directMonths = Number(rec.age_months)
    if (!isNaN(directMonths)) {
      ageMonths = Math.min(11, Math.max(0, Math.floor(directMonths)))
    }
  }

  if (rec.sensitive_notes) {
    try {
      const parsed = JSON.parse(rec.sensitive_notes)
      if (typeof parsed === "object" && parsed !== null) {
        if (parsed.registeredAt) registeredAt = String(parsed.registeredAt)
        if (parsed.alternatePhone)
          alternatePhone = String(parsed.alternatePhone)
        if (parsed.address) address = String(parsed.address)
        if (
          ageMonths === undefined &&
          parsed.ageMonths !== undefined &&
          parsed.ageMonths !== null
        ) {
          const parsedMonths = Number(parsed.ageMonths)
          if (!isNaN(parsedMonths)) {
            ageMonths = Math.min(11, Math.max(0, Math.floor(parsedMonths)))
          }
        }
      }
    } catch {
      // not json, leave as plain note
    }
  }

  // Preserve registration date & time from SQLite created_at when not explicitly in sensitive_notes
  if (!registeredAt) {
    if (rec.created_at) {
      registeredAt = rec.created_at
    } else if (rec.updated_at) {
      registeredAt = rec.updated_at
    }
  }

  return {
    id: rec.id,
    displayId,
    patientCode: displayId,
    name,
    initials,
    age: rec.age ?? 0,
    ageMonths,
    gender: rec.gender && rec.gender.trim() ? rec.gender.trim() : "",
    phone: rec.phone || "",
    lastVisit: rec.last_visit || "No visits yet",
    allergies: Array.isArray(rec.allergies) ? rec.allergies : [],
    conditions: Array.isArray(rec.conditions) ? rec.conditions : [],
    dateOfBirth: rec.date_of_birth || undefined,
    alternatePhone,
    address,
    registeredAt,
    syncStatus: rec.sync_status,
    updatedAt: rec.updated_at,
    createdAt: rec.created_at || undefined,
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

export function computeDefaultFollowUpDate(consultationDateStr?: string): string {
  if (!consultationDateStr) {
    const now = new Date()
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 3)
    return `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}-${String(target.getDate()).padStart(2, "0")}`
  }
  const datePart = consultationDateStr.split("T")[0].split(" ")[0]
  const parts = datePart.split("-")
  if (parts.length === 3) {
    const y = parseInt(parts[0], 10)
    const m = parseInt(parts[1], 10) - 1
    const d = parseInt(parts[2], 10)
    if (!isNaN(y) && !isNaN(m) && !isNaN(d)) {
      const target = new Date(y, m, d + 3)
      return `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}-${String(target.getDate()).padStart(2, "0")}`
    }
  }
  const now = new Date()
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 3)
  return `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}-${String(target.getDate()).padStart(2, "0")}`
}

export interface PrescriptionRevisionData {
  medicines: Medicine[]
  vitals: Vitals
  chiefComplaint: string
  symptomDuration: string
  diagnosis: string
  allergies: string[]
  conditions: string[]
  consultationDate: string
  consultationTime: string
  followUpDate: string
  followUpInstructions: string
  reasonForRevision?: string
}

export const FORMULATION_NORM_MAP: Record<string, string> = {
  TABLET: "Tablet",
  CAPSULE: "Capsule",
  SYRUP: "Syrup",
  SUSPENSION: "Suspension",
  INJECTION: "Injection",
  INHALER: "Inhaler",
  DROPS: "Drops",
  CREAM: "Cream",
  OINTMENT: "Ointment",
  GEL: "Gel",
  LOTION: "Lotion",
  PATCH: "Patch",
  POWDER: "Powder",
  SPRAY: "Spray",
  SUPPOSITORY: "Suppository",
}

export const FREQUENCY_NORM_MAP: Record<string, string> = {
  OD: "Once daily",
  BD: "Twice daily",
  TID: "Three times daily",
  QID: "Four times daily",
  Q4H: "Every 4 hours",
  Q6H: "Every 6 hours",
  Q8H: "Every 8 hours",
  Q12H: "Every 12 hours",
  BEDTIME: "At bedtime",
  WEEKLY: "Once weekly",
}

export const FOOD_NORM_MAP: Record<string, string> = {
  AFTER_MEALS: "After food",
  BEFORE_MEALS: "Before food",
  WITH_MEALS: "With food",
  EMPTY_STOMACH: "Empty stomach",
  AS_DIRECTED: "As directed",
  IRRELEVANT: "Any time",
  NOT_APPLICABLE: "Not applicable",
}

export const ROUTE_NORM_MAP: Record<string, string> = {
  ORAL: "Oral",
  TOPICAL: "Topical",
  INHALATION: "Inhalation",
  INTRAVENOUS: "Intravenous (IV)",
  INTRAMUSCULAR: "Intramuscular (IM)",
  SUBCUTANEOUS: "Subcutaneous (SC)",
  OPHTHALMIC: "Ophthalmic",
  OTIC: "Otic",
  NASAL: "Nasal",
  RECTAL: "Rectal",
  SUBLINGUAL: "Sublingual",
  TRANSDERMAL: "Transdermal",
}

export function normalizeMedicineItem(raw: any, index: number = 0): Medicine {
  if (!raw || typeof raw !== "object") {
    return emptyMedicine(index + 1)
  }

  // 1. Name
  let name = ""
  if (typeof raw.name === "string" && raw.name.trim()) {
    name = raw.name.trim()
  } else if (typeof raw.medicineName === "string" && raw.medicineName.trim()) {
    name = raw.medicineName.trim()
  } else if (typeof raw.medicine_name === "string" && raw.medicine_name.trim()) {
    name = raw.medicine_name.trim()
  } else if (typeof raw.productName === "string" && raw.productName.trim()) {
    name = raw.productName.trim()
  } else if (typeof raw.brandName === "string" && raw.brandName.trim()) {
    name = raw.brandName.trim()
  }

  // 2. Formulation
  let formulation = ""
  const rawForm = raw.formulation || raw.dosageForm || raw.dosage_form || ""
  if (typeof rawForm === "string" && rawForm.trim()) {
    const trimmed = rawForm.trim()
    const upper = trimmed.toUpperCase()
    formulation = FORMULATION_NORM_MAP[upper] || trimmed
  }

  // 3. Strength
  let strength = ""
  if (typeof raw.strength === "string") {
    strength = raw.strength.trim()
  } else if (typeof raw.strength === "number") {
    strength = String(raw.strength)
  } else if (raw.strength && typeof raw.strength === "object") {
    if (typeof raw.strength.display === "string" && raw.strength.display.trim()) {
      strength = raw.strength.display.trim()
    } else if (typeof raw.strength.rawStrength === "string" && raw.strength.rawStrength.trim()) {
      strength = raw.strength.rawStrength.trim()
    } else if (raw.strength.value !== undefined && raw.strength.value !== null) {
      strength = `${raw.strength.value} ${raw.strength.unit || ""}`.trim()
    } else if (Array.isArray(raw.strength.components) && raw.strength.components.length > 0) {
      strength = raw.strength.components
        .map((c: any) => `${c.ingredientName || ""} ${c.amount ?? ""} ${c.unit || ""}`.trim())
        .filter(Boolean)
        .join(" + ")
    }
  } else if (typeof raw.rawStrength === "string" && raw.rawStrength.trim()) {
    strength = raw.rawStrength.trim()
  } else if (typeof raw.productStrength === "string" && raw.productStrength.trim()) {
    strength = raw.productStrength.trim()
  }

  // 4. Dose
  let dose = ""
  if (typeof raw.dose === "string") {
    dose = raw.dose.trim()
  } else if (typeof raw.dose === "number") {
    dose = String(raw.dose)
  } else if (raw.dose && typeof raw.dose === "object") {
    const mag = raw.dose.magnitude ?? ""
    const unit = raw.dose.unit ?? ""
    dose = `${mag} ${unit}`.trim()
  } else if (raw.administeredDose && typeof raw.administeredDose === "object") {
    const mag = raw.administeredDose.magnitude ?? ""
    const unit = (raw.administeredDose.unit ?? "").toLowerCase()
    dose = `${mag} ${unit}`.trim()
  } else if (typeof raw.dosage === "string" && raw.dosage.trim()) {
    dose = raw.dosage.trim()
  } else if (typeof raw.defaultDosage === "string" && raw.defaultDosage.trim()) {
    dose = raw.defaultDosage.trim()
  } else if (typeof raw.default_dosage === "string" && raw.default_dosage.trim()) {
    dose = raw.default_dosage.trim()
  }

  // 5. Route
  let route = ""
  const rawRoute = raw.route || raw.medicineRoute || raw.medicine_route || raw.defaultRoute || ""
  if (typeof rawRoute === "string" && rawRoute.trim()) {
    const trimmed = rawRoute.trim()
    const upper = trimmed.toUpperCase()
    route = ROUTE_NORM_MAP[upper] || trimmed
  }

  // 6. Frequency
  let frequency = ""
  if (typeof raw.frequency === "string") {
    const trimmed = raw.frequency.trim()
    const upper = trimmed.toUpperCase()
    frequency = FREQUENCY_NORM_MAP[upper] || trimmed
  } else if (raw.frequency && typeof raw.frequency === "object") {
    const code = (raw.frequency.frequencyCode || raw.frequency.code || "").toUpperCase()
    if (code && FREQUENCY_NORM_MAP[code]) {
      frequency = FREQUENCY_NORM_MAP[code]
    } else if (raw.frequency.intervalHours) {
      frequency = `Every ${raw.frequency.intervalHours} hours`
    } else if (raw.frequency.prnIndication) {
      frequency = `As needed (${raw.frequency.prnIndication})`
    } else if (typeof raw.frequency.description === "string") {
      frequency = raw.frequency.description.trim()
    }
  } else if (typeof raw.defaultFrequency === "string" && raw.defaultFrequency.trim()) {
    const trimmed = raw.defaultFrequency.trim()
    frequency = FREQUENCY_NORM_MAP[trimmed.toUpperCase()] || trimmed
  }

  // 7. Duration
  let duration = ""
  if (typeof raw.duration === "string") {
    duration = raw.duration.trim()
  } else if (typeof raw.duration === "number") {
    duration = `${raw.duration} days`
  } else if (raw.duration && typeof raw.duration === "object") {
    const mag = raw.duration.magnitude ?? ""
    const unit = (raw.duration.unit ?? "days").toLowerCase()
    duration = `${mag} ${unit}`.trim()
  } else if (typeof raw.defaultDuration === "string" && raw.defaultDuration.trim()) {
    duration = raw.defaultDuration.trim()
  }

  // 8. Food Timing
  let food = ""
  const rawFood =
    raw.food ||
    raw.foodInstruction ||
    raw.food_instruction ||
    raw.foodTiming ||
    raw.food_timing ||
    ""
  if (typeof rawFood === "string" && rawFood.trim()) {
    const trimmed = rawFood.trim()
    const upper = trimmed.toUpperCase().replace(/\s+/g, "_")
    food = FOOD_NORM_MAP[upper] || trimmed
  }

  // 9. Directions / Instructions
  let directions = ""
  const rawDir =
    raw.directions ||
    raw.specialInstructions ||
    raw.special_instructions ||
    raw.instructions ||
    raw.applicationInstructions ||
    raw.defaultInstructions ||
    ""
  if (typeof rawDir === "string" && rawDir.trim()) {
    directions = rawDir.trim()
  }

  const id = typeof raw.id === "number" && !isNaN(raw.id) ? raw.id : index + 1

  return {
    id,
    name,
    formulation,
    strength,
    dose,
    route,
    frequency,
    duration,
    food,
    directions,
    activeIngredient: raw.activeIngredient || raw.active_ingredient,
    sourceIdentifier: raw.sourceIdentifier || raw.source_identifier,
    sourceProvenance: raw.sourceProvenance,
    isCombination: raw.isCombination,
    isStrengthVerified: raw.isStrengthVerified,
    isCustom: raw.isCustom,
    brandName: raw.brandName,
    genericName: raw.genericName,
    productName: raw.productName,
    releaseType: raw.releaseType,
    manufacturer: raw.manufacturer,
  }
}

export function normalizeMedicineList(rawList: any): Medicine[] {
  if (!rawList) return []
  let arr: any[] = []
  if (Array.isArray(rawList)) {
    arr = rawList
  } else if (typeof rawList === "object" && Array.isArray((rawList as any).items)) {
    arr = (rawList as any).items
  } else if (typeof rawList === "string") {
    try {
      const parsed = JSON.parse(rawList)
      return normalizeMedicineList(parsed)
    } catch {
      return []
    }
  }
  return arr.map((item, idx) => normalizeMedicineItem(item, idx))
}

export const createEmptyConsultationData = (initialDate?: string): ConsultationData => {
  const localDateStr =
    initialDate ||
    (() => {
      const d = new Date()
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
    })()
  return {
    date: localDateStr,
    time: new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }),
    chiefComplaint: "",
    symptomDuration: "",
    diagnosis: "",
    medicines: [],
    followUpDate: computeDefaultFollowUpDate(localDateStr),
    followUpInstructions: "",
    allergies: [],
    conditions: [],
  }
}

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

export const DEFAULT_COMPLAINT_OPTIONS: readonly string[] = complaintOptions

export const loadCustomChiefComplaints = (clinicId?: string): string[] => {
  if (typeof window === "undefined" || !window.localStorage) {
    return []
  }
  try {
    const scopedKey = clinicId
      ? `cliniqo-custom-chief-complaints_${clinicId}`
      : "cliniqo-custom-chief-complaints"
    const raw = window.localStorage.getItem(scopedKey)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (item): item is string =>
            typeof item === "string" && item.trim().length > 0,
        )
      }
    }
  } catch {}
  return []
}

export const saveCustomChiefComplaints = (
  customList: string[],
  clinicId?: string,
): void => {
  if (typeof window === "undefined" || !window.localStorage) return
  try {
    const scopedKey = clinicId
      ? `cliniqo-custom-chief-complaints_${clinicId}`
      : "cliniqo-custom-chief-complaints"
    const cleaned: string[] = []
    const seen = new Set<string>()
    for (const c of customList) {
      if (typeof c !== "string") continue
      const trimmed = c.trim()
      const lower = trimmed.toLowerCase()
      if (trimmed && !seen.has(lower)) {
        seen.add(lower)
        cleaned.push(trimmed)
      }
    }
    const raw = JSON.stringify(cleaned)
    window.localStorage.setItem(scopedKey, raw)
  } catch {}
}

export const getChiefComplaintOptions = (
  customComplaints: string[] = [],
): string[] => {
  const result = [...complaintOptions]
  const existingSet = new Set(
    complaintOptions.map((c) => c.trim().toLowerCase()),
  )

  for (const custom of customComplaints) {
    if (typeof custom !== "string") continue
    const trimmed = custom.trim()
    if (!trimmed) continue
    const lower = trimmed.toLowerCase()
    if (!existingSet.has(lower)) {
      existingSet.add(lower)
      result.push(trimmed)
    }
  }
  return result
}

export const addCustomChiefComplaint = (
  complaint: string,
  clinicId?: string,
): string[] => {
  if (typeof complaint !== "string") {
    return loadCustomChiefComplaints(clinicId)
  }
  const trimmed = complaint.trim()
  if (!trimmed) {
    return loadCustomChiefComplaints(clinicId)
  }

  const existingCustom = loadCustomChiefComplaints(clinicId)
  const isDefault = complaintOptions.some(
    (opt) => opt.trim().toLowerCase() === trimmed.toLowerCase(),
  )
  const isAlreadyCustom = existingCustom.some(
    (c) => c.trim().toLowerCase() === trimmed.toLowerCase(),
  )

  if (!isDefault && !isAlreadyCustom) {
    const updated = [...existingCustom, trimmed]
    saveCustomChiefComplaints(updated, clinicId)
    return updated
  }

  return existingCustom
}

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

export const DEFAULT_DIAGNOSIS_OPTIONS: readonly string[] = diagnosisOptions

export const loadCustomDiagnoses = (clinicId?: string): string[] => {
  if (typeof window === "undefined" || !window.localStorage) {
    return []
  }
  try {
    const scopedKey = clinicId
      ? `cliniqo-custom-diagnoses_${clinicId}`
      : "cliniqo-custom-diagnoses"
    const raw =
      window.localStorage.getItem(scopedKey) ||
      window.localStorage.getItem("cliniqo-custom-diagnoses")
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (item): item is string =>
            typeof item === "string" && item.trim().length > 0,
        )
      }
    }
  } catch {}
  return []
}

export const saveCustomDiagnoses = (
  customList: string[],
  clinicId?: string,
): void => {
  if (typeof window === "undefined" || !window.localStorage) return
  try {
    const scopedKey = clinicId
      ? `cliniqo-custom-diagnoses_${clinicId}`
      : "cliniqo-custom-diagnoses"
    const cleaned: string[] = []
    const seen = new Set<string>()
    for (const d of customList) {
      if (typeof d !== "string") continue
      const trimmed = d.trim()
      const lower = trimmed.toLowerCase()
      if (trimmed && !seen.has(lower)) {
        seen.add(lower)
        cleaned.push(trimmed)
      }
    }
    const raw = JSON.stringify(cleaned)
    if (clinicId) {
      window.localStorage.setItem(scopedKey, raw)
    }
    window.localStorage.setItem("cliniqo-custom-diagnoses", raw)
  } catch {}
}

export const getDiagnosisOptions = (
  customDiagnoses: string[] = [],
): string[] => {
  const result = [...diagnosisOptions]
  const existingSet = new Set(
    diagnosisOptions.map((d) => d.trim().toLowerCase()),
  )

  for (const custom of customDiagnoses) {
    if (typeof custom !== "string") continue
    const trimmed = custom.trim()
    if (!trimmed) continue
    const lower = trimmed.toLowerCase()
    if (!existingSet.has(lower)) {
      existingSet.add(lower)
      result.push(trimmed)
    }
  }
  return result
}

export const addCustomDiagnosis = (
  diagnosis: string,
  clinicId?: string,
): string[] => {
  if (typeof diagnosis !== "string") {
    return loadCustomDiagnoses(clinicId)
  }
  const trimmed = diagnosis.trim()
  if (!trimmed) {
    return loadCustomDiagnoses(clinicId)
  }

  const existingCustom = loadCustomDiagnoses(clinicId)
  const isDefault = diagnosisOptions.some(
    (opt) => opt.trim().toLowerCase() === trimmed.toLowerCase(),
  )
  const isAlreadyCustom = existingCustom.some(
    (d) => d.trim().toLowerCase() === trimmed.toLowerCase(),
  )

  if (!isDefault && !isAlreadyCustom) {
    const updated = [...existingCustom, trimmed]
    saveCustomDiagnoses(updated, clinicId)
    return updated
  }

  return existingCustom
}

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
  Frequencies: [
    "Once daily",
    "Twice daily",
    "Three times daily",
    "Four times daily",
    "As needed",
  ],
  FoodInstructions: [
    "Before food",
    "After food",
    "With food",
  ],
  MedicineDefinitions: [],
}

export function mergeCustomLibraryValues(
  defaultList: readonly string[],
  customList: string[],
): string[] {
  const result = [...defaultList]
  const seen = new Set(defaultList.map((x) => x.trim().toLowerCase()))
  for (const item of customList) {
    if (typeof item !== "string") continue
    const trimmed = item.trim()
    if (!trimmed) continue
    const lower = trimmed.toLowerCase()
    if (!seen.has(lower)) {
      seen.add(lower)
      result.push(trimmed)
    }
  }
  return result
}

export const saveClinicalLibrary = (
  library: ClinicalLibrary,
  clinicId?: string,
): void => {
  if (typeof window === "undefined" || !window.localStorage) return
  try {
    const raw = JSON.stringify(library)
    if (clinicId) {
      window.localStorage.setItem(`cliniqo-clinical-library_${clinicId}`, raw)
    }
    window.localStorage.setItem("cliniqo-clinical-library", raw)
  } catch {}
}

export function addClinicalLibraryItem(
  library: ClinicalLibrary,
  category: ClinicalLibraryCategory,
  value: string,
  clinicId?: string,
): ClinicalLibrary {
  const trimmed = value.trim()
  if (!trimmed) return library
  const existing = library[category] || []
  if (existing.some((item) => item.toLowerCase() === trimmed.toLowerCase())) {
    return library
  }
  const updated: ClinicalLibrary = {
    ...library,
    [category]: [...existing, trimmed],
  }
  saveClinicalLibrary(updated, clinicId)
  return updated
}

export const loadClinicalLibrary = (clinicId?: string): ClinicalLibrary => {
  try {
    const scopedKey = clinicId
      ? `cliniqo-clinical-library_${clinicId}`
      : "cliniqo-clinical-library"
    const raw =
      typeof window !== "undefined" && window.localStorage
        ? window.localStorage.getItem(scopedKey) ||
          window.localStorage.getItem("cliniqo-clinical-library")
        : null
    if (!raw) return { ...defaultClinicalLibrary }
    const saved = JSON.parse(raw) as Partial<ClinicalLibrary>
    return {
      Medicines: Array.isArray(saved.Medicines)
        ? saved.Medicines
        : defaultClinicalLibrary.Medicines,
      Formulations: Array.isArray(saved.Formulations)
        ? saved.Formulations
        : defaultClinicalLibrary.Formulations,
      Strengths: Array.isArray(saved.Strengths)
        ? saved.Strengths
        : defaultClinicalLibrary.Strengths,
      Doses: Array.isArray(saved.Doses)
        ? saved.Doses
        : defaultClinicalLibrary.Doses,
      Durations: Array.isArray(saved.Durations)
        ? saved.Durations
        : defaultClinicalLibrary.Durations,
      Frequencies: Array.isArray(saved.Frequencies)
        ? saved.Frequencies
        : defaultClinicalLibrary.Frequencies,
      FoodInstructions: Array.isArray(saved.FoodInstructions)
        ? saved.FoodInstructions
        : defaultClinicalLibrary.FoodInstructions,
      MedicineDefinitions: Array.isArray(saved.MedicineDefinitions)
        ? saved.MedicineDefinitions
        : defaultClinicalLibrary.MedicineDefinitions,
    }
  } catch {
    return { ...defaultClinicalLibrary }
  }
}
