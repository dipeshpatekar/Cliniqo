import { useState, useEffect, useRef, type ReactNode } from "react"
import { Menu, RefreshCw } from "lucide-react"

// Re-export utility functions for backward compatibility with existing tests
export { computeBillTotals, validateMedicineFormulation } from "./utils/billing"
export {
  emptyMedicine,
  createEmptyConsultationData,
  formatMedicineDose,
  getDoseConfig,
  mapLocalRecordToPatient,
  initialPatients,
} from "./types"

import type {
  Page,
  Patient,
  Vitals,
  ConsultationData,
  ClinicalLibrary,
  ClinicalLibraryCategory,
  ClinicalMedicineDefinition,
  BillData,
  BillItem,
  BillLayoutPreferences,
  PatientFormFieldPreferences,
} from "./types"
import {
  createEmptyConsultationData,
  loadClinicalLibrary,
  loadPatientFormFieldPreferences,
  savePatientFormFieldPreferences,
  loadPrescriptionLayoutPreferences,
  savePrescriptionLayoutPreferences,
  loadBillLayoutPreferences,
  saveBillLayoutPreferences,
  mapLocalRecordToPatient,
  initialPatients,
  formatSequentialPatientId,
  parseSequentialPatientId,
  loadCustomChiefComplaints,
  saveCustomChiefComplaints,
  addCustomChiefComplaint,
  complaintOptions,
} from "./types"
import { cn } from "./utils/cn"

// Components
import { IconButton, ShortcutGuideModal } from "./components/common"
import { Sidebar, Logo } from "./components/layout"
import { Login, Register, Setup } from "./components/auth"
import { Dashboard } from "./components/dashboard"
import {
  PatientsPage,
  PatientProfile,
  PatientForm,
} from "./components/patients"
import { Consultation, PrescriptionPreview } from "./components/consultation"
import { BillForm, BillPreview } from "./components/billing"
import { SettingsPage } from "./components/settings"
import { ConflictResolutionModal } from "./components/ConflictResolutionModal"
import { dispatchShortcutEvent } from "./utils/keyboardShortcuts"

// Native Desktop Bridge
import {
  isTauriDesktop,
  getDesktopSession,
  hasPersistedRefreshToken,
  refreshDesktopSession,
  restoreOfflineDesktopSession,
  logoutDesktopSession,
  getLocalPatients,
  getNextPatientCode,
  saveLocalPatient,
  deleteLocalPatient,
  getLocalFormulary,
  getSyncStatus,
  startCatalogueSync,
  getInventoryStockSummary,
  importInventoryStock,
  getLocalConsultations,
  reviseLocalPrescription,
  type DesktopSessionContext,
  type LocalInvoiceRecord,
  type LocalPrescriptionRecord,
  PatientSaveError,
  type LocalConsultationRecord,
} from "./desktop/desktop-bridge"
import stockReportData from "./data/stock-report-18-10-26.json"
import {
  resolvePrescriptionPreviewNavigation,
  resolveBillPreviewNavigation,
  shouldClearHistoricalPrescriptionOnNavigation,
  reconstructHistoricalPrescription,
  computePrescriptionPreviewState,
  executePrescriptionRevision,
  type PrescriptionPreviewReturnPage,
  type BillPreviewReturnPage,
  type ViewingHistoricalPrescriptionState,
} from "./routing/prescriptionRouting"

export type { PrescriptionPreviewReturnPage, BillPreviewReturnPage, ViewingHistoricalPrescriptionState }

export interface AppProps {
  initialPage?: Page
  initialDesktopSession?: DesktopSessionContext | null
  initialSelectedPatient?: Patient
  initialViewingHistoricalPrescription?: ViewingHistoricalPrescriptionState | null
  initialPrescriptionPreviewReturnPage?: PrescriptionPreviewReturnPage
  initialPatientProfileTab?: string
}

const SAMPLE_PREVIEW_PATIENT: Patient = {
  id: "sample-patient-preview",
  displayId: "SAMPLE-001",
  patientCode: "SAMPLE-001",
  name: "Sample Patient",
  initials: "SP",
  age: 35,
  gender: "Female",
  phone: "+91 98765 43210",
  lastVisit: "Today",
  allergies: ["Penicillin", "Sulfa drugs"],
  conditions: ["Hypertension (Mild)"],
  address: "123 Healthcare Boulevard, Medical District",
  registeredAt: "2026-01-15T09:00:00Z",
}

const SAMPLE_PREVIEW_VITALS: Vitals = {
  systolic: "120",
  diastolic: "80",
  heartRate: "72",
  spo2: "99",
  temperature: "98.4",
  height: "165",
  weight: "62",
}

const SAMPLE_PREVIEW_CONSULTATION: ConsultationData = {
  date: "09/11/2026",
  time: "10:30 AM",
  chiefComplaint: "Mild headache and seasonal throat irritation for 2 days",
  symptomDuration: "2 days",
  diagnosis: "Acute Upper Respiratory Tract Irritation / Tension Headache",
  followUpDate: "In 5 days",
  followUpInstructions:
    "Stay hydrated, take plenty of rest, and follow up if symptoms persist.",
  allergies: ["Penicillin", "Sulfa drugs"],
  conditions: ["Hypertension (Mild)"],
  medicines: [
    {
      id: 101,
      name: "Paracetamol 650mg",
      formulation: "Tablet",
      strength: "650mg",
      dose: "1 Tab",
      route: "Oral",
      frequency: "1-0-1",
      duration: "3 Days",
      food: "After Food",
      directions: "Take after meals with water",
    },
    {
      id: 102,
      name: "Cetirizine 10mg",
      formulation: "Tablet",
      strength: "10mg",
      dose: "1 Tab",
      route: "Oral",
      frequency: "0-0-1",
      duration: "5 Days",
      food: "At Bedtime",
      directions: "Take at night before sleep",
    },
  ],
}

const SAMPLE_PREVIEW_BILL: BillData = {
  id: "sample-bill-preview",
  invoiceNumber: "INV-SAMPLE-001",
  date: "2026-11-09",
  status: "FINALIZED",
  paymentStatus: "Paid",
  discount: 10,
  taxRatePercent: 0,
  notes: "Sample preview invoice. Thank you for your consultation!",
  items: [
    {
      id: 1,
      description: "General Consultation & Clinical Review",
      quantity: 1,
      rate: 500,
    },
    {
      id: 2,
      description: "Diagnostic Vitals Assessment",
      quantity: 1,
      rate: 150,
    },
  ],
}

export default function App({
  initialPage = "login",
  initialDesktopSession = null,
  initialSelectedPatient,
  initialViewingHistoricalPrescription = null,
  initialPrescriptionPreviewReturnPage = "consultation",
  initialPatientProfileTab = "Overview",
}: AppProps = {}) {
  const [page, setPage] = useState<Page>(initialPage)
  const [desktopSession, setDesktopSession] =
    useState<DesktopSessionContext | null>(initialDesktopSession)
  const desktopSessionRef = useRef<DesktopSessionContext | null>(initialDesktopSession)
  const [onboardingDoctor, setOnboardingDoctor] = useState<{
    id: string
    email: string
    fullName: string
    phone?: string
    accessToken: string
    refreshToken?: string
  } | null>(null)
  const onboardingDoctorRef = useRef<{
    id: string
    email: string
    fullName: string
    phone?: string
    accessToken: string
    refreshToken?: string
  } | null>(null)
  const isStartingConsultationRef = useRef(false)
  const isSavingPatientRef = useRef(false)
  const [isRestoringSession, setIsRestoringSession] =
    useState<boolean>(isTauriDesktop)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true)
  const [patientRecords, setPatientRecords] = useState<Patient[]>(() =>
    isTauriDesktop() ? [] : initialPatients,
  )
  const [selectedPatient, setSelectedPatient] = useState<Patient>(() =>
    initialSelectedPatient ||
    (isTauriDesktop()
      ? {
          id: "PT-INIT",
          name: "No patient selected",
          initials: "--",
          age: 0,
          gender: "Other",
          phone: "",
          lastVisit: "No visits yet",
          allergies: [],
          conditions: [],
        }
      : initialPatients[0]),
  )
  const [editingPatient, setEditingPatient] = useState<Patient | null>(null)
  const [newPatientFormKey, setNewPatientFormKey] = useState(0)
  const [patientSaveFeedback, setPatientSaveFeedback] =
    useState<"added" | "updated" | null>(null)
  const [settingsKey, setSettingsKey] = useState(0)
  const [settingsInitialTab, setSettingsInitialTab] = useState("Doctor profile")
  const [prescriptionPreviewReturnPage, setPrescriptionPreviewReturnPage] =
    useState<PrescriptionPreviewReturnPage>(initialPrescriptionPreviewReturnPage)
  const [viewingHistoricalPrescription, setViewingHistoricalPrescription] =
    useState<ViewingHistoricalPrescriptionState | null>(initialViewingHistoricalPrescription)
  const [patientProfileTab, setPatientProfileTab] = useState(initialPatientProfileTab)
  const [activeConsultationPrescriptionRecord, setActiveConsultationPrescriptionRecord] =
    useState<LocalPrescriptionRecord | null>(null)
  const [billPreviewReturnPage, setBillPreviewReturnPage] =
    useState<"bill-form" | "settings" | "patient-profile">("bill-form")
  const [vitals, setVitals] = useState<Vitals>({
    systolic: "",
    diastolic: "",
    heartRate: "",
    spo2: "",
    temperature: "",
    height: "",
    weight: "",
  })
  const [consultationData, setConsultationData] = useState<ConsultationData>(
    createEmptyConsultationData,
  )
  const [darkMode, setDarkMode] = useState(
    () => window.localStorage.getItem("cliniqo-theme") === "dark",
  )
  const [clinicalLibrary, setClinicalLibrary] =
    useState<ClinicalLibrary>(loadClinicalLibrary)
  const initialRxPrefs = loadPrescriptionLayoutPreferences()
  const [prescriptionBannerVisible, setPrescriptionBannerVisible] = useState(
    initialRxPrefs.bannerVisible,
  )
  const [prescriptionBannerImage, setPrescriptionBannerImage] = useState<{
    src: string
    name: string
  } | null>(initialRxPrefs.bannerImage)
  const [doctorSignatureImage, setDoctorSignatureImage] = useState<{
    src: string
    name: string
  } | null>(initialRxPrefs.signatureImage)
  const [showClinicLogo, setShowClinicLogo] = useState(
    initialRxPrefs.showClinicLogo,
  )
  const [showClinicEmail, setShowClinicEmail] = useState(
    initialRxPrefs.showClinicEmail,
  )
  const [showAllergyWarning, setShowAllergyWarning] = useState(
    initialRxPrefs.showAllergyWarning,
  )
  const [prescriptionTopSpacingMm, setPrescriptionTopSpacingMm] =
    useState<number>(() => initialRxPrefs.topSpacingMm || 0)
  const [billLayout, setBillLayout] = useState<BillLayoutPreferences>(() =>
    loadBillLayoutPreferences(),
  )
  const [billData, setBillData] = useState<BillData>({
    invoiceNumber: "INV-2025-1048",
    date: "2025-07-01",
    status: "DRAFT",
    paymentStatus: "Unpaid",
    discount: 0,
    taxRatePercent: 0,
    items: [{ id: 1, description: "Consultation fee", quantity: 1, rate: 800 }],
  })
  const [patientFormFieldPreferences, setPatientFormFieldPreferences] =
    useState<PatientFormFieldPreferences>(() =>
      loadPatientFormFieldPreferences(),
    )
  const [customChiefComplaints, setCustomChiefComplaints] = useState<string[]>(
    () => loadCustomChiefComplaints(desktopSession?.clinic_id),
  )

  const handleAddCustomChiefComplaint = (complaint: string) => {
    const updated = addCustomChiefComplaint(
      complaint,
      desktopSession?.clinic_id,
    )
    setCustomChiefComplaints(updated)
  }

  useEffect(() => {
    if (!desktopSession?.clinic_id) return
    const clinicId = desktopSession.clinic_id
    const clinicRxPrefs = loadPrescriptionLayoutPreferences(clinicId)
    setPrescriptionBannerVisible(clinicRxPrefs.bannerVisible)
    if (clinicRxPrefs.bannerImage) setPrescriptionBannerImage(clinicRxPrefs.bannerImage)
    if (clinicRxPrefs.signatureImage) setDoctorSignatureImage(clinicRxPrefs.signatureImage)
    setShowClinicLogo(clinicRxPrefs.showClinicLogo)
    setShowClinicEmail(clinicRxPrefs.showClinicEmail)
    setShowAllergyWarning(clinicRxPrefs.showAllergyWarning)
    setPrescriptionTopSpacingMm(clinicRxPrefs.topSpacingMm || 0)

    const clinicBillPrefs = loadBillLayoutPreferences(clinicId)
    setBillLayout(clinicBillPrefs)

    const clinicPatientFormPrefs = loadPatientFormFieldPreferences(clinicId)
    setPatientFormFieldPreferences(clinicPatientFormPrefs)

    setCustomChiefComplaints(loadCustomChiefComplaints(clinicId))
  }, [desktopSession?.clinic_id])

  useEffect(() => {
    if (typeof window === "undefined") return
    const handleProfileUpdate = (e: Event) => {
      const customEvent = e as CustomEvent
      const detail = customEvent.detail
      if (!detail) return
      if (detail.type === "doctor" && detail.profile?.full_name) {
        setDesktopSession((prev) =>
          prev ? { ...prev, doctor_name: detail.profile.full_name } : prev,
        )
        if (desktopSessionRef.current) {
          desktopSessionRef.current = {
            ...desktopSessionRef.current,
            doctor_name: detail.profile.full_name,
          }
        }
      }
      if (detail.type === "clinic" && detail.profile?.name) {
        setDesktopSession((prev) =>
          prev ? { ...prev, clinic_name: detail.profile.name } : prev,
        )
        if (desktopSessionRef.current) {
          desktopSessionRef.current = {
            ...desktopSessionRef.current,
            clinic_name: detail.profile.name,
          }
        }
      }
    }

    window.addEventListener("cliniqo:profile-updated", handleProfileUpdate)
    return () => {
      window.removeEventListener("cliniqo:profile-updated", handleProfileUpdate)
    }
  }, [])

  const updatePrescriptionBannerVisible = (visible: boolean) => {
    setPrescriptionBannerVisible(visible)
    savePrescriptionLayoutPreferences(
      {
        bannerVisible: visible,
        showClinicLogo,
        showClinicEmail,
        showAllergyWarning,
        topSpacingMm: prescriptionTopSpacingMm,
        bannerImage: prescriptionBannerImage,
        signatureImage: doctorSignatureImage,
      },
      desktopSession?.clinic_id,
    )
  }

  const updatePrescriptionBannerImage = (
    image: { src: string; name: string } | null,
  ) => {
    setPrescriptionBannerImage(image)
    savePrescriptionLayoutPreferences(
      {
        bannerVisible: prescriptionBannerVisible,
        showClinicLogo,
        showClinicEmail,
        showAllergyWarning,
        topSpacingMm: prescriptionTopSpacingMm,
        bannerImage: image,
        signatureImage: doctorSignatureImage,
      },
      desktopSession?.clinic_id,
    )
  }

  const updateDoctorSignatureImage = (
    image: { src: string; name: string } | null,
  ) => {
    setDoctorSignatureImage(image)
    savePrescriptionLayoutPreferences(
      {
        bannerVisible: prescriptionBannerVisible,
        showClinicLogo,
        showClinicEmail,
        showAllergyWarning,
        topSpacingMm: prescriptionTopSpacingMm,
        bannerImage: prescriptionBannerImage,
        signatureImage: image,
      },
      desktopSession?.clinic_id,
    )
  }

  const updateShowClinicLogo = (visible: boolean) => {
    setShowClinicLogo(visible)
    savePrescriptionLayoutPreferences(
      {
        bannerVisible: prescriptionBannerVisible,
        showClinicLogo: visible,
        showClinicEmail,
        showAllergyWarning,
        topSpacingMm: prescriptionTopSpacingMm,
        bannerImage: prescriptionBannerImage,
        signatureImage: doctorSignatureImage,
      },
      desktopSession?.clinic_id,
    )
  }

  const updateShowClinicEmail = (visible: boolean) => {
    setShowClinicEmail(visible)
    savePrescriptionLayoutPreferences(
      {
        bannerVisible: prescriptionBannerVisible,
        showClinicLogo,
        showClinicEmail: visible,
        showAllergyWarning,
        topSpacingMm: prescriptionTopSpacingMm,
        bannerImage: prescriptionBannerImage,
        signatureImage: doctorSignatureImage,
      },
      desktopSession?.clinic_id,
    )
  }

  const updateShowAllergyWarning = (visible: boolean) => {
    setShowAllergyWarning(visible)
    savePrescriptionLayoutPreferences(
      {
        bannerVisible: prescriptionBannerVisible,
        showClinicLogo,
        showClinicEmail,
        showAllergyWarning: visible,
        topSpacingMm: prescriptionTopSpacingMm,
        bannerImage: prescriptionBannerImage,
        signatureImage: doctorSignatureImage,
      },
      desktopSession?.clinic_id,
    )
  }

  const updatePrescriptionTopSpacingMm = (spacing: number) => {
    const clamped = Math.max(0, Math.min(60, spacing))
    setPrescriptionTopSpacingMm(clamped)
    savePrescriptionLayoutPreferences(
      {
        bannerVisible: prescriptionBannerVisible,
        showClinicLogo,
        showClinicEmail,
        showAllergyWarning,
        topSpacingMm: clamped,
        bannerImage: prescriptionBannerImage,
        signatureImage: doctorSignatureImage,
      },
      desktopSession?.clinic_id,
    )
  }

  const updateBillLayout = (layout: BillLayoutPreferences) => {
    setBillLayout(layout)
    saveBillLayoutPreferences(layout, desktopSession?.clinic_id)
  }

  const updatePatientFormFieldPreferences = (
    prefs: PatientFormFieldPreferences,
  ) => {
    setPatientFormFieldPreferences(prefs)
    savePatientFormFieldPreferences(prefs, desktopSession?.clinic_id)
  }

  const updatePatientMedicalInfo = (
    allergies: string[],
    conditions: string[],
  ) => {
    setSelectedPatient((prev) => ({ ...prev, allergies, conditions }))
    setPatientRecords((prev) =>
      prev.map((p) =>
        p.id === selectedPatient.id ? { ...p, allergies, conditions } : p,
      ),
    )
    if (isTauriDesktop() && desktopSession?.clinic_id) {
      saveLocalPatient({
        id: selectedPatient.id,
        clinic_id: desktopSession.clinic_id,
        patient_code: selectedPatient.displayId || selectedPatient.id,
        name: selectedPatient.name,
        phone: selectedPatient.phone,
        gender: selectedPatient.gender,
        date_of_birth: selectedPatient.dateOfBirth || null,
        age: selectedPatient.age,
        allergies,
        conditions,
      }).catch(console.error)
    }
  }

  const [maxAllocatedSeq, setMaxAllocatedSeq] = useState<number>(() => {
    if (typeof window !== "undefined" && window.localStorage) {
      const stored =
        window.localStorage.getItem(
          `cliniqo_last_patient_seq_${desktopSession?.clinic_id || "default"}`,
        ) || window.localStorage.getItem("cliniqo_last_patient_seq")
      if (stored) {
        const parsed = parseInt(stored, 10)
        if (!isNaN(parsed) && parsed > 0) return parsed
      }
    }
    return 0
  })

  // Determine highest sequential number among existing patient records
  const highestSeqInRecords = Math.max(
    0,
    ...patientRecords.map((p) => {
      const raw = p.displayId || p.patientCode || p.id || ""
      return parseSequentialPatientId(raw) || 0
    }),
  )

  const effectiveMaxSeq = Math.max(maxAllocatedSeq, highestSeqInRecords)

  useEffect(() => {
    if (effectiveMaxSeq > maxAllocatedSeq) {
      setMaxAllocatedSeq(effectiveMaxSeq)
      if (typeof window !== "undefined" && window.localStorage) {
        const key = `cliniqo_last_patient_seq_${desktopSession?.clinic_id || "default"}`
        window.localStorage.setItem(key, String(effectiveMaxSeq))
        window.localStorage.setItem(
          "cliniqo_last_patient_seq",
          String(effectiveMaxSeq),
        )
      }
    }
  }, [effectiveMaxSeq, maxAllocatedSeq, desktopSession?.clinic_id])

  const nextPatientId = formatSequentialPatientId(effectiveMaxSeq + 1)

  useEffect(() => {
    if (!isTauriDesktop() || !desktopSession?.clinic_id) return
    getNextPatientCode(desktopSession.clinic_id)
      .then((code) => {
        if (code) {
          const seq = parseSequentialPatientId(code)
          if (seq && seq > 1) {
            setMaxAllocatedSeq((prev) => Math.max(prev, seq - 1))
          }
        }
      })
      .catch(() => {})
  }, [desktopSession?.clinic_id])
  const [showConflictModal, setShowConflictModal] = useState(false)
  const [showShortcutsModal, setShowShortcutsModal] = useState(false)
  const [targetConflictId, setTargetConflictId] = useState<string | null>(null)
  const [conflictsCount, setConflictsCount] = useState(0)

  // Poll sync status to keep conflict count updated in desktop mode
  useEffect(() => {
    if (!isTauriDesktop() || !desktopSession?.clinic_id) return
    let mounted = true
    const updateConflictCount = async () => {
      try {
        const st = await getSyncStatus()
        if (mounted && st) {
          setConflictsCount(st.conflicts_count)
        }
      } catch {
        // Safe closed
      }
    }
    updateConflictCount()
    const interval = setInterval(updateConflictCount, 3000)
    return () => {
      mounted = false
      clearInterval(interval)
    }
  }, [desktopSession?.clinic_id])

  const handleOpenConflicts = (conflictId?: string) => {
    setTargetConflictId(conflictId || null)
    setShowConflictModal(true)
  }

  const handleConflictResolved = async () => {
    if (desktopSession?.clinic_id) {
      try {
        const localPatients = await getLocalPatients(desktopSession.clinic_id)
        if (localPatients) {
          const mapped = localPatients.map(mapLocalRecordToPatient)
          setPatientRecords(mapped)
          setSelectedPatient((current) => {
            const found = mapped.find((p) => p.id === current.id)
            return found || current
          })
        }
        const st = await getSyncStatus()
        if (st) {
          setConflictsCount(st.conflicts_count)
        }
      } catch (err) {
        console.warn(
          "[Cliniqo Desktop] Failed to refresh local state after conflict resolution:",
          err,
        )
      }
    }
  }

  const loadAndMergeLocalFormulary = async (clinicId: string) => {
    try {
      if (isTauriDesktop()) {
        try {
          const summary = await getInventoryStockSummary(clinicId)
          if (!summary || summary.total_products === 0) {
            await importInventoryStock(clinicId, stockReportData as any, false)
          }
        } catch {}
      }
      const items = await getLocalFormulary(clinicId)
      if (items && items.length > 0) {
        setClinicalLibrary((prevLibrary) => {
          let updated = false
          const defs = [...prevLibrary.MedicineDefinitions]
          const meds = [...prevLibrary.Medicines]

          for (const item of items) {
            const trimmedName = item.name.trim()
            const trimmedFormulation = item.formulation.trim()
            const trimmedStrength = (item.strength || "").trim()

            const idx = defs.findIndex(
              (d) =>
                d.name.trim().toLowerCase() === trimmedName.toLowerCase() &&
                d.formulation.trim().toLowerCase() ===
                  trimmedFormulation.toLowerCase() &&
                (d.strength || "").trim().toLowerCase() ===
                  trimmedStrength.toLowerCase(),
            )

            if (idx === -1) {
              defs.push({
                id: item.id,
                name: trimmedName,
                formulation: trimmedFormulation,
                strength: trimmedStrength,
                activeIngredient: item.active_ingredient || undefined,
                defaultDosage: item.default_dosage || undefined,
                defaultRoute: item.default_route || undefined,
                defaultFrequency: item.default_frequency || undefined,
                defaultDuration: item.default_duration || undefined,
                defaultInstructions: item.default_instructions || undefined,
              })
              if (
                !meds.some(
                  (m) => m.trim().toLowerCase() === trimmedName.toLowerCase(),
                )
              ) {
                meds.push(trimmedName)
              }
              updated = true
            } else if (item.active_ingredient && !defs[idx].activeIngredient) {
              defs[idx] = {
                ...defs[idx],
                activeIngredient: item.active_ingredient,
              }
              updated = true
            }
          }

          if (!updated) return prevLibrary
          return {
            ...prevLibrary,
            Medicines: meds,
            MedicineDefinitions: defs,
          }
        })
      }
    } catch (err) {
      console.warn("[Cliniqo Desktop] Failed to load local formulary:", err)
    }
  }

  const loadAndMergeChiefComplaints = async (clinicId: string) => {
    if (!isTauriDesktop()) return
    try {
      const consultations = await getLocalConsultations(clinicId)
      if (Array.isArray(consultations) && consultations.length > 0) {
        let changed = false
        const currentCustom = loadCustomChiefComplaints(clinicId)
        const currentSet = new Set([
          ...complaintOptions.map((c) => c.trim().toLowerCase()),
          ...currentCustom.map((c) => c.trim().toLowerCase()),
        ])
        const toAdd: string[] = []
        for (const c of consultations) {
          const comp = c.chief_complaint?.trim()
          if (comp && !currentSet.has(comp.toLowerCase())) {
            currentSet.add(comp.toLowerCase())
            toAdd.push(comp)
            changed = true
          }
        }
        if (changed) {
          const merged = [...currentCustom, ...toAdd]
          saveCustomChiefComplaints(merged, clinicId)
          setCustomChiefComplaints(merged)
        }
      }
    } catch (err) {
      console.warn(
        "[Cliniqo Desktop] Failed to load local chief complaints:",
        err,
      )
    }
  }

  // Desktop session bootstrap: check active in-memory session or restore via DPAPI refresh token
  useEffect(() => {
    if (!isTauriDesktop()) return

    let mounted = true

    const applyRestoredSession = async (restored: {
      session: DesktopSessionContext
      clinics: any[]
      active_clinic_id: string
    }) => {
      desktopSessionRef.current = restored.session
      setDesktopSession(restored.session)
      if (restored.clinics.length > 0 && restored.session.clinic_id) {
        try {
          const localPatients = await getLocalPatients(
            restored.session.clinic_id,
          )
          if (localPatients && localPatients.length > 0) {
            const mapped = localPatients.map(mapLocalRecordToPatient)
            setPatientRecords(mapped)
            setSelectedPatient(mapped[0])
          } else {
            setPatientRecords([])
          }
        } catch (err) {
          console.warn("[Cliniqo Desktop] Failed to load local patients:", err)
        }
        setPage((curr) =>
          curr === "login" || curr === "register" ? "dashboard" : curr,
        )
        loadAndMergeLocalFormulary(restored.session.clinic_id).catch(() => {})
        loadAndMergeChiefComplaints(restored.session.clinic_id).catch(() => {})
        startCatalogueSync().catch(() => {})
      } else {
        // Incomplete onboarding: restored refresh token valid, but 0 clinics -> resume setup!
        const doctorData = {
          id: restored.session.doctor_id,
          email: restored.session.doctor_email,
          fullName: restored.session.doctor_name,
          accessToken: "",
        }
        onboardingDoctorRef.current = doctorData
        setOnboardingDoctor(doctorData)
        setPage("setup")
      }
      setIsRestoringSession(false)
    }

    async function bootstrapDesktopSession() {
      try {
        const active = await getDesktopSession()
        const nowSec = Math.floor(Date.now() / 1000)
        if (active && (active.is_offline || active.expires_at > nowSec)) {
          if (mounted) {
            desktopSessionRef.current = active
            setDesktopSession(active)
            if (active.clinic_id) {
              try {
                const localPatients = await getLocalPatients(active.clinic_id)
                if (localPatients && localPatients.length > 0) {
                  const mapped = localPatients.map(mapLocalRecordToPatient)
                  setPatientRecords(mapped)
                  setSelectedPatient(mapped[0])
                } else {
                  setPatientRecords([])
                }
              } catch (err) {
                console.warn(
                  "[Cliniqo Desktop] Failed to load local patients:",
                  err,
                )
              }
              setPage((curr) =>
                curr === "login" || curr === "register" ? "dashboard" : curr,
              )
              loadAndMergeLocalFormulary(active.clinic_id).catch(() => {})
              loadAndMergeChiefComplaints(active.clinic_id).catch(() => {})
              startCatalogueSync().catch(() => {})
            } else {
              // Incomplete onboarding: session established but clinic not created yet
              const doctorData = {
                id: active.doctor_id,
                email: active.doctor_email,
                fullName: active.doctor_name,
                accessToken: "",
              }
              onboardingDoctorRef.current = doctorData
              setOnboardingDoctor(doctorData)
              setPage("setup")
            }
            setIsRestoringSession(false)
          }
          return
        }

        const hasToken = await hasPersistedRefreshToken()
        if (hasToken) {
          const restored = await refreshDesktopSession()
          if (restored && mounted) {
            await applyRestoredSession(restored)
            return
          }

          // Fallback to offline session restoration if online refresh couldn't proceed
          const offlineRestored = await restoreOfflineDesktopSession()
          if (offlineRestored && mounted) {
            await applyRestoredSession(offlineRestored)
            return
          }
        }

        if (mounted) {
          desktopSessionRef.current = null
          setDesktopSession(null)
          onboardingDoctorRef.current = null
          setOnboardingDoctor(null)
          setPage("login")
          setIsRestoringSession(false)
        }
      } catch (err) {
        console.warn("[Cliniqo Desktop] Session bootstrap error:", err)
        if (mounted) {
          try {
            const offlineRestored = await restoreOfflineDesktopSession()
            if (offlineRestored) {
              await applyRestoredSession(offlineRestored)
              return
            }
          } catch {}

          const hasToken = await hasPersistedRefreshToken().catch(() => false)
          if (!hasToken) {
            desktopSessionRef.current = null
            setDesktopSession(null)
            onboardingDoctorRef.current = null
            setOnboardingDoctor(null)
            setPage("login")
          }
          setIsRestoringSession(false)
        }
      }
    }

    bootstrapDesktopSession()
    return () => {
      mounted = false
    }
  }, [])

  // Proactive background session renewal before access token expiry
  useEffect(() => {
    if (!isTauriDesktop()) return
    const interval = setInterval(async () => {
      const current = desktopSessionRef.current || desktopSession
      if (!current || current.is_offline) return
      const nowSec = Math.floor(Date.now() / 1000)
      if (current.expires_at - nowSec < 180) {
        try {
          const refreshed = await refreshDesktopSession()
          if (refreshed?.session) {
            desktopSessionRef.current = refreshed.session
            setDesktopSession(refreshed.session)
          }
        } catch (e) {
          console.warn("[Cliniqo Desktop] Background proactive refresh:", e)
        }
      }
    }, 60000)
    return () => clearInterval(interval)
  }, [desktopSession])

  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode)
    window.localStorage.setItem("cliniqo-theme", darkMode ? "dark" : "light")
  }, [darkMode])

  useEffect(() => {
    window.localStorage.setItem(
      "cliniqo-clinical-library",
      JSON.stringify(clinicalLibrary),
    )
  }, [clinicalLibrary])

  const go = (next: Page, sessionOverride?: DesktopSessionContext | null) => {
    const effectiveSession =
      sessionOverride !== undefined
        ? sessionOverride
        : desktopSessionRef.current || desktopSession
    const effectiveOnboarding = onboardingDoctorRef.current || onboardingDoctor

    // Desktop Route Guard:
    // When running inside Tauri desktop container, do not allow navigation to protected pages without verified session
    if (
      isTauriDesktop() &&
      !effectiveSession &&
      next !== "login" &&
      next !== "register"
    ) {
      setPage("login")
      return
    }

    if (next === "preview") {
      const { returnPage, clearHistorical, settingsTab } =
        resolvePrescriptionPreviewNavigation(page, prescriptionPreviewReturnPage)
      setPrescriptionPreviewReturnPage(returnPage)
      if (settingsTab) {
        setSettingsInitialTab(settingsTab)
      }
      if (clearHistorical) {
        setViewingHistoricalPrescription(null)
      }
    }
    if (shouldClearHistoricalPrescriptionOnNavigation(next)) {
      setViewingHistoricalPrescription(null)
    }
    if (next === "bill-preview") {
      const { returnPage, settingsTab } =
        resolveBillPreviewNavigation(page, billPreviewReturnPage)
      setBillPreviewReturnPage(returnPage)
      if (settingsTab) {
        setSettingsInitialTab(settingsTab)
      }
    }
    if (next === "patient-form") {
      setEditingPatient(null)
      setNewPatientFormKey((k) => k + 1)
    }
    if (next === "settings" && page !== "preview" && page !== "bill-preview") {
      setSettingsInitialTab("Doctor profile")
    }
    setPage(next)
    setSidebarOpen(false)
    window.scrollTo({ top: 0, behavior: "instant" })
  }

  const logout = async () => {
    if (isTauriDesktop()) {
      try {
        await logoutDesktopSession()
      } catch (err) {
        console.warn("[Cliniqo Desktop] Error during logout:", err)
      }
    }
    desktopSessionRef.current = null
    setDesktopSession(null)
    onboardingDoctorRef.current = null
    setOnboardingDoctor(null)
    setPatientRecords([])
    setSelectedPatient({
      id: "PT-INIT",
      name: "No patient selected",
      initials: "--",
      age: 0,
      gender: "Other",
      phone: "",
      lastVisit: "No visits yet",
      allergies: [],
      conditions: [],
    })
    setConsultationData(createEmptyConsultationData())
    setVitals({
      systolic: "",
      diastolic: "",
      heartRate: "",
      spo2: "",
      temperature: "",
      height: "",
      weight: "",
    })
    go("login", null)
  }

  const openPatient = (patient: Patient) => {
    setSelectedPatient(patient)
    setPatientSaveFeedback(null)
    setConsultationData(createEmptyConsultationData())
    setVitals({
      systolic: "",
      diastolic: "",
      heartRate: "",
      spo2: "",
      temperature: "",
      height: "",
      weight: "",
    })
    setViewingHistoricalPrescription(null)
    setActiveConsultationPrescriptionRecord(null)
    setPatientProfileTab("Overview")
    go("patient-profile")
  }

  const startConsultation = (patient: Patient) => {
    if (isStartingConsultationRef.current) return
    if (!patient || !patient.id || patient.id === "PT-INIT") {
      alert("No valid patient selected for consultation.")
      return
    }
    isStartingConsultationRef.current = true
    try {
      setSelectedPatient(patient)
      setPatientSaveFeedback(null)
      setViewingHistoricalPrescription(null)
      setActiveConsultationPrescriptionRecord(null)
      setConsultationData(createEmptyConsultationData())
      setVitals({
        systolic: "",
        diastolic: "",
        heartRate: "",
        spo2: "",
        temperature: "",
        height: "",
        weight: "",
      })
      go("consultation")
    } finally {
      setTimeout(() => {
        isStartingConsultationRef.current = false
      }, 500)
    }
  }

  const viewHistoricalPrescription = async (
    rx: LocalPrescriptionRecord,
    patient?: Patient,
  ) => {
    const targetPatient = patient || selectedPatient
    setSelectedPatient(targetPatient)

    // Fetch associated consultation to restore diagnosis, chief complaint, vitals, advice
    let matchedConsultation: LocalConsultationRecord | undefined
    if (isTauriDesktop() && desktopSession?.clinic_id) {
      try {
        const cList = await getLocalConsultations(
          desktopSession.clinic_id,
          targetPatient.id,
        )
        matchedConsultation = cList.find(
          (c) =>
            c.id === rx.consultation_id ||
            (c.server_id && c.server_id === rx.consultation_id),
        )
      } catch (err) {
        console.error("Failed to fetch consultations for prescription:", err)
      }
    }

    const {
      consultationData: reconstructedConsultation,
      vitals: parsedVitals,
      itemsError,
    } = reconstructHistoricalPrescription(rx, matchedConsultation)

    setViewingHistoricalPrescription({
      record: rx,
      consultationData: reconstructedConsultation,
      vitals: parsedVitals,
      itemsError,
    })
    setPatientProfileTab("Prescriptions")
    setPrescriptionPreviewReturnPage("patient-profile")
    go("preview")
  }

  const handleRevisePrescription = async (
    medicines: Medicine[],
    reasonForRevision: string,
  ) => {
    if (!viewingHistoricalPrescription?.record) {
      throw new Error("No active historical prescription selected.")
    }
    if (!isTauriDesktop() || !desktopSession?.clinic_id) {
      throw new Error(
        "Active clinic session is required to revise prescriptions.",
      )
    }

    const newRecord = await executePrescriptionRevision({
      currentRecord: viewingHistoricalPrescription.record,
      clinicId: desktopSession.clinic_id,
      patientId: selectedPatient.id,
      medicines,
      reasonForRevision,
    })

    // Update the active historical viewing prescription state without touching global consultationData draft
    setViewingHistoricalPrescription({
      record: newRecord,
      consultationData: {
        ...viewingHistoricalPrescription.consultationData,
        medicines,
      },
      vitals: viewingHistoricalPrescription.vitals,
      itemsError: null,
    })
  }

  const editPatient = (patient: Patient) => {
    setSelectedPatient(patient)
    setPatientSaveFeedback(null)
    setEditingPatient(patient)
    setPage("patient-form")
    setSidebarOpen(false)
    window.scrollTo({ top: 0, behavior: "instant" })
  }

  const startBill = (
    patient: Patient,
    existingInvoice?: LocalInvoiceRecord,
  ) => {
    setSelectedPatient(patient)
    if (existingInvoice) {
      let parsedItems: BillItem[] = []
      try {
        const rawItems = Array.isArray(existingInvoice.items)
          ? existingInvoice.items
          : typeof (existingInvoice as any).items_json === "string"
            ? JSON.parse((existingInvoice as any).items_json)
            : []
        if (Array.isArray(rawItems)) {
          parsedItems = rawItems.map(
            (
              it: {
                description?: string
                quantity?: number
                unit_price_paise?: number
              },
              idx: number,
            ) => ({
              id: idx + 1,
              description: it.description || "",
              quantity: Number(it.quantity) || 1,
              rate:
                Math.round(((Number(it.unit_price_paise) || 0) / 100) * 100) /
                100,
            }),
          )
        }
      } catch {
        parsedItems = [
          { id: 1, description: "Consultation fee", quantity: 1, rate: 800 },
        ]
      }
      setBillData({
        id: existingInvoice.id,
        invoiceNumber: existingInvoice.invoice_number,
        date: existingInvoice.created_at
          ? existingInvoice.created_at.slice(0, 10)
          : new Date().toISOString().slice(0, 10),
        status: existingInvoice.status as "DRAFT" | "FINALIZED" | "CANCELLED",
        paymentStatus:
          existingInvoice.payment_status === "PAID" ? "Paid" : "Unpaid",
        discount:
          Math.round(
            ((Number(existingInvoice.discount_paise) || 0) / 100) * 100,
          ) / 100,
        taxRatePercent: Number(existingInvoice.tax_rate_percent) || 0,
        notes: existingInvoice.notes || "",
        items:
          parsedItems.length > 0
            ? parsedItems
            : [
                {
                  id: 1,
                  description: "Consultation fee",
                  quantity: 1,
                  rate: 800,
                },
              ],
      })
      if (existingInvoice.status === "FINALIZED") {
        setBillPreviewReturnPage("patient-profile")
        go("bill-preview")
      } else {
        go("bill-form")
      }
      return
    }

    const currentYear = new Date().getFullYear()
    const patientNum = patient.id.replace(/\D/g, "") || "1001"
    setBillData({
      invoiceNumber: `INV-${currentYear}-${patientNum}`,
      date: new Date().toISOString().slice(0, 10),
      status: "DRAFT",
      paymentStatus: "Unpaid",
      discount: 0,
      taxRatePercent: 0,
      items: [
        {
          id: Date.now(),
          description: "Consultation fee",
          quantity: 1,
          rate: 800,
        },
      ],
    })
    go("bill-form")
  }

  const savePatient = async (
    patient: Patient,
    startConsultation = false,
    clientMutationId?: string,
  ) => {
    if (isSavingPatientRef.current) return
    isSavingPatientRef.current = true
    try {
      const wasEditing = Boolean(editingPatient)
      let effectivePatient = patient

      if (isTauriDesktop() && desktopSession?.clinic_id) {
        // Proactive token refresh if session is expired or within 60s of expiring
        const nowSec = Math.floor(Date.now() / 1000)
        if (desktopSession.expires_at <= nowSec + 60) {
          try {
            const refreshed = await refreshDesktopSession()
            if (refreshed?.session) {
              desktopSessionRef.current = refreshed.session
              setDesktopSession(refreshed.session)
            }
          } catch (refreshErr) {
            console.warn(
              "[Cliniqo Desktop] Proactive session refresh attempt:",
              refreshErr,
            )
          }
        }

        const publicCode =
          patient.displayId ||
          patient.patientCode ||
          (wasEditing
            ? patient.id
            : /^[A-Z]{3}-\d{4}$/.test(patient.id)
              ? patient.id
              : nextPatientId)

        const notesObj = {
          registeredAt: patient.registeredAt,
          alternatePhone: patient.alternatePhone,
          address: patient.address,
          ageMonths: patient.ageMonths !== undefined ? patient.ageMonths : 0,
        }

        const saveRes = await saveLocalPatient({
          id: wasEditing ? editingPatient?.id : null,
          clinic_id: desktopSession.clinic_id,
          patient_code: publicCode,
          name: patient.name,
          phone: patient.phone,
          gender: patient.gender,
          date_of_birth: patient.dateOfBirth || null,
          age: patient.age,
          allergies: patient.allergies,
          conditions: patient.conditions,
          sensitive_notes: JSON.stringify(notesObj),
          client_mutation_id: clientMutationId || null,
        })

        if (saveRes) {
          const canonicalId = saveRes.id
          const canonicalCode = saveRes.patient_code
          effectivePatient = {
            ...patient,
            id: wasEditing ? patient.id : canonicalId,
            displayId: canonicalCode,
            patientCode: canonicalCode,
            ageMonths: patient.ageMonths !== undefined ? patient.ageMonths : 0,
          }
          try {
            const freshPatients = await getLocalPatients(
              desktopSession.clinic_id,
            )
            if (freshPatients && freshPatients.length > 0) {
              const mapped = freshPatients.map(mapLocalRecordToPatient)
              setPatientRecords(mapped)
              const matched = mapped.find((p) => p.id === canonicalId)
              if (matched) effectivePatient = matched
            }
          } catch {}
        } else {
          throw new PatientSaveError({
            category: "UNKNOWN_SAVE_FAILURE",
            stage: "save_local_patient",
            command: "save_local_patient",
            message: wasEditing
              ? "Desktop bridge returned empty result for patient update."
              : "Desktop bridge returned empty result for patient save.",
            retryable: true,
          })
        }
      }

      if (
        !effectivePatient ||
        !effectivePatient.id ||
        effectivePatient.id === "PT-INIT"
      ) {
        throw new Error(
          "Invalid patient record. Consultation cannot be started.",
        )
      }

      setPatientRecords((records) => [
        effectivePatient,
        ...records.filter(
          (record) =>
            record.id !== patient.id && record.id !== effectivePatient.id,
        ),
      ])
      if (!wasEditing) {
        const publicCode =
          effectivePatient.displayId ||
          effectivePatient.patientCode ||
          effectivePatient.id
        const allocatedSeq = parseSequentialPatientId(publicCode)
        if (allocatedSeq && allocatedSeq > maxAllocatedSeq) {
          setMaxAllocatedSeq(allocatedSeq)
          if (typeof window !== "undefined" && window.localStorage) {
            const key = `cliniqo_last_patient_seq_${desktopSession?.clinic_id || "default"}`
            window.localStorage.setItem(key, String(allocatedSeq))
            window.localStorage.setItem(
              "cliniqo_last_patient_seq",
              String(allocatedSeq),
            )
          }
        }
      }
      setSelectedPatient(effectivePatient)
      setPatientSaveFeedback(
        startConsultation ? null : wasEditing ? "updated" : "added",
      )
      setEditingPatient(null)
      if (startConsultation) {
        setConsultationData(createEmptyConsultationData())
        setVitals({
          systolic: "",
          diastolic: "",
          heartRate: "",
          spo2: "",
          temperature: "",
          height: "",
          weight: "",
        })
      }
      go(startConsultation ? "consultation" : "patient-profile")
    } finally {
      isSavingPatientRef.current = false
    }
  }

  const deletePatient = async (patientId: string) => {
    if (isTauriDesktop() && desktopSession?.clinic_id) {
      try {
        await deleteLocalPatient(desktopSession.clinic_id, patientId)
        const freshPatients = await getLocalPatients(desktopSession.clinic_id)
        if (freshPatients) {
          setPatientRecords(freshPatients.map(mapLocalRecordToPatient))
        }
      } catch (err) {
        console.error(
          "[Cliniqo Desktop] Failed to delete patient from SQLite:",
          err,
        )
      }
    }
    setPatientRecords((records) => records.filter((p) => p.id !== patientId))
    if (selectedPatient?.id === patientId) {
      const remaining = patientRecords.filter((p) => p.id !== patientId)
      if (remaining.length > 0) {
        setSelectedPatient(remaining[0])
      }
    }
    go("patients")
  }

  const handleLoginSuccess = async (session: DesktopSessionContext) => {
    desktopSessionRef.current = session
    setDesktopSession(session)
    if (!session.clinic_id) {
      const doctorData = {
        id: session.doctor_id,
        email: session.doctor_email,
        fullName: session.doctor_name,
        accessToken: "",
      }
      onboardingDoctorRef.current = doctorData
      setOnboardingDoctor(doctorData)
      go("setup", session)
      return
    }

    try {
      const localPatients = await getLocalPatients(session.clinic_id)
      if (localPatients && localPatients.length > 0) {
        const mapped = localPatients.map(mapLocalRecordToPatient)
        setPatientRecords(mapped)
        setSelectedPatient(mapped[0])
      } else {
        setPatientRecords([])
      }
    } catch (err) {
      console.warn(
        "[Cliniqo Desktop] Failed to load local patients on login:",
        err,
      )
    }
    loadAndMergeLocalFormulary(session.clinic_id).catch(() => {})
    loadAndMergeChiefComplaints(session.clinic_id).catch(() => {})
    startCatalogueSync().catch(() => {})
    go("dashboard", session)
  }

  const addLibraryItem = (category: ClinicalLibraryCategory, value: string) => {
    setClinicalLibrary((library) => ({
      ...library,
      [category]: [...library[category], value],
    }))
  }

  const removeLibraryItem = (
    category: ClinicalLibraryCategory,
    value: string,
  ) => {
    setClinicalLibrary((library) => ({
      ...library,
      [category]: (library[category] || []).filter((item) => item !== value),
    }))
  }

  const addMedicineDefinition = (medicine: ClinicalMedicineDefinition) => {
    setClinicalLibrary((library) => {
      const trimmedName = medicine.name.trim()
      const trimmedFormulation = medicine.formulation.trim()
      const trimmedStrength = (medicine.strength || "").trim()

      const existingIndex = library.MedicineDefinitions.findIndex(
        (item) =>
          item.name.trim().toLowerCase() === trimmedName.toLowerCase() &&
          item.formulation.trim().toLowerCase() ===
            trimmedFormulation.toLowerCase() &&
          (item.strength || "").trim().toLowerCase() ===
            trimmedStrength.toLowerCase(),
      )

      if (existingIndex >= 0) {
        const existing = library.MedicineDefinitions[existingIndex]
        const updatedItem: ClinicalMedicineDefinition = {
          ...existing,
          activeIngredient:
            medicine.activeIngredient || existing.activeIngredient,
          defaultDosage: medicine.defaultDosage || existing.defaultDosage,
          defaultRoute: medicine.defaultRoute || existing.defaultRoute,
          defaultFrequency:
            medicine.defaultFrequency || existing.defaultFrequency,
          defaultDuration: medicine.defaultDuration || existing.defaultDuration,
          defaultInstructions:
            medicine.defaultInstructions || existing.defaultInstructions,
        }
        const updatedDefs = [...library.MedicineDefinitions]
        updatedDefs[existingIndex] = updatedItem
        return {
          ...library,
          MedicineDefinitions: updatedDefs,
        }
      }

      return {
        ...library,
        Medicines: library.Medicines.some(
          (item) => item.trim().toLowerCase() === trimmedName.toLowerCase(),
        )
          ? library.Medicines
          : [...library.Medicines, trimmedName],
        MedicineDefinitions: [
          ...library.MedicineDefinitions,
          {
            ...medicine,
            name: trimmedName,
            formulation: trimmedFormulation,
            strength: trimmedStrength,
          },
        ],
      }
    })
  }

  const openDoctorProfile = () => {
    setSettingsKey((key) => key + 1)
    go("settings")
  }

  const updateVital = (key: keyof Vitals, value: string) => {
    setVitals((current) => ({ ...current, [key]: value }))
  }

  // Global Keyboard Shortcuts System
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept when on unauthenticated screens
      if (page === "login" || page === "register" || page === "setup") {
        return
      }

      const isCmdOrCtrl = e.metaKey || e.ctrlKey

      // Esc — Close modal/dropdown
      if (e.key === "Escape") {
        if (showShortcutsModal) {
          e.preventDefault()
          setShowShortcutsModal(false)
          return
        }
        if (showConflictModal) {
          e.preventDefault()
          setShowConflictModal(false)
          return
        }
        dispatchShortcutEvent("escape")
        return
      }

      // Alt + 1-8 — Navigate main sections
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        let digit: number | null = null
        if (e.code && e.code.startsWith("Digit")) {
          digit = parseInt(e.code.replace("Digit", ""), 10)
        } else if (e.key >= "1" && e.key <= "8") {
          digit = parseInt(e.key, 10)
        }
        if (digit !== null && digit >= 1 && digit <= 8) {
          e.preventDefault()
          switch (digit) {
            case 1:
              go("dashboard")
              break
            case 2:
              go("patients")
              break
            case 3:
              go("consultation")
              break
            case 4:
              go("bill-form")
              break
            case 5:
              setSettingsInitialTab("Clinical library")
              go("settings")
              break
            case 6:
              setSettingsInitialTab("Doctor profile")
              go("settings")
              break
            case 7:
              go("patient-profile")
              break
            case 8:
              setEditingPatient(null)
              go("patient-form")
              break
          }
          return
        }
      }

      if (isCmdOrCtrl) {
        const key = e.key.toLowerCase()

        // Ctrl + / — Show shortcut reference
        if (key === "/" || key === "?") {
          e.preventDefault()
          setShowShortcutsModal((prev) => !prev)
          return
        }

        // Ctrl + K — Global patient search
        if (key === "k" && !e.shiftKey) {
          e.preventDefault()
          dispatchShortcutEvent("global-patient-search")
          const searchInput = document.getElementById(
            "global-patient-search",
          ) as HTMLInputElement | null
          if (searchInput) {
            searchInput.focus()
            searchInput.select()
          } else {
            go("dashboard")
            setTimeout(() => {
              dispatchShortcutEvent("global-patient-search")
              const el = document.getElementById(
                "global-patient-search",
              ) as HTMLInputElement | null
              el?.focus()
              el?.select()
            }, 60)
          }
          return
        }

        // Ctrl + S — Save current draft
        if (key === "s" && !e.shiftKey) {
          e.preventDefault()
          dispatchShortcutEvent("save-draft")
          return
        }

        // Ctrl + P — Print current prescription/bill
        if (key === "p" && !e.shiftKey) {
          e.preventDefault()
          if (page === "consultation") {
            go("preview")
          } else if (page === "bill-form") {
            if (billData.status === "FINALIZED") {
              go("bill-preview")
            }
          } else {
            window.print()
          }
          return
        }

        // Ctrl + N — Add patient
        if (key === "n" && !e.shiftKey) {
          e.preventDefault()
          setEditingPatient(null)
          setNewPatientFormKey((k) => k + 1)
          go("patient-form")
          return
        }

        // Ctrl + E — Edit selected patient
        if (key === "e" && !e.shiftKey) {
          e.preventDefault()
          if (selectedPatient && selectedPatient.id !== "PT-INIT") {
            editPatient(selectedPatient)
          }
          return
        }

        // Ctrl + Shift + C — Save & start consultation (ONLY in patient-form and patient-profile)
        if (key === "c" && e.shiftKey) {
          e.preventDefault()
          if (page === "patient-form") {
            dispatchShortcutEvent("save-and-start-consultation")
            return
          }
          if (page === "patient-profile") {
            if (
              !selectedPatient ||
              !selectedPatient.id ||
              selectedPatient.id === "PT-INIT"
            ) {
              alert("No valid patient selected for consultation.")
              return
            }
            startConsultation(selectedPatient)
            return
          }
          // Disabled on Dashboard, Settings, Patient List, Consultation, Billing, and all other screens
          return
        }

        // Ctrl + Shift + M — Add medicine
        if (key === "m" && e.shiftKey) {
          e.preventDefault()
          if (page === "consultation") {
            dispatchShortcutEvent("add-medicine")
          }
          return
        }

        // Ctrl + Shift + V — Focus vitals
        if (key === "v" && e.shiftKey) {
          e.preventDefault()
          if (page === "consultation") {
            dispatchShortcutEvent("focus-vitals")
          }
          return
        }

        // Ctrl + Shift + D — Focus diagnosis
        if (key === "d" && e.shiftKey) {
          e.preventDefault()
          if (page === "consultation") {
            dispatchShortcutEvent("focus-diagnosis")
          }
          return
        }

        // Ctrl + Shift + A — Focus advice
        if (key === "a" && e.shiftKey) {
          e.preventDefault()
          if (page === "consultation") {
            dispatchShortcutEvent("focus-advice")
          }
          return
        }

        // Ctrl + F — Finalize prescription (confirmation required)
        if (key === "f" && !e.shiftKey) {
          if (page === "consultation") {
            e.preventDefault()
            dispatchShortcutEvent("finalize-prescription")
            return
          }
        }

        // Ctrl + ↑ / ↓ — Navigate medicine rows
        if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey) {
          if (page === "consultation") {
            e.preventDefault()
            dispatchShortcutEvent("navigate-medicine-rows", {
              direction: e.key === "ArrowUp" ? "up" : "down",
            })
            return
          }
        }

        // Ctrl + Shift + B — Open billing
        if (key === "b" && e.shiftKey) {
          e.preventDefault()
          if (selectedPatient && selectedPatient.id !== "PT-INIT") {
            startBill(selectedPatient)
          } else {
            go("bill-form")
          }
          return
        }

        // Ctrl + Shift + I — Add bill item
        if (key === "i" && e.shiftKey) {
          e.preventDefault()
          if (page === "bill-form") {
            dispatchShortcutEvent("add-bill-item")
          }
          return
        }

        // Ctrl + Shift + L — Open Medicine Library
        if (key === "l" && e.shiftKey) {
          e.preventDefault()
          setSettingsInitialTab("Clinical library")
          go("settings")
          return
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => {
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [
    page,
    selectedPatient,
    showShortcutsModal,
    showConflictModal,
    go,
    editPatient,
    startConsultation,
    startBill,
  ])

  if (isRestoringSession) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-900 text-slate-700 dark:text-slate-200">
        <div className="flex flex-col items-center gap-3">
          <RefreshCw className="animate-spin text-teal-600" size={32} />
          <p className="text-sm font-medium">
            Verifying desktop security session...
          </p>
        </div>
      </div>
    )
  }

  // Desktop unauthenticated route guard fallback
  const activeSession = desktopSessionRef.current || desktopSession
  const activeOnboarding = onboardingDoctorRef.current || onboardingDoctor

  if (
    isTauriDesktop() &&
    !activeSession &&
    page !== "login" &&
    page !== "register"
  ) {
    return <Login go={go} onLoginSuccess={handleLoginSuccess} />
  }

  if (page === "login") {
    return <Login go={go} onLoginSuccess={handleLoginSuccess} />
  }
  if (page === "register") {
    return (
      <Register
        go={go}
        onRegisterSuccess={(result) => {
          if (isTauriDesktop() && !result.session) {
            go("login")
            return
          }
          const doctorData = {
            id: result.doctor.id,
            email: result.doctor.email,
            fullName: result.doctor.fullName,
            phone: result.doctor.phone,
            accessToken: result.accessToken,
            refreshToken: result.refreshToken,
          }
          onboardingDoctorRef.current = doctorData
          setOnboardingDoctor(doctorData)
          if (result.session) {
            desktopSessionRef.current = result.session
            setDesktopSession(result.session)
          }
          go("setup", result.session)
        }}
      />
    )
  }
  if (page === "setup") {
    return (
      <Setup
        go={go}
        doctor={onboardingDoctor}
        session={desktopSessionRef.current || desktopSession}
        onSetupComplete={async (session) => {
          onboardingDoctorRef.current = null
          setOnboardingDoctor(null)
          desktopSessionRef.current = session
          setDesktopSession(session)
          await handleLoginSuccess(session)
        }}
      />
    )
  }

  let content: ReactNode
  if (page === "dashboard") {
    content = (
      <Dashboard
        go={go}
        patients={patientRecords}
        onOpenPatient={openPatient}
        desktopSession={desktopSession}
      />
    )
  } else if (page === "patients") {
    content = (
      <PatientsPage
        go={go}
        patients={patientRecords}
        onOpenPatient={openPatient}
        onStartConsultation={startConsultation}
        onCreateBill={startBill}
        onEditPatient={editPatient}
        onDeletePatient={deletePatient}
      />
    )
  } else if (page === "patient-form") {
    content = (
      <PatientForm
        key={
          editingPatient
            ? `edit-${editingPatient.id}`
            : `new-patient-${newPatientFormKey}`
        }
        go={go}
        onSave={savePatient}
        onReviewPatient={openPatient}
        patient={editingPatient}
        patients={patientRecords}
        nextPatientId={nextPatientId}
        fieldPreferences={patientFormFieldPreferences}
      />
    )
  } else if (page === "patient-profile") {
    content = (
      <PatientProfile
        go={go}
        patient={selectedPatient}
        saveFeedback={patientSaveFeedback}
        onDeletePatient={deletePatient}
        onOpenConflictResolution={handleOpenConflicts}
        desktopSession={desktopSession}
        onStartBill={startBill}
        onStartConsultation={startConsultation}
        onViewPrescription={viewHistoricalPrescription}
        onEditPatient={editPatient}
        activeTab={patientProfileTab}
        onTabChange={setPatientProfileTab}
      />
    )
  } else if (page === "consultation") {
    content = (
      <Consultation
        go={go}
        patient={selectedPatient}
        clinicalLibrary={clinicalLibrary}
        vitals={vitals}
        onVitalsChange={updateVital}
        data={consultationData}
        onDataChange={setConsultationData}
        onAddMedicine={addMedicineDefinition}
        desktopSession={desktopSession}
        onUpdatePatientMedicalInfo={updatePatientMedicalInfo}
        customChiefComplaints={customChiefComplaints}
        onAddCustomChiefComplaint={handleAddCustomChiefComplaint}
        onFinalized={(_consultationId, finalizedTimestamp, rxRecord) => {
          if (consultationData.chiefComplaint?.trim()) {
            handleAddCustomChiefComplaint(consultationData.chiefComplaint)
          }
          const visitTimestamp = finalizedTimestamp || new Date().toISOString()
          setSelectedPatient((prev) => ({
            ...prev,
            lastVisit: visitTimestamp,
          }))
          setPatientRecords((prev) =>
            prev.map((p) =>
              p.id === selectedPatient.id
                ? { ...p, lastVisit: visitTimestamp }
                : p,
            ),
          )
          if (rxRecord) {
            setActiveConsultationPrescriptionRecord(rxRecord)
          }
        }}
      />
    )
  } else if (page === "preview") {
    const { isSamplePreview, isHistorical } = computePrescriptionPreviewState(
      prescriptionPreviewReturnPage,
      viewingHistoricalPrescription,
    )
    content = (
      <PrescriptionPreview
        go={go}
        patient={isSamplePreview ? SAMPLE_PREVIEW_PATIENT : selectedPatient}
        vitals={
          isSamplePreview
            ? SAMPLE_PREVIEW_VITALS
            : isHistorical
              ? viewingHistoricalPrescription!.vitals
              : vitals
        }
        data={
          isSamplePreview
            ? SAMPLE_PREVIEW_CONSULTATION
            : isHistorical
              ? viewingHistoricalPrescription!.consultationData
              : consultationData
        }
        bannerVisible={prescriptionBannerVisible}
        bannerImage={prescriptionBannerImage}
        signatureImage={doctorSignatureImage}
        showClinicLogo={showClinicLogo}
        showClinicEmail={showClinicEmail}
        showAllergyWarning={showAllergyWarning}
        topSpacingMm={prescriptionTopSpacingMm}
        returnPage={prescriptionPreviewReturnPage}
        desktopSession={desktopSession}
        prescriptionRecord={
          isHistorical
            ? viewingHistoricalPrescription!.record
            : activeConsultationPrescriptionRecord
        }
        onRevisePrescription={
          isHistorical ? handleRevisePrescription : undefined
        }
        itemsError={
          isHistorical ? viewingHistoricalPrescription!.itemsError : null
        }
        onAddPatient={() => {
          setEditingPatient(null)
          setNewPatientFormKey((k) => k + 1)
          go("patient-form")
        }}
      />
    )
  } else if (page === "bill-form") {
    content = (
      <BillForm
        go={go}
        patient={selectedPatient}
        bill={billData}
        onChange={setBillData}
        desktopSession={desktopSession}
        onFinalized={() => {
          setBillPreviewReturnPage("patient-profile")
        }}
      />
    )
  } else if (page === "bill-preview") {
    const isSamplePreview = billPreviewReturnPage === "settings"
    content = (
      <BillPreview
        go={go}
        patient={isSamplePreview ? SAMPLE_PREVIEW_PATIENT : selectedPatient}
        bill={isSamplePreview ? SAMPLE_PREVIEW_BILL : billData}
        bannerImage={prescriptionBannerImage}
        signatureImage={doctorSignatureImage}
        layout={billLayout}
        returnPage={billPreviewReturnPage}
        desktopSession={desktopSession}
      />
    )
  } else {
    content = (
      <SettingsPage
        key={settingsKey}
        go={go}
        logout={logout}
        darkMode={darkMode}
        onDarkModeChange={setDarkMode}
        clinicalLibrary={clinicalLibrary}
        onAddLibraryItem={addLibraryItem}
        onRemoveLibraryItem={removeLibraryItem}
        onAddMedicine={addMedicineDefinition}
        bannerVisible={prescriptionBannerVisible}
        onBannerVisibleChange={updatePrescriptionBannerVisible}
        bannerImage={prescriptionBannerImage}
        onBannerImageChange={updatePrescriptionBannerImage}
        signatureImage={doctorSignatureImage}
        onSignatureImageChange={updateDoctorSignatureImage}
        showClinicLogo={showClinicLogo}
        onShowClinicLogoChange={updateShowClinicLogo}
        showClinicEmail={showClinicEmail}
        onShowClinicEmailChange={updateShowClinicEmail}
        showAllergyWarning={showAllergyWarning}
        onShowAllergyWarningChange={updateShowAllergyWarning}
        prescriptionTopSpacingMm={prescriptionTopSpacingMm}
        onPrescriptionTopSpacingMmChange={updatePrescriptionTopSpacingMm}
        billLayout={billLayout}
        onBillLayoutChange={updateBillLayout}
        patientFormFieldPreferences={patientFormFieldPreferences}
        onPatientFormFieldPreferencesChange={updatePatientFormFieldPreferences}
        initialTab={settingsInitialTab}
        desktopSession={desktopSession}
        onOpenConflictModal={() => handleOpenConflicts()}
      />
    )
  }

  return (
    <div className={cn("app-shell", sidebarCollapsed && "sidebar-collapsed")}>
      <div
        className={cn("mobile-overlay", sidebarOpen && "open")}
        onClick={() => setSidebarOpen(false)}
      />
      <div
        className={cn(
          "sidebar-wrap",
          sidebarOpen && "open",
          sidebarCollapsed && "collapsed",
        )}
      >
        <Sidebar
          page={page}
          go={go}
          collapsed={sidebarCollapsed}
          onToggle={() => {
            if (window.matchMedia("(max-width: 820px)").matches) {
              setSidebarOpen(false)
            } else {
              setSidebarCollapsed((value) => !value)
            }
          }}
          onDoctorProfile={openDoctorProfile}
          desktopSession={desktopSession}
          conflictsCount={conflictsCount}
          onOpenConflicts={() => handleOpenConflicts()}
        />
      </div>
      <div className="main-shell">
        <div className="mobile-topbar">
          <IconButton
            label="Open navigation"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu size={20} />
          </IconButton>
          <Logo />
          <span className="sync-dot" />
        </div>
        {content}
      </div>
      <ConflictResolutionModal
        isOpen={showConflictModal}
        onClose={() => {
          setShowConflictModal(false)
          setTargetConflictId(null)
        }}
        activeClinicId={desktopSession?.clinic_id || ""}
        initialConflictId={targetConflictId}
        onConflictResolved={handleConflictResolved}
      />
      <ShortcutGuideModal
        isOpen={showShortcutsModal}
        onClose={() => setShowShortcutsModal(false)}
      />
    </div>
  )
}
