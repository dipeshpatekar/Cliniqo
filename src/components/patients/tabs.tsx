import { Button, StatusPill } from "../common"
import { cn } from "../../utils/cn"
import type { Page, Patient } from "../../types"
import type { DesktopSessionContext } from "../../desktop/desktop-bridge"
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
}: {
  go: (page: Page) => void
  patient: Patient
  hasHistory: boolean
}) {
  return (
    <div className="profile-grid">
      <section className="panel detail-panel">
        <div className="panel-head">
          <div>
            <h2>Patient details</h2>
            <p>Demographic information</p>
          </div>
          <button className="text-btn" onClick={() => go("patient-form")}>
            Edit
          </button>
        </div>
        <dl className="details-list">
          <div>
            <dt>Age</dt>
            <dd>{patient.age} years</dd>
          </div>
          <div>
            <dt>Gender</dt>
            <dd>{patient.gender}</dd>
          </div>
          <div>
            <dt>Phone</dt>
            <dd>{patient.phone}</dd>
          </div>
          <div>
            <dt>Patient ID</dt>
            <dd>{patient.id}</dd>
          </div>
          <div className="wide">
            <dt>Consultation status</dt>
            <dd>
              {hasHistory ? patient.lastVisit : "No consultations recorded"}
            </dd>
          </div>
        </dl>
      </section>
      <section className="panel detail-panel">
        <div className="panel-head">
          <div>
            <h2>Clinical background</h2>
            <p>Persistent across consultations</p>
          </div>
        </div>
        <div className="clinical-item">
          <span>Known allergies</span>
          <strong className={patient.allergies.length > 0 ? "danger-text" : ""}>
            {patient.allergies.join(", ") || "None recorded"}
          </strong>
        </div>
        <div className="clinical-item">
          <span>Medical conditions</span>
          <strong>{patient.conditions.join(", ") || "None recorded"}</strong>
        </div>
        <div className="clinical-item">
          <span>Current medicines</span>
          <strong>None recorded</strong>
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
            <p>Consultations and prescriptions</p>
          </div>
          <button className="text-btn" onClick={() => go("consultation")}>
            New consultation
          </button>
        </div>
        {hasHistory ? (
          [
            [
              "Today",
              "Consultation draft",
              "Clinical notes saved · Not finalized",
            ],
            [
              "12 Mar 2025",
              "Consultation finalized",
              "Prescription revision 1 · Delivered",
            ],
            ["18 Nov 2024", "Consultation finalized", "Printed at clinic"],
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
  return (
    <section className="panel history-layout">
      <div className="history-block">
        <h2>Medical history</h2>
        <p>
          {patient.conditions.join(", ") || "No medical conditions recorded."}
        </p>
      </div>
      <div className="history-block">
        <h2>Family history</h2>
        <p>No significant family history recorded.</p>
      </div>
      <div className="history-block">
        <h2>Current medicines</h2>
        <p>No current long-term medicines recorded.</p>
      </div>
      <div className="history-block">
        <h2>Allergy record</h2>
        <p>
          {patient.allergies.length > 0
            ? patient.allergies.map((allergy) => (
                <StatusPill key={allergy} tone="danger">
                  {allergy}
                </StatusPill>
              ))
            : "No known allergies recorded."}
        </p>
        {patient.allergies.length > 0 && (
          <small>
            Reaction details not recorded. Confirm with patient before
            prescribing.
          </small>
        )}
      </div>
    </section>
  )
}

export function ConsultationsTab({
  go,
  hasHistory,
  desktopSession,
}: {
  go: (page: Page) => void
  hasHistory: boolean
  desktopSession?: DesktopSessionContext | null
}) {
  return (
    <section className="panel record-list">
      <div className="panel-head">
        <div>
          <h2>Consultation history</h2>
          <p>Finalized visits cannot be overwritten</p>
        </div>
        <Button size="sm" onClick={() => go("consultation")} icon={Plus}>
          New consultation
        </Button>
      </div>
      {hasHistory ? (
        [
          ["Today", "Draft", "Follow-up visit"],
          ["12 Mar 2025", "Finalized", "New consultation"],
          ["18 Nov 2024", "Finalized", "Routine consultation"],
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
              <small>{desktopSession?.doctor_name || "Doctor"} · {r[0]}</small>
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
  hasHistory,
}: {
  go: (page: Page) => void
  hasHistory: boolean
}) {
  return (
    <section className="panel record-list">
      <div className="panel-head">
        <div>
          <h2>Prescription history</h2>
          <p>Finalized records and tracked revisions</p>
        </div>
      </div>
      {hasHistory ? (
        [
          ["12 Mar 2025", "Revision 1", "Delivered"],
          ["18 Nov 2024", "Original", "Printed"],
          ["03 Jul 2024", "Original", "Delivered"],
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
