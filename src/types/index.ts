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
  syncStatus?: "PENDING" | "SYNCED" | "CONFLICT"
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
  },
  {
    id: "PC-1047",
    name: "Vikram Mehta",
    initials: "VM",
    age: 52,
    gender: "Male",
    phone: "+91 98204 11882",
    lastVisit: "24 Jun 2025",
    allergies: [],
    conditions: ["Hypertension"],
  },
  {
    id: "PC-1046",
    name: "Sana Kapoor",
    initials: "SK",
    age: 28,
    gender: "Female",
    phone: "+91 99876 22109",
    lastVisit: "22 Jun 2025",
    allergies: ["Sulfonamides"],
    conditions: [],
  },
  {
    id: "PC-1045",
    name: "Rohan Shah",
    initials: "RS",
    age: 41,
    gender: "Male",
    phone: "+91 98921 88276",
    lastVisit: "18 Jun 2025",
    allergies: [],
    conditions: ["Type 2 diabetes"],
  },
  {
    id: "PC-1044",
    name: "Meera Nair",
    initials: "MN",
    age: 66,
    gender: "Female",
    phone: "+91 97694 33721",
    lastVisit: "15 Jun 2025",
    allergies: [],
    conditions: ["Osteoarthritis"],
  },
]

export function mapLocalRecordToPatient(rec: LocalPatientRecord): Patient {
  const name = rec.name || "Unnamed Patient"
  const initials =
    name
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase() || "PT"
  const yr = new Date().getFullYear().toString().slice(-2)
  const numPart = rec.id.replace(/\D/g, "").slice(0, 6)
  const fallbackCode = `PT-${yr}-${(numPart || "1").padStart(6, "0")}`
  const displayId =
    rec.patient_code && rec.patient_code.trim().length > 0
      ? rec.patient_code.trim()
      : fallbackCode
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
    syncStatus: rec.sync_status,
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
})

export const getDoseConfig = (formulation: string) => {
  switch (formulation) {
    case "Tablet":
      return { unit: "tablet(s)", step: "0.5", placeholder: "0" }
    case "Capsule":
      return { unit: "capsule(s)", step: "1", placeholder: "0" }
    case "Syrup":
    case "Suspension":
    case "Injection":
      return { unit: "mL", step: "0.5", placeholder: "0" }
    case "Cream":
    case "Ointment":
      return { unit: "application(s)", step: "1", placeholder: "0" }
    case "Drops":
      return { unit: "drop(s)", step: "1", placeholder: "0" }
    case "Inhaler":
      return { unit: "puff(s)", step: "1", placeholder: "0" }
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
])
export const topicalFormulations = new Set(["Cream", "Ointment"])

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
    "Suspension",
    "Injection",
    "Cream",
    "Ointment",
    "Drops",
    "Inhaler",
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
    return { ...defaultClinicalLibrary, ...saved }
  } catch {
    return defaultClinicalLibrary
  }
}
