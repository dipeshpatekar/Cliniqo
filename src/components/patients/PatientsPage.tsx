import { useMemo, useState, useEffect, useRef, memo } from "react"
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
  Calendar,
} from "lucide-react"
import {
  formatDateDDMMYYYY,
  formatDateTimeDDMMYYYY,
  formatPatientVisitDateTime,
  formatPatientAge,
  formatPatientGender,
  getPublicPatientId,
  mapLocalRecordToPatient,
  type Page,
  type Patient,
} from "../../types"
import {
  getLocalPatientsPage,
  isTauriDesktop,
  type DesktopSessionContext,
} from "../../desktop/desktop-bridge"
import { Button, IconButton, SelectInput, ConfirmDialog } from "../common"
import { AppHeader } from "../layout"
import { cn } from "../../utils/cn"
import { hasGenuineAllergies } from "../../utils/allergy"

export interface PatientsPageProps {
  go: (page: Page) => void
  patients: Patient[]
  desktopSession?: DesktopSessionContext | null
  refreshTrigger?: number
  onOpenPatient: (patient: Patient) => void
  onStartConsultation: (patient: Patient) => void
  onCreateBill: (patient: Patient) => void
  onEditPatient: (patient: Patient) => void
  onDeletePatient?: (patientId: string) => void
}

function parsePatientCreationDate(patient: Patient): number {
  if (patient.createdAt) {
    const parsed = Date.parse(patient.createdAt)
    if (!isNaN(parsed)) return parsed
  }
  if (patient.registeredAt) {
    const parsed = Date.parse(patient.registeredAt)
    if (!isNaN(parsed)) return parsed
  }
  return 0
}

function parsePatientDate(patient: Patient): number {
  const lastVisit = patient.lastVisit
  if (lastVisit && lastVisit !== "No visits yet") {
    const lower = lastVisit.toLowerCase().trim()
    const now = new Date()
    if (lower.startsWith("today")) {
      const timeMatch = lower.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i)
      if (timeMatch) {
        let hours = parseInt(timeMatch[1], 10)
        const minutes = parseInt(timeMatch[2], 10)
        const meridian = timeMatch[3]?.toLowerCase()
        if (meridian === "pm" && hours < 12) hours += 12
        if (meridian === "am" && hours === 12) hours = 0
        const d = new Date(now)
        d.setHours(hours, minutes, 0, 0)
        return d.getTime()
      }
      return now.getTime()
    }
    if (lower.startsWith("yesterday")) {
      return now.getTime() - 86400000
    }
    const dmy = lower.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
    if (dmy) {
      const d = parseInt(dmy[1], 10)
      const m = parseInt(dmy[2], 10) - 1
      const y = parseInt(dmy[3], 10)
      return new Date(y, m, d).getTime()
    }
    const parsed = Date.parse(lastVisit)
    if (!isNaN(parsed)) return parsed
  }
  if (patient.updatedAt) {
    const parsed = Date.parse(patient.updatedAt)
    if (!isNaN(parsed)) return parsed
  }
  if (patient.createdAt) {
    const parsed = Date.parse(patient.createdAt)
    if (!isNaN(parsed)) return parsed
  }
  return 0
}

export const PatientsPage = memo(function PatientsPage({
  go,
  patients,
  desktopSession,
  refreshTrigger = 0,
  onOpenPatient,
  onStartConsultation,
  onCreateBill,
  onEditPatient,
  onDeletePatient,
}: PatientsPageProps) {
  const [query, setQuery] = useState("")
  const [gender, setGender] = useState("All patients")
  const [sort, setSort] = useState("Created Date (newest first)")
  const [startDate, setStartDate] = useState("")
  const [endDate, setEndDate] = useState("")
  const [showDateFilter, setShowDateFilter] = useState(false)
  const [currentPage, setCurrentPage] = useState(1)
  const [patientPendingDelete, setPatientPendingDelete] =
    useState<Patient | null>(null)
  const [remoteItems, setRemoteItems] = useState<Patient[] | null>(null)
  const [remoteTotal, setRemoteTotal] = useState(0)
  const [remoteClinicTotal, setRemoteClinicTotal] = useState(0)
  const [isLoadingPage, setIsLoadingPage] = useState(false)
  const [pageError, setPageError] = useState<string | null>(null)
  const requestSeqRef = useRef(0)
  const lastQueryRef = useRef(query)

  const pageSize = 50
  const hasDateFilter = Boolean(startDate || endDate)
  const useDesktopPagination = Boolean(
    desktopSession?.clinic_id && isTauriDesktop(),
  )

  useEffect(() => {
    if (!useDesktopPagination || !desktopSession?.clinic_id) {
      return
    }
    const seq = ++requestSeqRef.current
    const queryChanged = lastQueryRef.current !== query
    lastQueryRef.current = query
    const delayMs = queryChanged && query.trim().length > 0 ? 150 : 0

    const timer = window.setTimeout(() => {
      setIsLoadingPage(true)
      setPageError(null)
      getLocalPatientsPage({
        clinic_id: desktopSession.clinic_id,
        query: query.trim() || null,
        gender,
        sort,
        start_date: startDate || null,
        end_date: endDate || null,
        limit: pageSize,
        offset: (currentPage - 1) * pageSize,
      })
        .then((res) => {
          if (requestSeqRef.current !== seq) return
          if (res.items.length === 0 && res.total > 0 && currentPage > 1) {
            const clampedPage = Math.max(1, Math.ceil(res.total / pageSize))
            if (clampedPage !== currentPage) {
              setCurrentPage(clampedPage)
              return
            }
          }
          const mapped = res.items.map(mapLocalRecordToPatient)
          setRemoteItems(mapped)
          setRemoteTotal(res.total)
          setRemoteClinicTotal(res.clinic_total)
        })
        .catch((err) => {
          if (requestSeqRef.current !== seq) return
          setPageError(
            err instanceof Error
              ? err.message
              : "Failed to load patient records from local database.",
          )
        })
        .finally(() => {
          if (requestSeqRef.current === seq) {
            setIsLoadingPage(false)
          }
        })
    }, delayMs)

    return () => {
      window.clearTimeout(timer)
    }
  }, [
    useDesktopPagination,
    desktopSession?.clinic_id,
    query,
    gender,
    sort,
    startDate,
    endDate,
    currentPage,
    refreshTrigger,
  ])

  const filtered = useMemo(() => {
    if (useDesktopPagination) {
      return []
    }
    const normalizedQuery = query.trim().toLowerCase()
    const matches = patients.filter((patient) => {
      const publicId = getPublicPatientId(patient)
      const searchTarget =
        `${patient.name} ${publicId} ${patient.phone} ${patient.id}`.toLowerCase()
      const matchesQuery = searchTarget.includes(normalizedQuery)
      const matchesGender =
        gender === "All patients" || patient.gender === gender

      let matchesDate = true
      if (startDate || endDate) {
        const patientMs = parsePatientDate(patient)
        if (!patientMs) {
          matchesDate = false
        } else {
          if (startDate) {
            const [sY, sM, sD] = startDate.split("-").map(Number)
            const startMs = new Date(sY, sM - 1, sD, 0, 0, 0, 0).getTime()
            if (patientMs < startMs) matchesDate = false
          }
          if (endDate) {
            const [eY, eM, eD] = endDate.split("-").map(Number)
            const endMs = new Date(eY, eM - 1, eD, 23, 59, 59, 999).getTime()
            if (patientMs > endMs) matchesDate = false
          }
        }
      }

      return matchesQuery && matchesGender && matchesDate
    })
    if (
      sort === "Created Date (newest first)" ||
      sort === "Newest added" ||
      sort === "Created Date → Newest to Oldest (DESC)"
    ) {
      return [...matches].sort((a, b) => {
        const timeA = parsePatientCreationDate(a)
        const timeB = parsePatientCreationDate(b)
        if (timeA !== timeB) return timeB - timeA
        const numA = Number(getPublicPatientId(a).replace(/\D/g, "")) || 0
        const numB = Number(getPublicPatientId(b).replace(/\D/g, "")) || 0
        return numB - numA
      })
    }
    if (sort === "Created Date (oldest first)") {
      return [...matches].sort((a, b) => {
        const timeA = parsePatientCreationDate(a)
        const timeB = parsePatientCreationDate(b)
        if (timeA !== timeB) return timeA - timeB
        const numA = Number(getPublicPatientId(a).replace(/\D/g, "")) || 0
        const numB = Number(getPublicPatientId(b).replace(/\D/g, "")) || 0
        return numA - numB
      })
    }
    if (sort === "Name A–Z") {
      return [...matches].sort((a, b) => a.name.localeCompare(b.name))
    }
    if (sort === "Name Z–A") {
      return [...matches].sort((a, b) => b.name.localeCompare(a.name))
    }
    if (
      sort === "Sort by date" ||
      sort === "Recent visit" ||
      sort === "Date (newest first)"
    ) {
      return [...matches].sort((a, b) => {
        const timeA = parsePatientDate(a)
        const timeB = parsePatientDate(b)
        if (timeA !== timeB) return timeB - timeA
        const numA = Number(getPublicPatientId(a).replace(/\D/g, "")) || 0
        const numB = Number(getPublicPatientId(b).replace(/\D/g, "")) || 0
        return numB - numA
      })
    }
    if (sort === "Date (oldest first)") {
      return [...matches].sort((a, b) => {
        const timeA = parsePatientDate(a)
        const timeB = parsePatientDate(b)
        if (timeA !== timeB) return timeA - timeB
        const numA = Number(getPublicPatientId(a).replace(/\D/g, "")) || 0
        const numB = Number(getPublicPatientId(b).replace(/\D/g, "")) || 0
        return numA - numB
      })
    }
    return matches
  }, [useDesktopPagination, patients, query, gender, sort, startDate, endDate])

  const totalMatching = useDesktopPagination
    ? remoteItems !== null
      ? remoteTotal
      : patients.length
    : filtered.length
  const clinicTotal = useDesktopPagination
    ? remoteItems !== null
      ? remoteClinicTotal
      : patients.length
    : patients.length
  const totalPages = Math.max(1, Math.ceil(totalMatching / pageSize))
  const page = Math.min(currentPage, totalPages)
  const visiblePatients = useDesktopPagination
    ? (remoteItems ?? patients.slice(0, pageSize))
    : filtered.slice((page - 1) * pageSize, page * pageSize)

  const updateQuery = (next: string) => {
    setCurrentPage(1)
    setQuery(next)
  }

  const updateGender = (next: string) => {
    setCurrentPage(1)
    setGender(next)
  }

  const updateSort = (next: string) => {
    setCurrentPage(1)
    setSort(next)
  }

  const updateStartDate = (next: string) => {
    setCurrentPage(1)
    setStartDate(next)
  }

  const updateEndDate = (next: string) => {
    setCurrentPage(1)
    setEndDate(next)
  }

  const applyPresetToday = () => {
    const now = new Date()
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
    setCurrentPage(1)
    setStartDate(todayStr)
    setEndDate(todayStr)
  }

  const applyPreset7Days = () => {
    const now = new Date()
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
    const past = new Date(now.getTime() - 7 * 86400000)
    const pastStr = `${past.getFullYear()}-${String(past.getMonth() + 1).padStart(2, "0")}-${String(past.getDate()).padStart(2, "0")}`
    setCurrentPage(1)
    setStartDate(pastStr)
    setEndDate(todayStr)
  }

  const applyPreset30Days = () => {
    const now = new Date()
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
    const past = new Date(now.getTime() - 30 * 86400000)
    const pastStr = `${past.getFullYear()}-${String(past.getMonth() + 1).padStart(2, "0")}-${String(past.getDate()).padStart(2, "0")}`
    setCurrentPage(1)
    setStartDate(pastStr)
    setEndDate(todayStr)
  }

  const applyPresetThisMonth = () => {
    const now = new Date()
    const startStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
    setCurrentPage(1)
    setStartDate(startStr)
    setEndDate(todayStr)
  }

  const clearDateRange = () => {
    setCurrentPage(1)
    setStartDate("")
    setEndDate("")
  }

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
        subtitle={
          `${
            hasDateFilter
              ? `${totalMatching} of ${clinicTotal} patient records in selected date range`
              : `${clinicTotal} patient records in this clinic`
          }${isLoadingPage && remoteItems !== null ? " · Updating..." : ""}`
        }
      >
        <IconButton
          className="topbar-back"
          label="Back to dashboard"
          onClick={() => go("dashboard")}
        >
          <ArrowLeft size={18} />
        </IconButton>
        <Button
          icon={UserRoundPlus}
          title="Add patient (Ctrl+N)"
          onClick={() => go("patient-form")}
        >
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
              onChange={(e) => updateQuery(e.target.value)}
              placeholder="Search by name, patient ID, or phone"
            />
            {query && (
              <IconButton label="Clear search" onClick={() => updateQuery("")}>
                <X size={16} />
              </IconButton>
            )}
          </div>
          <button
            type="button"
            className={cn(
              "date-range-toggle-btn",
              (showDateFilter || hasDateFilter) && "active",
            )}
            onClick={() => setShowDateFilter((prev) => !prev)}
            aria-expanded={showDateFilter}
            aria-label="Filter by date range"
          >
            <Calendar size={16} />
            <span>
              {hasDateFilter
                ? `${formatDateDDMMYYYY(startDate) || "Start"} → ${formatDateDDMMYYYY(endDate) || "End"}`
                : "Select date range"}
            </span>
            {hasDateFilter && (
              <span
                className="date-clear-pill"
                role="button"
                tabIndex={0}
                title="Clear date range"
                onClick={(e) => {
                  e.stopPropagation()
                  clearDateRange()
                }}
              >
                <X size={12} />
              </span>
            )}
          </button>
          <SelectInput
            aria-label="Filter patients"
            value={gender}
            onChange={(e) => updateGender(e.target.value)}
          >
            <option>All patients</option>
            <option>Female</option>
            <option>Male</option>
          </SelectInput>
          <SelectInput
            aria-label="Sort patients"
            value={sort}
            onChange={(e) => updateSort(e.target.value)}
          >
            <option>Created Date (newest first)</option>
            <option>Created Date (oldest first)</option>
            <option>Recent visit</option>
            <option>Sort by date</option>
            <option>Date (newest first)</option>
            <option>Date (oldest first)</option>
            <option>Name A–Z</option>
            <option>Name Z–A</option>
            <option>Newest added</option>
          </SelectInput>
        </section>

        {showDateFilter && (
          <div
            className="date-filter-panel"
            role="region"
            aria-label="Manual date range search"
          >
            <div className="date-filter-inputs">
              <div className="date-field">
                <label htmlFor="patient-filter-from">From date</label>
                <input
                  id="patient-filter-from"
                  type="date"
                  value={startDate}
                  onChange={(e) => updateStartDate(e.target.value)}
                />
              </div>
              <div className="date-field">
                <label htmlFor="patient-filter-to">To date</label>
                <input
                  id="patient-filter-to"
                  type="date"
                  value={endDate}
                  onChange={(e) => updateEndDate(e.target.value)}
                />
              </div>
            </div>
            <div className="date-filter-presets">
              <button
                type="button"
                className="preset-btn"
                onClick={applyPresetToday}
              >
                Today
              </button>
              <button
                type="button"
                className="preset-btn"
                onClick={applyPreset7Days}
              >
                Last 7 days
              </button>
              <button
                type="button"
                className="preset-btn"
                onClick={applyPreset30Days}
              >
                Last 30 days
              </button>
              <button
                type="button"
                className="preset-btn"
                onClick={applyPresetThisMonth}
              >
                This month
              </button>
              {hasDateFilter && (
                <button
                  type="button"
                  className="preset-btn clear"
                  onClick={clearDateRange}
                >
                  Clear dates
                </button>
              )}
            </div>
          </div>
        )}

        <section className="table-panel">
          {pageError ? (
            <div className="empty-state" role="alert">
              <AlertCircle size={28} />
              <h2>Unable to load patients</h2>
              <p>{pageError}</p>
            </div>
          ) : isLoadingPage && remoteItems === null ? (
            <div className="empty-state" role="status">
              <Search size={28} />
              <h2>Loading patients...</h2>
              <p>Fetching clinic records from encrypted local storage.</p>
            </div>
          ) : visiblePatients.length ? (
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
                    <th
                      style={{ cursor: "pointer", userSelect: "none" }}
                      onClick={() =>
                        setSort((prev) =>
                          prev === "Sort by date" ||
                          prev === "Date (newest first)"
                            ? "Date (oldest first)"
                            : "Sort by date",
                        )
                      }
                      title="Click to sort by date"
                    >
                      Last visit{" "}
                      {sort === "Sort by date" || sort === "Date (newest first)"
                        ? "↓"
                        : sort === "Date (oldest first)"
                          ? "↑"
                          : ""}
                    </th>
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
                            {hasGenuineAllergies(patient.allergies) && (
                              <small className="allergy-mini">
                                <AlertCircle size={12} /> Allergy recorded
                              </small>
                            )}
                          </span>
                        </button>
                      </td>
                      <td>
                        <span className="mono-id">
                          {getPublicPatientId(patient)}
                        </span>
                      </td>
                      <td>
                        {formatPatientAge(patient.age, "yrs", patient.ageMonths)}{" "}
                        <span className="muted">
                          · {formatPatientGender(patient.gender)}
                        </span>
                      </td>
                      <td>{patient.phone || "—"}</td>
                      <td>
                        {formatPatientVisitDateTime(
                          patient.lastVisit ||
                            patient.registeredAt ||
                            patient.createdAt,
                        )}
                      </td>
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
                  setCurrentPage(1)
                  setQuery("")
                  setGender("All patients")
                  setStartDate("")
                  setEndDate("")
                }}
              >
                Clear filters
              </Button>
            </div>
          )}

          <div className="table-footer">
            <span role="status" aria-live="polite">
              Showing {totalMatching ? (page - 1) * pageSize + 1 : 0}–
              {Math.min(page * pageSize, totalMatching)} of {totalMatching}{" "}
              matching patients
            </span>
            <div>
              <Button
                size="sm"
                variant="ghost"
                disabled={page === 1 || isLoadingPage}
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
                disabled={page === totalPages || isLoadingPage}
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
})

export default PatientsPage
