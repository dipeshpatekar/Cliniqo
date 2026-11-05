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
} from "./types"
import {
  createEmptyConsultationData,
  loadClinicalLibrary,
  mapLocalRecordToPatient,
  initialPatients,
} from "./types"
import { cn } from "./utils/cn"

// Components
import { IconButton } from "./components/common"
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

// Native Desktop Bridge
import {
  isTauriDesktop,
  getDesktopSession,
  hasPersistedRefreshToken,
  refreshDesktopSession,
  logoutDesktopSession,
  getLocalPatients,
  saveLocalPatient,
  deleteLocalPatient,
  getLocalFormulary,
  getSyncStatus,
  startCatalogueSync,
  getInventoryStockSummary,
  importInventoryStock,
  type DesktopSessionContext,
  type LocalInvoiceRecord,
} from "./desktop/desktop-bridge"
import stockReportData from "./data/stock-report-18-10-26.json"

export default function App() {
  const [page, setPage] = useState<Page>("login")
  const [desktopSession, setDesktopSession] =
    useState<DesktopSessionContext | null>(null)
  const desktopSessionRef = useRef<DesktopSessionContext | null>(null)
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
  const [isRestoringSession, setIsRestoringSession] =
    useState<boolean>(isTauriDesktop)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true)
  const [patientRecords, setPatientRecords] = useState<Patient[]>(() =>
    isTauriDesktop() ? [] : initialPatients,
  )
  const [selectedPatient, setSelectedPatient] = useState<Patient>(() =>
    isTauriDesktop()
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
      : initialPatients[0],
  )
  const [editingPatient, setEditingPatient] = useState<Patient | null>(null)
  const [patientSaveFeedback, setPatientSaveFeedback] =
    useState<"added" | "updated" | null>(null)
  const [settingsKey, setSettingsKey] = useState(0)
  const [settingsInitialTab, setSettingsInitialTab] = useState("Doctor profile")
  const [prescriptionPreviewReturnPage, setPrescriptionPreviewReturnPage] =
    useState<"consultation" | "settings">("consultation")
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
  const [prescriptionBannerVisible, setPrescriptionBannerVisible] =
    useState(true)
  const [prescriptionBannerImage, setPrescriptionBannerImage] = useState<{
    src: string
    name: string
  } | null>(null)
  const [doctorSignatureImage, setDoctorSignatureImage] = useState<{
    src: string
    name: string
  } | null>(null)
  const [showClinicLogo, setShowClinicLogo] = useState(true)
  const [showClinicEmail, setShowClinicEmail] = useState(true)
  const [showAllergyWarning, setShowAllergyWarning] = useState(true)
  const [billLayout, setBillLayout] = useState<BillLayoutPreferences>({
    showBanner: true,
    showClinicLogo: true,
    showClinicEmail: true,
    showSignature: true,
    showPaymentNote: true,
  })
  const [billData, setBillData] = useState<BillData>({
    invoiceNumber: "INV-2025-1048",
    date: "2025-07-01",
    status: "DRAFT",
    paymentStatus: "Unpaid",
    discount: 0,
    taxRatePercent: 0,
    items: [{ id: 1, description: "Consultation fee", quantity: 1, rate: 800 }],
  })
  const nextPatientId = `PC-${
    Math.max(
      ...patientRecords.map(
        (patient) => Number(patient.id.replace(/\D/g, "")) || 0,
      ),
      1048,
    ) + 1
  }`
  const [showConflictModal, setShowConflictModal] = useState(false)
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

  // Desktop session bootstrap: check active in-memory session or restore via DPAPI refresh token
  useEffect(() => {
    if (!isTauriDesktop()) return

    let mounted = true
    async function bootstrapDesktopSession() {
      try {
        const active = await getDesktopSession()
        const nowSec = Math.floor(Date.now() / 1000)
        if (active && active.expires_at > nowSec) {
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
                console.warn(
                  "[Cliniqo Desktop] Failed to load local patients:",
                  err,
                )
              }
              setPage((curr) =>
                curr === "login" || curr === "register" ? "dashboard" : curr,
              )
              loadAndMergeLocalFormulary(restored.session.clinic_id).catch(
                () => {},
              )
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
          desktopSessionRef.current = null
          setDesktopSession(null)
          onboardingDoctorRef.current = null
          setOnboardingDoctor(null)
          setPage("login")
          setIsRestoringSession(false)
        }
      }
    }

    bootstrapDesktopSession()
    return () => {
      mounted = false
    }
  }, [])

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
      const fromSettings = page === "settings"
      setPrescriptionPreviewReturnPage(
        fromSettings ? "settings" : "consultation",
      )
      if (fromSettings) setSettingsInitialTab("Prescription layout")
    }
    if (next === "bill-preview") {
      const fromSettings = page === "settings"
      setBillPreviewReturnPage(fromSettings ? "settings" : "bill-form")
      if (fromSettings) setSettingsInitialTab("Bill layout")
    }
    if (next === "patient-form") {
      setEditingPatient(
        page === "patient-profile" || page === "preview"
          ? selectedPatient
          : null,
      )
    }
    if (next === "settings" && page !== "preview" && page !== "bill-preview") {
      setSettingsInitialTab("Doctor profile")
    }
    setPage(next)
    setSidebarOpen(false)
    window.scrollTo({ top: 0, behavior: "smooth" })
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
    go("patient-profile")
  }

  const startConsultation = (patient: Patient) => {
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
    go("consultation")
  }

  const editPatient = (patient: Patient) => {
    setSelectedPatient(patient)
    setPatientSaveFeedback(null)
    setEditingPatient(patient)
    setPage("patient-form")
    setSidebarOpen(false)
    window.scrollTo({ top: 0, behavior: "smooth" })
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

  const savePatient = async (patient: Patient, startConsultation = false) => {
    const wasEditing = Boolean(editingPatient)
    let effectivePatient = patient

    if (isTauriDesktop() && desktopSession?.clinic_id) {
      try {
        const savedId = await saveLocalPatient({
          id: wasEditing ? editingPatient?.id : null,
          clinic_id: desktopSession.clinic_id,
          patient_code: patient.id,
          name: patient.name,
          phone: patient.phone,
          gender: patient.gender,
          date_of_birth: patient.dateOfBirth || null,
          age: patient.age,
          allergies: patient.allergies,
          conditions: patient.conditions,
        })
        if (savedId) {
          effectivePatient = {
            ...patient,
            id: wasEditing ? patient.id : savedId,
          }
        }
      } catch (err) {
        console.error(
          "[Cliniqo Desktop] Failed to save patient to SQLite:",
          err,
        )
      }
    }

    setPatientRecords((records) => [
      effectivePatient,
      ...records.filter(
        (record) =>
          record.id !== patient.id && record.id !== effectivePatient.id,
      ),
    ])
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
  }

  const deletePatient = async (patientId: string) => {
    if (isTauriDesktop() && desktopSession?.clinic_id) {
      try {
        await deleteLocalPatient(desktopSession.clinic_id, patientId)
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
    startCatalogueSync().catch(() => {})
    go("dashboard", session)
  }

  const addLibraryItem = (category: ClinicalLibraryCategory, value: string) => {
    setClinicalLibrary((library) => ({
      ...library,
      [category]: [...library[category], value],
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
        go={go}
        onSave={savePatient}
        onReviewPatient={openPatient}
        patient={editingPatient}
        patients={patientRecords}
        nextPatientId={nextPatientId}
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
      />
    )
  } else if (page === "preview") {
    content = (
      <PrescriptionPreview
        go={go}
        patient={selectedPatient}
        vitals={vitals}
        data={consultationData}
        bannerVisible={prescriptionBannerVisible}
        bannerImage={prescriptionBannerImage}
        signatureImage={doctorSignatureImage}
        showClinicLogo={showClinicLogo}
        showClinicEmail={showClinicEmail}
        showAllergyWarning={showAllergyWarning}
        returnPage={prescriptionPreviewReturnPage}
        desktopSession={desktopSession}
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
          go("bill-preview")
        }}
      />
    )
  } else if (page === "bill-preview") {
    content = (
      <BillPreview
        go={go}
        patient={selectedPatient}
        bill={billData}
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
        onAddMedicine={addMedicineDefinition}
        bannerVisible={prescriptionBannerVisible}
        onBannerVisibleChange={setPrescriptionBannerVisible}
        bannerImage={prescriptionBannerImage}
        onBannerImageChange={setPrescriptionBannerImage}
        signatureImage={doctorSignatureImage}
        onSignatureImageChange={setDoctorSignatureImage}
        showClinicLogo={showClinicLogo}
        onShowClinicLogoChange={setShowClinicLogo}
        showClinicEmail={showClinicEmail}
        onShowClinicEmailChange={setShowClinicEmail}
        showAllergyWarning={showAllergyWarning}
        onShowAllergyWarningChange={setShowAllergyWarning}
        billLayout={billLayout}
        onBillLayoutChange={setBillLayout}
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
    </div>
  )
}
