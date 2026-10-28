import { useState } from "react"
import { Button, ConfirmDialog, IconButton } from "../common"
import { AppHeader } from "../layout"
import { InvoicesTab } from "./InvoicesTab"
import {
  OverviewTab,
  HistoryTab,
  ConsultationsTab,
  PrescriptionsTab,
} from "./tabs"
import type { Page, Patient } from "../../types"
import type {
  DesktopSessionContext,
  LocalInvoiceRecord,
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
}: {
  go: (page: Page) => void
  patient: Patient
  saveFeedback: "added" | "updated" | null
  onDeletePatient?: (patientId: string) => void
  onOpenConflictResolution?: (patientId: string) => void
  desktopSession?: DesktopSessionContext | null
  onStartBill?: (patient: Patient, invoice?: LocalInvoiceRecord) => void
}) {
  const [tab, setTab] = useState("Overview")
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

  const allergyLabel = patient.allergies.join(", ")
  const hasHistory = patient.lastVisit !== "No visits yet"

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
      <AppHeader title="Patient profile" subtitle={`Patient ID ${patient.id}`}>
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
          onClick={() => go("patient-form")}
        >
          Edit patient
        </Button>
        <Button
          variant="secondary"
          icon={ReceiptIndianRupee}
          onClick={() => onStartBill?.(patient)}
        >
          Create bill
        </Button>
        <Button icon={Stethoscope} onClick={() => go("consultation")}>
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
                {patient.age} years · {patient.gender} · {patient.id}
              </p>
              <span className="last-seen">
                <CalendarDays size={14} />{" "}
                {patient.lastVisit === "No visits yet"
                  ? "No consultations yet"
                  : `Last visit ${patient.lastVisit.toLowerCase()}`}
              </span>
            </div>
          </div>
          <div className="contact-grid">
            <span>
              <Phone size={16} />
              <small>Mobile</small>
              <strong>{patient.phone}</strong>
            </span>
            <span>
              <UserRound size={16} />
              <small>Patient ID</small>
              <strong>{patient.id}</strong>
            </span>
          </div>
        </section>

        {patient.allergies.length > 0 && (
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
            "Consultations",
            "Prescriptions",
            "Invoices",
          ].map((item) => (
            <button
              key={item}
              role="tab"
              aria-selected={tab === item}
              className={tab === item ? "active" : ""}
              onClick={() => setTab(item)}
            >
              {item}
              {item === "Consultations" && <span>{hasHistory ? 8 : 0}</span>}
              {item === "Prescriptions" && <span>{hasHistory ? 7 : 0}</span>}
            </button>
          ))}
        </div>

        {tab === "Overview" && (
          <OverviewTab go={go} patient={patient} hasHistory={hasHistory} />
        )}
        {tab === "Medical History" && <HistoryTab patient={patient} />}
        {tab === "Consultations" && (
          <ConsultationsTab go={go} hasHistory={hasHistory} />
        )}
        {tab === "Prescriptions" && (
          <PrescriptionsTab go={go} hasHistory={hasHistory} />
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
        description={`Are you sure you want to delete patient ${patient.name} (${patient.id})? This will permanently delete local records for this patient.`}
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
