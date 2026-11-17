import { useCallback, useEffect, useState } from "react"
import { Button, ConfirmDialog, IconButton } from "../common"
import { AppHeader } from "../layout"
import { analyzeAllergies } from "../../utils/allergy"
import { InvoicesTab } from "./InvoicesTab"
import {
  OverviewTab,
  HistoryTab,
  ConsultationsTab,
  PrescriptionsTab,
} from "./tabs"
import {
  formatDateDDMMYYYY,
  formatDateTimeDDMMYYYY,
  formatIndiaDateTime,
  formatPatientAgeGender,
  getPublicPatientId,
  type Page,
  type Patient,
} from "../../types"
import {
  isTauriDesktop,
  getLocalConsultations,
  getLocalPrescriptions,
  type DesktopSessionContext,
  type LocalConsultationRecord,
  type LocalInvoiceRecord,
  type LocalPrescriptionRecord,
} from "../../desktop/desktop-bridge"
import {
  AlertCircle,
  ArrowLeft,
  CalendarDays,
  CheckCircle2,
  Edit3,
  Phone,
  ReceiptIndianRupee,
  Stethoscope,
  Trash2,
  UserRound,
} from "lucide-react"

export function PatientProfile({
  go,
  patient,
  saveFeedback,
  onDeletePatient,
  onOpenConflictResolution,
  desktopSession,
  onStartBill,
  onStartConsultation,
  onViewPrescription,
  onEditPatient,
  activeTab,
  onTabChange,
  initialPrescriptions,
  initialConsultations,
}: {
  go: (page: Page) => void
  patient: Patient
  saveFeedback: "added" | "updated" | null
  onDeletePatient?: (patientId: string) => void
  onOpenConflictResolution?: (patientId: string) => void
  desktopSession?: DesktopSessionContext | null
  onStartBill?: (patient: Patient, invoice?: LocalInvoiceRecord) => void
  onStartConsultation?: (patient: Patient) => void
  onViewPrescription?: (rx: LocalPrescriptionRecord) => void
  onEditPatient?: (patient: Patient) => void
  activeTab?: string
  onTabChange?: (tab: string) => void
  initialPrescriptions?: LocalPrescriptionRecord[]
  initialConsultations?: LocalConsultationRecord[]
}) {
  const [internalTab, setInternalTab] = useState(activeTab || "Overview")
  const tab = activeTab ?? internalTab

  const handleSelectTab = (newTab: string) => {
    setInternalTab(newTab)
    onTabChange?.(newTab)
  }
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [consultations, setConsultations] = useState<LocalConsultationRecord[]>(
    initialConsultations || [],
  )
  const [prescriptions, setPrescriptions] = useState<LocalPrescriptionRecord[]>(
    initialPrescriptions || [],
  )
  const [loadingHistory, setLoadingHistory] = useState(false)

  const allergyAnalysis = analyzeAllergies(patient.allergies)
  const allergyLabel = allergyAnalysis.displayLabel

  const loadHistory = useCallback(async () => {
    if (isTauriDesktop() && desktopSession?.clinic_id) {
      setLoadingHistory(true)
      try {
        const [cList, rxList] = await Promise.all([
          getLocalConsultations(desktopSession.clinic_id, patient.id).catch(
            () => [],
          ),
          getLocalPrescriptions(desktopSession.clinic_id, patient.id).catch(
            () => [],
          ),
        ])
        const matchedC = (cList || []).filter(
          (c) =>
            c.patient_id === patient.id ||
            c.patient_id === patient.displayId ||
            c.patient_id === patient.patientCode,
        )
        const matchedRx = (rxList || []).filter(
          (r) =>
            r.patient_id === patient.id ||
            r.patient_id === patient.displayId ||
            r.patient_id === patient.patientCode,
        )
        setConsultations(matchedC)
        setPrescriptions(matchedRx)
      } catch (err) {
        console.error("Failed to load patient history:", err)
      } finally {
        setLoadingHistory(false)
      }
    }
  }, [
    desktopSession?.clinic_id,
    patient.id,
    patient.displayId,
    patient.patientCode,
  ])

  useEffect(() => {
    loadHistory()
  }, [loadHistory])

  const hasHistory =
    consultations.length > 0 ||
    prescriptions.length > 0 ||
    patient.lastVisit !== "No visits yet"

  const publicPatientId = getPublicPatientId(patient)

  const handleDelete = async () => {
    if (!onDeletePatient) return
    setIsDeleting(true)
    try {
      await onDeletePatient(patient.id)
      setShowDeleteConfirm(false)
    } catch (err) {
      console.error("Failed to delete patient:", err)
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <>
      <AppHeader
        title="Patient profile"
        subtitle={`Patient ID ${publicPatientId}`}
      >
        <IconButton
          className="topbar-back"
          label="Back to patients"
          onClick={() => go("patients")}
        >
          <ArrowLeft size={18} />
        </IconButton>
        <Button
          variant="secondary"
          icon={Edit3}
          title="Edit patient (Ctrl+E)"
          onClick={() =>
            onEditPatient ? onEditPatient(patient) : go("patient-form")
          }
        >
          Edit patient
        </Button>
        <Button
          variant="secondary"
          icon={ReceiptIndianRupee}
          title="Open billing (Ctrl+Shift+B)"
          onClick={() => onStartBill?.(patient)}
        >
          Create bill
        </Button>
        <Button
          icon={Stethoscope}
          title="Start consultation (Ctrl+Shift+C)"
          onClick={() => {
            if (!patient || !patient.id || patient.id === "PT-INIT") {
              alert("No valid patient selected for consultation.")
              return
            }
            if (onStartConsultation) {
              onStartConsultation(patient)
            } else {
              go("consultation")
            }
          }}
        >
          Start consultation
        </Button>
        {onDeletePatient && (
          <Button
            variant="ghost"
            onClick={() => setShowDeleteConfirm(true)}
            aria-label={`Delete patient ${patient.name}`}
          >
            <Trash2 size={16} /> Delete
          </Button>
        )}
      </AppHeader>

      <div className="page-content profile-page">
        {saveFeedback && (
          <div className="success-banner" role="status" aria-live="polite">
            <CheckCircle2 size={19} />
            <div>
              <strong>
                {saveFeedback === "added"
                  ? "Patient added successfully."
                  : "Patient changes saved."}
              </strong>
              <span>
                {saveFeedback === "added"
                  ? "The local patient record is ready for this session."
                  : "The existing local record was updated without changing its patient ID."}
              </span>
            </div>
          </div>
        )}

        {patient.syncStatus === "CONFLICT" && (
          <div
            className="mb-4 p-3 rounded-lg bg-amber-50 dark:bg-amber-950/40 border-2 border-amber-500 text-amber-900 dark:text-amber-200 flex items-center justify-between gap-3"
            role="alert"
          >
            <div className="flex items-center gap-2.5">
              <AlertCircle
                size={20}
                className="text-amber-600 dark:text-amber-400 shrink-0"
              />
              <div>
                <strong className="block text-sm font-semibold">
                  Clinical Sync Conflict Detected
                </strong>
                <p className="text-xs text-amber-800 dark:text-amber-300">
                  This patient record has conflicting updates between this
                  device and the cloud.
                </p>
              </div>
            </div>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => onOpenConflictResolution?.(patient.id)}
            >
              Resolve Conflict
            </Button>
          </div>
        )}

        <section className="patient-hero">
          <div className="patient-identity">
            <span className="profile-avatar">{patient.initials}</span>
            <div>
              <h2>{patient.name}</h2>
              <p>
                {formatPatientAgeGender(
                  patient.age,
                  patient.gender,
                  "years",
                  patient.ageMonths,
                )}{" "}
                · {publicPatientId}
              </p>
              <span className="last-seen">
                <CalendarDays size={14} />{" "}
                {patient.lastVisit === "No visits yet"
                  ? "No consultations yet"
                  : `Last visit ${formatDateTimeDDMMYYYY(patient.lastVisit, true) || patient.lastVisit}`}
              </span>
            </div>
          </div>
          <div className="contact-grid">
            <span>
              <Phone size={16} />
              <small>Mobile</small>
              <strong>{patient.phone || "Not provided"}</strong>
            </span>
            <span>
              <UserRound size={16} />
              <small>Patient ID</small>
              <strong>{publicPatientId}</strong>
            </span>
            {patient.registeredAt && (
              <span>
                <CalendarDays size={16} />
                <small>Registered</small>
                <strong>{formatIndiaDateTime(patient.registeredAt)}</strong>
              </span>
            )}
          </div>
        </section>

        {allergyAnalysis.hasGenuineAllergies && (
          <div className="allergy-alert" role="alert">
            <AlertCircle size={20} />
            <div>
              <strong>Allergy alert: {allergyLabel}</strong>
              <p>Review and confirm with the patient before prescribing.</p>
            </div>
          </div>
        )}

        <div className="tabs" role="tablist">
          {[
            "Overview",
            "Medical History",
            "Prescriptions",
            "Invoices",
          ].map((item) => (
            <button
              key={item}
              role="tab"
              aria-selected={tab === item}
              className={tab === item ? "active" : ""}
              onClick={() => handleSelectTab(item)}
            >
              {item}
              {item === "Prescriptions" && <span>{prescriptions.length}</span>}
            </button>
          ))}
        </div>

        {tab === "Overview" && (
          <OverviewTab
            go={go}
            patient={patient}
            hasHistory={hasHistory}
            consultations={consultations}
            prescriptions={prescriptions}
            onEditPatient={onEditPatient}
          />
        )}
        {tab === "Medical History" && <HistoryTab patient={patient} />}
        {tab === "Consultations" && (
          <ConsultationsTab
            go={go}
            patient={patient}
            hasHistory={hasHistory}
            consultations={consultations}
            loading={loadingHistory}
            desktopSession={desktopSession}
          />
        )}
        {tab === "Prescriptions" && (
          <PrescriptionsTab
            go={go}
            patient={patient}
            hasHistory={hasHistory}
            prescriptions={prescriptions}
            loading={loadingHistory}
            desktopSession={desktopSession}
            onViewPrescription={onViewPrescription}
          />
        )}
        {tab === "Invoices" && (
          <InvoicesTab
            patient={patient}
            desktopSession={desktopSession}
            onStartBill={onStartBill}
          />
        )}
      </div>

      <ConfirmDialog
        isOpen={showDeleteConfirm}
        title={`Delete patient ${patient.name}?`}
        description={`Are you sure you want to delete patient ${patient.name} (${publicPatientId})? This will permanently delete local records for this patient.`}
        confirmText="Delete patient"
        cancelText="Cancel"
        isDangerous
        isLoading={isDeleting}
        onConfirm={handleDelete}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    </>
  )
}

export default PatientProfile
