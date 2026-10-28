import { useState, useEffect, type ReactNode } from "react"
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
  getSyncStatus,
  type DesktopSessionContext,
  type LocalInvoiceRecord,
} from "./desktop/desktop-bridge"

export default function App() {
  const [page, setPage] = useState<Page>("login")
  const [desktopSession, setDesktopSession] =
    useState<DesktopSessionContext | null>(null)
  const [onboardingDoctor, setOnboardingDoctor] = useState<{
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
    useState<"bill-form" | "settings">("bill-form")
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
            setDesktopSession(active)
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
            setIsRestoringSession(false)
          }
          return
        }

        const hasToken = await hasPersistedRefreshToken()
        if (hasToken) {
          const restored = await refreshDesktopSession()
          if (restored && mounted) {
            setDesktopSession(restored.session)
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
            setIsRestoringSession(false)
            return
          }
        }

        if (mounted) {
          setDesktopSession(null)
          setPage("login")
          setIsRestoringSession(false)
        }
      } catch (err) {
        console.warn("[Cliniqo Desktop] Session bootstrap error:", err)
        if (mounted) {
          setDesktopSession(null)
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

  const go = (next: Page) => {
    // Desktop Route Guard:
    // When running inside Tauri desktop container, do not allow navigation to protected pages without verified session
    if (
      isTauriDesktop() &&
      !desktopSession &&
      next !== "login" &&
      next !== "register" &&
      !(next === "setup" && onboardingDoctor)
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
      setDesktopSession(null)
      setPatientRecords([])
    }
    go("login")
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
        const rawItems = JSON.parse(existingInvoice.items_json)
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
    setDesktopSession(session)
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
    go("dashboard")
  }

  const addLibraryItem = (category: ClinicalLibraryCategory, value: string) => {
    setClinicalLibrary((library) => ({
      ...library,
      [category]: [...library[category], value],
    }))
  }

  const addMedicineDefinition = (medicine: ClinicalMedicineDefinition) => {
    setClinicalLibrary((library) => {
      const exists = library.MedicineDefinitions.some(
        (item) =>
          item.name.toLowerCase() === medicine.name.toLowerCase() &&
          item.formulation === medicine.formulation &&
          item.strength === medicine.strength,
      )
      if (exists) return library
      return {
        ...library,
        Medicines: library.Medicines.some(
          (item) => item.toLowerCase() === medicine.name.toLowerCase(),
        )
          ? library.Medicines
          : [...library.Medicines, medicine.name],
        MedicineDefinitions: [...library.MedicineDefinitions, medicine],
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
  if (
    isTauriDesktop() &&
    !desktopSession &&
    page !== "login" &&
    page !== "register" &&
    !(page === "setup" && onboardingDoctor)
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
          setOnboardingDoctor({
            id: result.doctor.id,
            email: result.doctor.email,
            fullName: result.doctor.fullName,
            phone: result.doctor.phone,
            accessToken: result.accessToken,
            refreshToken: result.refreshToken,
          })
          go("setup")
        }}
      />
    )
  }
  if (page === "setup") {
    return (
      <Setup
        go={go}
        doctor={onboardingDoctor}
        onSetupComplete={async (session) => {
          setOnboardingDoctor(null)
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
