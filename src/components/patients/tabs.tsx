import { Button, StatusPill } from "../common"
import { cn } from "../../utils/cn"
import { analyzeAllergies } from "../../utils/allergy"
import {
  formatDateDDMMYYYY,
  formatDateTimeDDMMYYYY,
  formatIndiaDateTime,
  formatPatientAge,
  formatPatientGender,
  getPublicPatientId,
  type Page,
  type Patient,
} from "../../types"
import type {
  DesktopSessionContext,
  LocalConsultationRecord,
  LocalPrescriptionRecord,
} from "../../desktop/desktop-bridge"
import {
  ClipboardList,
  FileText,
  Stethoscope,
  ChevronRight,
  Plus,
} from "lucide-react"

export function OverviewTab({
  go,
  patient,
  hasHistory,
  consultations = [],
  prescriptions = [],
  onEditPatient,
  onStartConsultation,
  onResumeConsultation,
}: {
  go: (page: Page) => void
  patient: Patient
  hasHistory: boolean
  consultations?: LocalConsultationRecord[]
  prescriptions?: LocalPrescriptionRecord[]
  onEditPatient?: (patient: Patient) => void
  onStartConsultation?: (patient: Patient) => void
  onResumeConsultation?: (
    patient: Patient,
    draft: LocalConsultationRecord,
  ) => void
}) {
  return (
    <div className="profile-grid">
      <section className="panel detail-panel">
        <div className="panel-head">
          <div>
            <h2>Patient details</h2>
          </div>
          <button
            className="text-btn"
            onClick={() =>
              onEditPatient ? onEditPatient(patient) : go("patient-form")
            }
          >
            Edit
          </button>
        </div>
        <dl className="details-list">
          <div>
            <dt>Age</dt>
            <dd>{formatPatientAge(patient.age, "years", patient.ageMonths)}</dd>
          </div>
          <div>
            <dt>Gender</dt>
            <dd>{formatPatientGender(patient.gender)}</dd>
          </div>
          <div>
            <dt>Phone</dt>
            <dd>{patient.phone}</dd>
          </div>
          <div>
            <dt>Patient ID</dt>
            <dd>{getPublicPatientId(patient)}</dd>
          </div>
          {patient.registeredAt && (
            <div>
              <dt>Registered</dt>
              <dd>{formatIndiaDateTime(patient.registeredAt)}</dd>
            </div>
          )}
          {patient.dateOfBirth && (
            <div>
              <dt>Date of birth</dt>
              <dd>{formatDateDDMMYYYY(patient.dateOfBirth)}</dd>
            </div>
          )}
          {patient.alternatePhone && (
            <div>
              <dt>Alternate phone</dt>
              <dd>{patient.alternatePhone}</dd>
            </div>
          )}
          {patient.address && (
            <div className="wide">
              <dt>Address</dt>
              <dd>{patient.address}</dd>
            </div>
          )}
          <div className="wide">
            <dt>Consultation status</dt>
            <dd>
              {consultations.length > 0
                ? `Last visit: ${formatDateTimeDDMMYYYY(consultations[0].consultation_date || consultations[0].updated_at, true) || "Recorded"}`
                : hasHistory && patient.lastVisit !== "No visits yet"
                  ? `Last visit: ${formatDateTimeDDMMYYYY(patient.lastVisit, true) || patient.lastVisit}`
                  : "No consultations recorded"}
            </dd>
          </div>
        </dl>
      </section>
      <section className="panel detail-panel">
        <div className="panel-head">
          <div>
            <h2>Clinical background</h2>
          </div>
        </div>
        <div className="clinical-item">
          <span>Known allergies</span>
          {(() => {
            const allergyAnalysis = analyzeAllergies(patient.allergies)
            return (
              <strong className={allergyAnalysis.hasGenuineAllergies ? "danger-text" : ""}>
                {allergyAnalysis.displayLabel}
              </strong>
            )
          })()}
        </div>
        <div className="clinical-item">
          <span>Medical conditions</span>
          <strong>{patient.conditions.join(", ") || "None recorded"}</strong>
        </div>
        <div className="clinical-item">
          <span>Current medicines</span>
          <strong>
            {prescriptions.length > 0
              ? `${prescriptions.length} active ${
                  prescriptions.length === 1 ? "prescription" : "prescriptions"
                }`
              : "None recorded"}
          </strong>
        </div>
        <div className="clinical-item">
          <span>Family history</span>
          <strong>No significant history recorded</strong>
        </div>
      </section>
      <section className="panel timeline-panel">
        <div className="panel-head">
          <div>
            <h2>Recent clinical activity</h2>
          </div>
          <button
            className="text-btn"
            onClick={() =>
              onStartConsultation
                ? onStartConsultation(patient)
                : go("consultation")
            }
          >
            New consultation
          </button>
        </div>
        {consultations.length > 0 ? (
          consultations.slice(0, 3).map((entry, index) => {
            const isDraft = entry.status === "DRAFT"
            const dateStr =
              formatDateTimeDDMMYYYY(entry.consultation_date || entry.updated_at, true) ||
              "Recorded"
            return (
              <div className="timeline-row" key={entry.id}>
                <span className={cn("timeline-icon", isDraft && "draft")}>
                  <FileText size={16} />
                </span>
                <div>
                  <strong>
                    {isDraft ? "Consultation draft" : "Consultation finalized"}
                  </strong>
                  <p>
                    {entry.diagnosis ||
                      entry.chief_complaint ||
                      "Clinical notes recorded"}
                  </p>
                </div>
                <time>{dateStr}</time>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    isDraft && onResumeConsultation
                      ? onResumeConsultation(patient, entry)
                      : go(isDraft ? "consultation" : "preview")
                  }
                >
                  {isDraft ? "Resume" : "Review"}
                </Button>
              </div>
            )
          })
        ) : (
          <div className="empty-state compact">
            <ClipboardList size={25} />
            <h2>No clinical activity yet</h2>
            <p>Start the first consultation when the patient is ready.</p>
            <Button
              icon={Stethoscope}
              onClick={() =>
                onStartConsultation
                  ? onStartConsultation(patient)
                  : go("consultation")
              }
            >
              Start consultation
            </Button>
          </div>
        )}
      </section>
    </div>
  )
}

export function HistoryTab({ patient }: { patient: Patient }) {
  const hasConditions = patient.conditions && patient.conditions.length > 0
  return (
    <section className="panel history-layout">
      <div className="history-block">
        <h2>Medical history</h2>
        {hasConditions ? (
          <div className="flex flex-wrap gap-2 mt-2">
            {patient.conditions.map((condition, idx) => (
              <span
                key={idx}
                className="px-3 py-1.5 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200 text-sm font-medium border border-slate-200 dark:border-slate-700"
              >
                {condition}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-slate-500 text-sm mt-2">
            No medical history recorded for this patient.
          </p>
        )}
      </div>
    </section>
  )
}

export function ConsultationsTab({
  go,
  patient,
  hasHistory,
  consultations = [],
  loading = false,
  desktopSession,
  onStartConsultation,
  onResumeConsultation,
}: {
  go: (page: Page) => void
  patient?: Patient
  hasHistory?: boolean
  consultations?: LocalConsultationRecord[]
  loading?: boolean
  desktopSession?: DesktopSessionContext | null
  onStartConsultation?: (patient: Patient) => void
  onResumeConsultation?: (
    patient: Patient,
    draft: LocalConsultationRecord,
  ) => void
}) {
  return (
    <section className="panel record-list">
      <div className="panel-head">
        <div>
          <h2>Consultation history</h2>
        </div>
        <Button
          size="sm"
          onClick={() =>
            patient && onStartConsultation
              ? onStartConsultation(patient)
              : go("consultation")
          }
          icon={Plus}
        >
          New consultation
        </Button>
      </div>
      {loading ? (
        <div className="p-8 text-center text-slate-500 dark:text-slate-400">
          <p className="text-sm">Loading encrypted consultation records...</p>
        </div>
      ) : consultations.length > 0 ? (
        consultations.map((c) => {
          const dateStr =
            formatDateTimeDDMMYYYY(c.consultation_date || c.updated_at, true) ||
            "Recorded"
          const isDraft = c.status === "DRAFT"
          return (
            <button
              key={c.id}
              onClick={() =>
                isDraft && onResumeConsultation && patient
                  ? onResumeConsultation(patient, c)
                  : go(isDraft ? "consultation" : "preview")
              }
            >
              <span className="record-icon">
                <ClipboardList size={18} />
              </span>
              <span>
                <strong>
                  {c.diagnosis || c.chief_complaint || "Clinical consultation"}
                </strong>
                <small>
                  {desktopSession?.doctor_name || "Doctor"} · {dateStr}
                </small>
              </span>
              <StatusPill tone={isDraft ? "warning" : "success"}>
                {isDraft ? "Draft" : "Finalized"}
              </StatusPill>
              <ChevronRight size={17} />
            </button>
          )
        })
      ) : (
        <div className="empty-state compact">
          <ClipboardList size={25} />
          <h2>No consultations yet</h2>
          <p>New consultations will be preserved here.</p>
        </div>
      )}
    </section>
  )
}

export function PrescriptionsTab({
  go,
  patient,
  hasHistory,
  prescriptions = [],
  loading = false,
  desktopSession,
  onViewPrescription,
}: {
  go: (page: Page) => void
  patient?: Patient
  hasHistory?: boolean
  prescriptions?: LocalPrescriptionRecord[]
  loading?: boolean
  desktopSession?: DesktopSessionContext | null
  onViewPrescription?: (rx: LocalPrescriptionRecord) => void
}) {
  return (
    <section className="panel record-list">
      <div className="panel-head">
        <div>
          <h2>Prescription history</h2>
        </div>
      </div>
      {loading ? (
        <div className="p-8 text-center text-slate-500 dark:text-slate-400">
          <p className="text-sm">Loading encrypted prescription records...</p>
        </div>
      ) : prescriptions.length > 0 ? (
        prescriptions.map((r) => {
          const dateStr = r.created_at
            ? formatDateDDMMYYYY(r.created_at)
            : "Finalized"
          const revLabel =
            r.revision_number > 1 ? `Revision ${r.revision_number}` : "Original"
          let itemCount = 0
          try {
            if (r.items_json) {
              const parsed = JSON.parse(r.items_json)
              itemCount = Array.isArray(parsed) ? parsed.length : 0
            }
          } catch {}

          const handleClick = () => {
            if (onViewPrescription) {
              onViewPrescription(r)
            } else {
              go("preview")
            }
          }

          return (
            <button key={r.id} onClick={handleClick}>
              <span className="record-icon">
                <FileText size={18} />
              </span>
              <span>
                <strong>
                  {r.prescription_number} · {revLabel}
                </strong>
                <small>
                  Finalized {dateStr} · {itemCount}{" "}
                  {itemCount === 1 ? "medicine" : "medicines"}
                </small>
              </span>
              <StatusPill
                tone={
                  r.status === "ACTIVE"
                    ? "success"
                    : r.status === "SUPERSEDED"
                      ? "info"
                      : "warning"
                }
              >
                {r.status === "ACTIVE"
                  ? "Finalized"
                  : r.status === "SUPERSEDED"
                    ? "Superseded"
                    : r.status}
              </StatusPill>
              <ChevronRight size={17} />
            </button>
          )
        })
      ) : (
        <div className="empty-state compact">
          <FileText size={25} />
          <h2>No prescriptions yet</h2>
          <p>Finalized prescriptions and revisions will appear here.</p>
        </div>
      )}
    </section>
  )
}
