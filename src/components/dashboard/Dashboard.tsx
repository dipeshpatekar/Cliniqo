import { Button, IconButton, StatusPill } from "../common"
import { AppHeader } from "../layout"
import type { Page, Patient } from "../../types"
import {
  AlertCircle,
  CalendarDays,
  ChevronRight,
  MessageCircle,
  Search,
  Stethoscope,
  UserRoundPlus,
  Users,
} from "lucide-react"

export function Dashboard({
  go,
  patients,
  onOpenPatient,
}: {
  go: (page: Page) => void
  patients: Patient[]
  onOpenPatient: (patient: Patient) => void
}) {
  const seenToday = patients.filter((patient) =>
    patient.lastVisit.toLowerCase().startsWith("today"),
  ).length
  const allergyRecords = patients.filter(
    (patient) => patient.allergies.length > 0,
  ).length
  const recordedConditions = patients.reduce(
    (total, patient) => total + patient.conditions.length,
    0,
  )

  const todayStr = new Date().toLocaleDateString("en-IN", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  })

  return (
    <>
      <AppHeader title="Doctor workspace" subtitle={todayStr}>
        <IconButton label="Find patient" onClick={() => go("patients")}>
          <Search size={18} />
        </IconButton>
        <Button icon={UserRoundPlus} onClick={() => go("patient-form")}>
          Add patient
        </Button>
      </AppHeader>
      <div className="page-content dashboard-page">
        <section className="stat-grid" aria-label="Clinic statistics">
          {[
            {
              label: "Patient records",
              value: String(patients.length),
              note: "Encrypted SQLite records",
              icon: Users,
            },
            {
              label: "Seen today",
              value: String(seenToday),
              note: "From recorded visits",
              icon: CalendarDays,
            },
            {
              label: "Allergy records",
              value: String(allergyRecords),
              note: "Require clinical review",
              icon: AlertCircle,
            },
            {
              label: "Recorded conditions",
              value: String(recordedConditions),
              note: "Across active patients",
              icon: Stethoscope,
            },
          ].map((stat) => (
            <article className="stat-item" key={stat.label}>
              <div className="stat-icon">
                <stat.icon size={19} />
              </div>
              <div>
                <span>{stat.label}</span>
                <strong>{stat.value}</strong>
                <small>{stat.note}</small>
              </div>
            </article>
          ))}
        </section>

        <div className="dashboard-columns">
          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>Recent consultations</h2>
                <p>Today’s patient activity</p>
              </div>
              <button className="text-btn" onClick={() => go("patients")}>
                View all <ChevronRight size={15} />
              </button>
            </div>
            <div className="consultation-list">
              {patients.filter(
                (patient) => patient.lastVisit !== "No visits yet",
              ).length === 0 ? (
                <div className="p-8 text-center text-slate-500 dark:text-slate-400">
                  <p className="text-sm">
                    No recent patient consultations recorded yet.
                  </p>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="mt-3"
                    onClick={() => go("patient-form")}
                  >
                    Add new patient
                  </Button>
                </div>
              ) : (
                patients
                  .filter((patient) => patient.lastVisit !== "No visits yet")
                  .slice(0, 4)
                  .map((patient) => (
                    <button
                      className="consultation-row"
                      key={patient.id}
                      onClick={() => onOpenPatient(patient)}
                    >
                      <span className="avatar subtle">{patient.initials}</span>
                      <span className="patient-cell">
                        <strong>{patient.name}</strong>
                        <small>
                          {patient.id} · {patient.age} yrs
                        </small>
                      </span>
                      <span className="visit-reason">Recorded visit</span>
                      <StatusPill
                        tone={
                          patient.syncStatus === "SYNCED"
                            ? "success"
                            : "neutral"
                        }
                      >
                        {patient.syncStatus || "Local record"}
                      </StatusPill>
                      <span className="time">{patient.lastVisit}</span>
                      <ChevronRight size={17} />
                    </button>
                  ))
              )}
            </div>
          </section>
          <div className="side-stack">
            <section className="panel action-panel">
              <div className="panel-head">
                <div>
                  <h2>Quick actions</h2>
                  <p>Common daily tasks</p>
                </div>
              </div>
              <button onClick={() => go("patient-form")}>
                <span>
                  <UserRoundPlus size={19} />
                </span>
                <div>
                  <strong>Add a new patient</strong>
                  <small>Create an encrypted patient record</small>
                </div>
                <ChevronRight size={17} />
              </button>
              <button onClick={() => go("patients")}>
                <span>
                  <Search size={19} />
                </span>
                <div>
                  <strong>Find a patient</strong>
                  <small>Search records and visit history</small>
                </div>
                <ChevronRight size={17} />
              </button>
            </section>
            <section className="panel delivery-panel">
              <div className="panel-head">
                <div>
                  <h2>WhatsApp delivery</h2>
                  <p>Provider messaging status</p>
                </div>
                <MessageCircle size={19} />
              </div>
              <div className="delivery-counts">
                <div>
                  <strong>—</strong>
                  <span>
                    <i className="dot success" /> Delivered
                  </span>
                </div>
                <div>
                  <strong>—</strong>
                  <span>
                    <i className="dot warning" /> Queued
                  </span>
                </div>
                <div>
                  <strong>—</strong>
                  <span>
                    <i className="dot danger" /> Failed
                  </span>
                </div>
              </div>
              <button className="failure-row" onClick={() => go("settings")}>
                <AlertCircle size={16} />
                <span>View messaging configuration</span>
                <ChevronRight size={16} />
              </button>
            </section>
          </div>
        </div>
      </div>
    </>
  )
}
