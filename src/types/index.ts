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

export function getIndiaDateTimeLocalString(
  input?: Date | string | null,
): string {
  if (!input) {
    const d = new Date()
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
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
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(input)) {
      return input.slice(0, 16)
    }
  }

  const d = typeof input === "string" ? new Date(input) : input
  if (isNaN(d.getTime())) return ""

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
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

export function formatDateDDMMYYYY(input?: string | Date | null): string {
  if (!input) return ""
  const str = String(input).trim()
  if (!str) return ""
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(str)) return str

  // ISO date like YYYY-MM-DD
  const isoDateMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (isoDateMatch) {
    return `${isoDateMatch[3]}/${isoDateMatch[2]}/${isoDateMatch[1]}`
  }

  // DD-MM-YYYY
  const dashMatch = str.match(/^(\d{2})-(\d{2})-(\d{4})/)
  if (dashMatch) {
    return `${dashMatch[1]}/${dashMatch[2]}/${dashMatch[3]}`
  }

  const d = new Date(str)
  if (isNaN(d.getTime())) return str

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(d)
  const map: Record<string, string> = {}
  for (const p of parts) map[p.type] = p.value
  return `${map.day}/${map.month}/${map.year}`
}

export function formatDateTimeDDMMYYYY(
  input?: string | Date | null,
  includeTime = true,
): string {
  if (!input) return ""
  const d = typeof input === "string" ? new Date(input) : input
  if (!d || isNaN(d.getTime())) {
    return formatDateDDMMYYYY(input)
  }

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
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

export function formatIndiaDateTime(input?: string | null): string {
  return formatDateTimeDDMMYYYY(input, true)
}

export function getPublicPatientId(
  patient?: { displayId?: string; patientCode?: string; id?: string } | null,
): string {
  if (!patient) return ""
  if (patient.displayId && patient.displayId.trim().length > 0) {
    return patient.displayId.trim()
  }
  if (patient.patientCode && patient.patientCode.trim().length > 0) {
    return patient.patientCode.trim()
  }
  return patient.id || ""
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
    const trimmed = rec.patient_code.trim()
    if (trimmed.startsWith("PC-")) {
      displayId = trimmed
    } else if (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        trimmed,
      )
    ) {
      const digits = trimmed.replace(/\D/g, "")
      const numPart =
        digits.length > 0 ? parseInt(digits.slice(0, 4), 10) || 1049 : 1049
      displayId = `PC-${numPart}`
    } else if (trimmed.startsWith("PT-")) {
      displayId = trimmed.replace(/^PT-/i, "PC-")
    } else {
      displayId = `PC-${trimmed}`
    }
  } else {
    const digits = rec.id.replace(/\D/g, "")
    const numPart =
      digits.length > 0 ? parseInt(digits.slice(0, 4), 10) || 1049 : 1049
    displayId = `PC-${numPart}`
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
