import { useMemo, useState, useEffect } from "react"
import {
  ArrowLeft,
  UserRoundPlus,
  Search,
  X,
  AlertCircle,
  ReceiptIndianRupee,
  PencilLine,
  Trash2,
  MoreHorizontal,
} from "lucide-react"
import type { Page, Patient } from "../../types"
import { Button, IconButton, SelectInput, ConfirmDialog } from "../common"
import { AppHeader } from "../layout"

export interface PatientsPageProps {
  go: (page: Page) => void
  patients: Patient[]
  onOpenPatient: (patient: Patient) => void
  onStartConsultation: (patient: Patient) => void
  onCreateBill: (patient: Patient) => void
  onEditPatient: (patient: Patient) => void
  onDeletePatient?: (patientId: string) => void
}

export function PatientsPage({
  go,
  patients,
  onOpenPatient,
  onStartConsultation,
  onCreateBill,
  onEditPatient,
  onDeletePatient,
}: PatientsPageProps) {
  const [query, setQuery] = useState("")
  const [gender, setGender] = useState("All patients")
  const [sort, setSort] = useState("Recent visit")
  const [currentPage, setCurrentPage] = useState(1)
  const [patientPendingDelete, setPatientPendingDelete] =
    useState<Patient | null>(null)

  const pageSize = 5

  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    const matches = patients.filter(
      (patient) =>
        `${patient.name} ${patient.id} ${patient.phone}`
          .toLowerCase()
          .includes(normalizedQuery) &&
        (gender === "All patients" || patient.gender === gender),
    )
    if (sort === "Name A–Z")
      return [...matches].sort((a, b) => a.name.localeCompare(b.name))
    if (sort === "Newest added") {
      return [...matches].sort(
        (a, b) =>
          Number(b.id.replace(/\D/g, "")) - Number(a.id.replace(/\D/g, "")),
      )
    }
    return matches
  }, [patients, query, gender, sort])

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const page = Math.min(currentPage, totalPages)
  const visiblePatients = filtered.slice((page - 1) * pageSize, page * pageSize)

  useEffect(() => setCurrentPage(1), [query, gender, sort])

  const handleConfirmDelete = () => {
    if (patientPendingDelete && onDeletePatient) {
      onDeletePatient(patientPendingDelete.id)
    }
    setPatientPendingDelete(null)
  }

  return (
    <>
      <AppHeader
        title="Patients"
        subtitle={`${patients.length} patient records in this clinic`}
      >
        <IconButton
          className="topbar-back"
          label="Back to dashboard"
          onClick={() => go("dashboard")}
        >
          <ArrowLeft size={18} />
        </IconButton>
        <Button icon={UserRoundPlus} onClick={() => go("patient-form")}>
          Add patient
        </Button>
      </AppHeader>

      <div className="page-content">
        <section className="patients-toolbar">
          <div className="search-box">
            <Search size={18} />
            <input
              aria-label="Search patients"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name, patient ID, or phone"
            />
            {query && (
              <IconButton label="Clear search" onClick={() => setQuery("")}>
                <X size={16} />
              </IconButton>
            )}
          </div>
          <SelectInput
            aria-label="Filter patients"
            value={gender}
            onChange={(e) => setGender(e.target.value)}
          >
            <option>All patients</option>
            <option>Female</option>
            <option>Male</option>
          </SelectInput>
          <SelectInput
            aria-label="Sort patients"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            <option>Recent visit</option>
            <option>Name A–Z</option>
            <option>Newest added</option>
          </SelectInput>
        </section>

        <section className="table-panel">
          {filtered.length ? (
            <div className="table-wrap">
              <table>
                <caption className="sr-only">
                  Patient records matching the current search, filter, and sort
                </caption>
                <thead>
                  <tr>
                    <th>Patient</th>
                    <th>Patient ID</th>
                    <th>Age / Gender</th>
                    <th>Mobile</th>
                    <th>Last visit</th>
                    <th>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visiblePatients.map((patient) => (
                    <tr key={patient.id}>
                      <td>
                        <button
                          className="patient-name"
                          onClick={() => onOpenPatient(patient)}
                        >
                          <span className="avatar subtle">
                            {patient.initials}
                          </span>
                          <span>
                            <strong>{patient.name}</strong>
                            {patient.allergies.length > 0 && (
                              <small className="allergy-mini">
                                <AlertCircle size={12} /> Allergy recorded
                              </small>
                            )}
                          </span>
                        </button>
                      </td>
                      <td>
                        <span className="mono-id">{patient.displayId || patient.id}</span>
                      </td>
                      <td>
                        {patient.age} yrs{" "}
                        <span className="muted">· {patient.gender}</span>
                      </td>
                      <td>{patient.phone}</td>
                      <td>{patient.lastVisit}</td>
                      <td>
                        <div className="row-actions">
                          <Button
                            size="sm"
                            variant="secondary"
                            icon={ReceiptIndianRupee}
                            onClick={() => onCreateBill(patient)}
                          >
                            Bill
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => onStartConsultation(patient)}
                          >
                            Start consultation
                          </Button>
                          <IconButton
                            label={`Edit ${patient.name}`}
                            onClick={() => onEditPatient(patient)}
                          >
                            <PencilLine size={16} />
                          </IconButton>
                          {onDeletePatient && (
                            <IconButton
                              label={`Delete ${patient.name}`}
                              onClick={() => setPatientPendingDelete(patient)}
                            >
                              <Trash2 size={16} />
                            </IconButton>
                          )}
                          <IconButton
                            label={`More actions for ${patient.name}`}
                            onClick={() => onOpenPatient(patient)}
                          >
                            <MoreHorizontal size={18} />
                          </IconButton>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty-state">
              <Search size={28} />
              <h2>No patients found</h2>
              <p>Try a different name, ID, phone number, or filter.</p>
              <Button
                variant="secondary"
                onClick={() => {
                  setQuery("")
                  setGender("All patients")
                }}
              >
                Clear filters
              </Button>
            </div>
          )}

          <div className="table-footer">
            <span role="status" aria-live="polite">
              Showing {filtered.length ? (page - 1) * pageSize + 1 : 0}–
              {Math.min(page * pageSize, filtered.length)} of {filtered.length}{" "}
              matching patients
            </span>
            <div>
              <Button
                size="sm"
                variant="ghost"
                disabled={page === 1}
                onClick={() =>
                  setCurrentPage((value) => Math.max(1, value - 1))
                }
              >
                Previous
              </Button>
              <span
                className="page-number"
                aria-label={`Page ${page} of ${totalPages}`}
              >
                {page}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={page === totalPages}
                onClick={() =>
                  setCurrentPage((value) => Math.min(totalPages, value + 1))
                }
              >
                Next
              </Button>
            </div>
          </div>
        </section>
      </div>

      <ConfirmDialog
        isOpen={Boolean(patientPendingDelete)}
        title="Delete Patient Record"
        description={
          patientPendingDelete
            ? `Are you sure you want to delete patient "${patientPendingDelete.name}" (${patientPendingDelete.id})? This action removes the local record.`
            : ""
        }
        confirmLabel="Delete Patient"
        confirmVariant="danger"
        onConfirm={handleConfirmDelete}
        onCancel={() => setPatientPendingDelete(null)}
      />
    </>
  )
}

export default PatientsPage
