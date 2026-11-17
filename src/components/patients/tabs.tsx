import { Button, StatusPill } from "../common"
import { cn } from "../../utils/cn"
import { analyzeAllergies } from "../../utils/allergy"
import {
  formatDateDDMMYYYY,
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
}: {
  go: (page: Page) => void
  patient: Patient
  hasHistory: boolean
  consultations?: LocalConsultationRecord[]
  prescriptions?: LocalPrescriptionRecord[]
  onEditPatient?: (patient: Patient) => void
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
                ? `Last visit: ${formatDateDDMMYYYY(consultations[0].consultation_date) || consultations[0].consultation_date || "Recorded"}`
                : hasHistory
                  ? formatDateDDMMYYYY(patient.lastVisit) || patient.lastVisit
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
          <button className="text-btn" onClick={() => go("consultation")}>
            New consultation
          </button>
        </div>
        {consultations.length > 0 ? (
          consultations.slice(0, 3).map((entry, index) => {
            const isDraft = entry.status === "DRAFT"
            const dateStr =
              formatDateDDMMYYYY(entry.consultation_date || entry.updated_at) ||
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
                  onClick={() => go(isDraft ? "consultation" : "preview")}
                >
                  {isDraft ? "Resume" : "Review"}
                </Button>
              </div>
            )
          })
        ) : hasHistory ? (
          [
            [
              "Today",
              "Consultation draft",
              "Clinical notes saved · Not finalized",
            ],
            [
              "12/03/2025",
              "Consultation finalized",
              "Prescription revision 1 · Delivered",
            ],
            ["18/11/2024", "Consultation finalized", "Printed at clinic"],
          ].map((entry, index) => (
            <div className="timeline-row" key={entry[0]}>
              <span className={cn("timeline-icon", index === 0 && "draft")}>
                <FileText size={16} />
              </span>
              <div>
                <strong>{entry[1]}</strong>
                <p>{entry[2]}</p>
              </div>
              <time>{entry[0]}</time>
              {index === 0 ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => go("consultation")}
                >
                  Resume
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => go("preview")}
                >
                  Review
                </Button>
              )}
            </div>
          ))
        ) : (
          <div className="empty-state compact">
            <ClipboardList size={25} />
            <h2>No clinical activity yet</h2>
            <p>Start the first consultation when the patient is ready.</p>
            <Button icon={Stethoscope} onClick={() => go("consultation")}>
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
}: {
  go: (page: Page) => void
  patient?: Patient
  hasHistory?: boolean
  consultations?: LocalConsultationRecord[]
  loading?: boolean
  desktopSession?: DesktopSessionContext | null
}) {
  return (
    <section className="panel record-list">
      <div className="panel-head">
        <div>
          <h2>Consultation history</h2>
        </div>
        <Button size="sm" onClick={() => go("consultation")} icon={Plus}>
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
            formatDateDDMMYYYY(c.consultation_date || c.updated_at) ||
            "Recorded"
          const isDraft = c.status === "DRAFT"
          return (
            <button
              key={c.id}
              onClick={() => go(isDraft ? "consultation" : "preview")}
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
      ) : hasHistory ? (
        [
          ["Today", "Draft", "Follow-up visit"],
          ["12/03/2025", "Finalized", "New consultation"],
          ["18/11/2024", "Routine consultation", "Routine consultation"],
        ].map((r) => (
          <button
            key={r[0]}
            onClick={() => go(r[1] === "Draft" ? "consultation" : "preview")}
          >
            <span className="record-icon">
              <ClipboardList size={18} />
            </span>
            <span>
              <strong>{r[2]}</strong>
              <small>
                {desktopSession?.doctor_name || "Doctor"} · {r[0]}
              </small>
            </span>
            <StatusPill tone={r[1] === "Draft" ? "warning" : "success"}>
              {r[1]}
            </StatusPill>
            <ChevronRight size={17} />
          </button>
        ))
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
      ) : hasHistory ? (
        [
          ["12/03/2025", "Revision 1", "Delivered"],
          ["18/11/2024", "Original", "Printed"],
          ["03/07/2024", "Original", "Delivered"],
        ].map((r) => (
          <button key={r[0]} onClick={() => go("preview")}>
            <span className="record-icon">
              <FileText size={18} />
            </span>
            <span>
              <strong>Prescription · {r[1]}</strong>
              <small>Finalized {r[0]}</small>
            </span>
            <StatusPill tone="success">{r[2]}</StatusPill>
            <ChevronRight size={17} />
          </button>
        ))
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
