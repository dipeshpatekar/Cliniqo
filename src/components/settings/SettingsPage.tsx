import { useState, useRef } from "react"
import {
  ArrowLeft,
  UserRound,
  Building2,
  FileText,
  ReceiptIndianRupee,
  Pill,
  Moon,
  MessageCircle,
  ShieldCheck,
  Cloud,
  ChevronRight,
  LogOut,
  Check,
  UserCheck,
} from "lucide-react"
import type {
  Page,
  ClinicalLibrary,
  ClinicalLibraryCategory,
  ClinicalMedicineDefinition,
  BillLayoutPreferences,
  PatientFormFieldPreferences,
} from "../../types"
import { defaultPatientFormFieldPreferences } from "../../types"
import { Button, IconButton } from "../common"
import { AppHeader } from "../layout"
import { SettingsProfile } from "./SettingsProfile"
import { PrescriptionSettings } from "./PrescriptionSettings"
import { BillLayoutSettings } from "./BillLayoutSettings"
import { ClinicalLibrarySettings } from "./ClinicalLibrarySettings"
import { AppearanceSettings } from "./AppearanceSettings"
import { WhatsAppSettings } from "./WhatsAppSettings"
import { SecuritySettings } from "./SecuritySettings"
import { SyncSettings } from "./SyncSettings"
import { PatientFormSettings } from "./PatientFormSettings"
import type { DesktopSessionContext } from "../../desktop/desktop-bridge"

export interface SettingsPageProps {
  go: (page: Page) => void
  logout: () => void
  darkMode: boolean
  onDarkModeChange: (enabled: boolean) => void
  clinicalLibrary: ClinicalLibrary
  onAddLibraryItem: (category: ClinicalLibraryCategory, value: string) => void
  onAddMedicine: (medicine: ClinicalMedicineDefinition) => void
  bannerVisible: boolean
  onBannerVisibleChange: (visible: boolean) => void
  bannerImage: { src: string; name: string } | null
  onBannerImageChange: (image: { src: string; name: string } | null) => void
  signatureImage: { src: string; name: string } | null
  onSignatureImageChange: (image: { src: string; name: string } | null) => void
  showClinicLogo: boolean
  onShowClinicLogoChange: (visible: boolean) => void
  showClinicEmail: boolean
  onShowClinicEmailChange: (visible: boolean) => void
  showAllergyWarning: boolean
  onShowAllergyWarningChange: (visible: boolean) => void
  prescriptionTopSpacingMm?: number
  onPrescriptionTopSpacingMmChange?: (spacing: number) => void
  onRemoveLibraryItem?: (
    category: ClinicalLibraryCategory,
    value: string,
  ) => void
  billLayout: BillLayoutPreferences
  onBillLayoutChange: (layout: BillLayoutPreferences) => void
  patientFormFieldPreferences?: PatientFormFieldPreferences
  onPatientFormFieldPreferencesChange?: (
    prefs: PatientFormFieldPreferences,
  ) => void
  initialTab: string
  desktopSession?: DesktopSessionContext | null
  onOpenConflictModal?: () => void
}

export function SettingsPage({
  go,
  logout,
  darkMode,
  onDarkModeChange,
  clinicalLibrary,
  onAddLibraryItem,
  onAddMedicine,
  bannerVisible,
  onBannerVisibleChange,
  bannerImage,
  onBannerImageChange,
  signatureImage,
  onSignatureImageChange,
  showClinicLogo,
  onShowClinicLogoChange,
  showClinicEmail,
  onShowClinicEmailChange,
  showAllergyWarning,
  onShowAllergyWarningChange,
  prescriptionTopSpacingMm = 0,
  onPrescriptionTopSpacingMmChange,
  onRemoveLibraryItem,
  billLayout,
  onBillLayoutChange,
  patientFormFieldPreferences = defaultPatientFormFieldPreferences,
  onPatientFormFieldPreferencesChange,
  initialTab,
  desktopSession,
  onOpenConflictModal,
}: SettingsPageProps) {
  const [tab, setTab] = useState(initialTab)
  const [saved, setSaved] = useState(false)
  const saveClinicProfileHandlerRef = useRef<(() => Promise<boolean>) | null>(
    null,
  )
  const saveDoctorProfileHandlerRef = useRef<(() => Promise<boolean>) | null>(
    null,
  )

  const sections = [
    { label: "Doctor profile", icon: UserRound },
    { label: "Clinic profile", icon: Building2 },
    { label: "Patient form", icon: UserCheck },
    { label: "Prescription layout", icon: FileText },
    { label: "Bill layout", icon: ReceiptIndianRupee },
    { label: "Clinical library", icon: Pill },
    { label: "Appearance", icon: Moon },
    { label: "WhatsApp", icon: MessageCircle },
    { label: "Security", icon: ShieldCheck },
    { label: "Sync & data", icon: Cloud },
  ]

  return (
    <>
      <AppHeader title="Settings">
        <IconButton
          className="topbar-back"
          label="Back to dashboard"
          onClick={() => go("dashboard")}
        >
          <ArrowLeft size={18} />
        </IconButton>
      </AppHeader>

      <div className="settings-page">
        <aside className="settings-nav">
          {sections.map((s) => (
            <button
              key={s.label}
              className={tab === s.label ? "active" : ""}
              onClick={() => setTab(s.label)}
            >
              <s.icon size={17} />
              {s.label}
              <ChevronRight size={15} />
            </button>
          ))}
          <button className="logout-setting" onClick={logout}>
            <LogOut size={17} />
            Log out
          </button>
        </aside>

        <main className="settings-content">
          {tab === "Doctor profile" && (
            <SettingsProfile
              title="Doctor profile"
              clinic={false}
              desktopSession={desktopSession}
              onSave={(handler) => {
                saveDoctorProfileHandlerRef.current = handler
              }}
            />
          )}
          {tab === "Clinic profile" && (
            <SettingsProfile
              title="Clinic profile"
              clinic
              desktopSession={desktopSession}
              onSave={(handler) => {
                saveClinicProfileHandlerRef.current = handler
              }}
            />
          )}
          {tab === "Patient form" && (
            <PatientFormSettings
              preferences={patientFormFieldPreferences}
              onChange={(updated) =>
                onPatientFormFieldPreferencesChange?.(updated)
              }
            />
          )}
          {tab === "Prescription layout" && (
            <PrescriptionSettings
              go={go}
              bannerVisible={bannerVisible}
              onBannerVisibleChange={onBannerVisibleChange}
              bannerImage={bannerImage}
              onBannerImageChange={onBannerImageChange}
              signatureImage={signatureImage}
              onSignatureImageChange={onSignatureImageChange}
              showClinicLogo={showClinicLogo}
              onShowClinicLogoChange={onShowClinicLogoChange}
              showClinicEmail={showClinicEmail}
              onShowClinicEmailChange={onShowClinicEmailChange}
              showAllergyWarning={showAllergyWarning}
              onShowAllergyWarningChange={onShowAllergyWarningChange}
              topSpacingMm={prescriptionTopSpacingMm}
              onTopSpacingMmChange={onPrescriptionTopSpacingMmChange}
            />
          )}
          {tab === "Bill layout" && (
            <BillLayoutSettings
              go={go}
              layout={billLayout}
              onChange={onBillLayoutChange}
              bannerImage={bannerImage}
              signatureImage={signatureImage}
            />
          )}
          {tab === "Clinical library" && (
            <ClinicalLibrarySettings
              library={clinicalLibrary}
              onAdd={onAddLibraryItem}
              onRemove={onRemoveLibraryItem}
              onAddMedicine={onAddMedicine}
              desktopSession={desktopSession}
            />
          )}
          {tab === "Appearance" && (
            <AppearanceSettings
              darkMode={darkMode}
              onDarkModeChange={onDarkModeChange}
            />
          )}
          {tab === "WhatsApp" && <WhatsAppSettings />}
          {tab === "Security" && (
            <SecuritySettings logout={logout} desktopSession={desktopSession} />
          )}
          {tab === "Sync & data" && (
            <SyncSettings onOpenConflictModal={onOpenConflictModal} />
          )}

          {(tab === "Doctor profile" || tab === "Clinic profile") && (
            <div className="settings-actions">
              <Button variant="secondary" onClick={() => go("dashboard")}>
                Cancel
              </Button>
              <Button
                onClick={async () => {
                  if (
                    tab === "Clinic profile" &&
                    saveClinicProfileHandlerRef.current
                  ) {
                    const ok = await saveClinicProfileHandlerRef.current()
                    if (ok) {
                      setSaved(true)
                      window.setTimeout(() => setSaved(false), 1800)
                    }
                  } else if (
                    tab === "Doctor profile" &&
                    saveDoctorProfileHandlerRef.current
                  ) {
                    const ok = await saveDoctorProfileHandlerRef.current()
                    if (ok) {
                      setSaved(true)
                      window.setTimeout(() => setSaved(false), 1800)
                    }
                  } else {
                    setSaved(true)
                    window.setTimeout(() => setSaved(false), 1800)
                  }
                }}
              >
                {saved ? (
                  <>
                    <Check size={16} /> Saved
                  </>
                ) : (
                  "Save changes"
                )}
              </Button>
            </div>
          )}
        </main>
      </div>
    </>
  )
}

export default SettingsPage
