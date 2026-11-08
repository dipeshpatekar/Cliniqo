import { useState, useEffect, useMemo, type ComponentType } from "react"
import {
  AlertCircle,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Clock,
  Copy,
  Download,
  Edit3,
  FileText,
  Filter,
  HeartPulse,
  Layers,
  Pill,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Split,
  Upload,
  User,
  Users,
  X,
} from "lucide-react"
import {
  type SyncConflictRecord,
  getSyncConflicts,
  resolveSyncConflict,
  isTauriDesktop,
} from "../desktop/desktop-bridge"
import { formatDateTimeDDMMYYYY } from "../types"

interface ConflictResolutionModalProps {
  isOpen: boolean
  onClose: () => void
  activeClinicId: string
  onConflictResolved?: (conflictId: string, strategy: string) => void
  initialConflictId?: string | null
}

interface ParsedPatientPayload {
  name?: string
  phone?: string
  gender?: string
  age?: number
  dateOfBirth?: string
  date_of_birth?: string
  patientId?: string
  patientCode?: string
  allergies?: string[]
  conditions?: string[]
  sensitiveNotes?: string
  sensitive_notes?: string
}

interface ParsedConsultationPayload {
  consultationDate?: string
  consultation_date?: string
  chiefComplaint?: string
  chief_complaint?: string
  diagnosis?: string
  clinicalSnapshot?: {
    vitals?: Record<string, string>
    symptomDuration?: string
    followUpDate?: string
    followUpInstructions?: string
  }
  clinicalSnapshotJson?: string
  clinical_snapshot_json?: string
}

interface MedicineItem {
  id?: number | string
  name?: string
  formulation?: string
  strength?: string
  dose?: string
  route?: string
  frequency?: string
  duration?: string
  food?: string
  directions?: string
}

interface ParsedPrescriptionPayload {
  prescriptionNumber?: string
  prescription_number?: string
  revisionNumber?: number
  revision_number?: number
  status?: string
  items?: MedicineItem[]
  itemsJson?: string
  items_json?: string
}

function safeParseJson<T>(raw: unknown): T | null {
  if (!raw) return null
  if (typeof raw === "object") return raw as T
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as T
    } catch {
      return null
    }
  }
  return null
}

export function ConflictResolutionModal({
  isOpen,
  onClose,
  activeClinicId,
  onConflictResolved,
  initialConflictId,
}: ConflictResolutionModalProps) {
  const [conflicts, setConflicts] = useState<SyncConflictRecord[]>([])
  const [selectedConflictId, setSelectedConflictId] = useState<string | null>(
    null,
  )
  const [statusFilter, setStatusFilter] = useState<"ALL" | "OPEN" | "RESOLVED">(
    "OPEN",
  )
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionSuccess, setActionSuccess] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false)

  // Manual merge state
  const [isMerging, setIsMerging] = useState<boolean>(false)
  const [mergedPatient, setMergedPatient] = useState<ParsedPatientPayload>({})
  const [mergedConsultation, setMergedConsultation] =
    useState<ParsedConsultationPayload>({})
  const [mergedPrescription, setMergedPrescription] =
    useState<ParsedPrescriptionPayload>({})

  // Confirmation dialog state
  const [confirmStrategy, setConfirmStrategy] =
    useState<"USE_SERVER" | "USE_LOCAL" | "MERGE_MANUAL" | "PRESERVE_BOTH" | null>(
      null,
    )

  // Load conflicts from SQLite via desktop bridge
  const loadConflicts = async () => {
    if (!activeClinicId) return
    setIsLoading(true)
    setActionError(null)
    try {
      const data = await getSyncConflicts(activeClinicId, null)
      setConflicts(data)
      if (data.length > 0) {
        if (initialConflictId && data.some((c) => c.id === initialConflictId)) {
          setSelectedConflictId(initialConflictId)
        } else if (
          !selectedConflictId ||
          !data.some((c) => c.id === selectedConflictId)
        ) {
          const firstOpen = data.find((c) => c.status === "OPEN")
          setSelectedConflictId(firstOpen ? firstOpen.id : data[0].id)
        }
      } else {
        setSelectedConflictId(null)
      }
    } catch (err) {
      console.error("[Conflict UI] Failed to load sync conflicts:", err)
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    if (isOpen) {
      loadConflicts()
      setIsMerging(false)
      setConfirmStrategy(null)
    }
  }, [isOpen, activeClinicId, initialConflictId])

  const filteredConflicts = useMemo(() => {
    if (statusFilter === "ALL") return conflicts
    return conflicts.filter((c) => c.status === statusFilter)
  }, [conflicts, statusFilter])

  const activeConflict = useMemo(() => {
    return conflicts.find((c) => c.id === selectedConflictId) || null
  }, [conflicts, selectedConflictId])

  // Parsed client and server representations
  const clientData = useMemo(() => {
    return safeParseJson<Record<string, unknown>>(
      activeConflict?.client_payload,
    )
  }, [activeConflict])

  const serverData = useMemo(() => {
    return safeParseJson<Record<string, unknown>>(
      activeConflict?.server_payload,
    )
  }, [activeConflict])

  // Reset merge workspace whenever active conflict changes
  useEffect(() => {
    if (!activeConflict) {
      setIsMerging(false)
      return
    }

    setIsMerging(false)
    setActionError(null)
    setActionSuccess(null)

    const client = safeParseJson<any>(activeConflict.client_payload) || {}
    const server = safeParseJson<any>(activeConflict.server_payload) || {}

    if (activeConflict.entity_type === "PATIENT") {
      // Initialize merge with union of allergies and conditions
      const clientAllergies: string[] = Array.isArray(client.allergies)
        ? client.allergies
        : []
      const serverAllergies: string[] = Array.isArray(server.allergies)
        ? server.allergies
        : []
      const mergedAllergies = Array.from(
        new Set([...clientAllergies, ...serverAllergies]),
      )

      const clientConditions: string[] = Array.isArray(client.conditions)
        ? client.conditions
        : []
      const serverConditions: string[] = Array.isArray(server.conditions)
        ? server.conditions
        : []
      const mergedConditions = Array.from(
        new Set([...clientConditions, ...serverConditions]),
      )

      setMergedPatient({
        name: client.name || server.name || "",
        phone: client.phone || server.phone || "",
        gender: client.gender || server.gender || "OTHER",
        age: client.age ?? server.age ?? 0,
        dateOfBirth:
          client.dateOfBirth ||
          client.date_of_birth ||
          server.dateOfBirth ||
          server.date_of_birth ||
          "",
        patientId:
          client.patientId ||
          client.patientCode ||
          server.patientId ||
          server.patientCode ||
          activeConflict.entity_id,
        allergies: mergedAllergies,
        conditions: mergedConditions,
        sensitiveNotes:
          client.sensitiveNotes ||
          client.sensitive_notes ||
          server.sensitiveNotes ||
          server.sensitive_notes ||
          "",
      })
    } else if (activeConflict.entity_type === "CONSULTATION") {
      const clientSnapshot =
        client.clinicalSnapshot ||
        safeParseJson(
          client.clinicalSnapshotJson || client.clinical_snapshot_json,
        ) ||
        {}
      const serverSnapshot =
        server.clinicalSnapshot ||
        safeParseJson(
          server.clinicalSnapshotJson || server.clinical_snapshot_json,
        ) ||
        {}

      setMergedConsultation({
        consultationDate:
          client.consultationDate ||
          client.consultation_date ||
          server.consultationDate ||
          server.consultation_date ||
          "",
        chiefComplaint:
          client.chiefComplaint ||
          client.chief_complaint ||
          server.chiefComplaint ||
          server.chief_complaint ||
          "",
        diagnosis: client.diagnosis || server.diagnosis || "",
        clinicalSnapshot: {
          vitals: {
            ...(serverSnapshot.vitals || {}),
            ...(clientSnapshot.vitals || {}),
          },
          symptomDuration:
            clientSnapshot.symptomDuration ||
            serverSnapshot.symptomDuration ||
            "",
          followUpDate:
            clientSnapshot.followUpDate || serverSnapshot.followUpDate || "",
          followUpInstructions:
            clientSnapshot.followUpInstructions ||
            serverSnapshot.followUpInstructions ||
            "",
        },
      })
    } else if (activeConflict.entity_type === "PRESCRIPTION") {
      const clientItems: MedicineItem[] =
        client.items ||
        safeParseJson(client.itemsJson || client.items_json) ||
        []
      const serverItems: MedicineItem[] =
        server.items ||
        safeParseJson(server.itemsJson || server.items_json) ||
        []

      // Combine medicines by unique name
      const map = new Map<string, MedicineItem>()
      for (const item of [...serverItems, ...clientItems]) {
        if (item.name) {
          map.set(item.name.toLowerCase(), item)
        }
      }

      setMergedPrescription({
        prescriptionNumber:
          client.prescriptionNumber ||
          client.prescription_number ||
          server.prescriptionNumber ||
          server.prescription_number ||
          "",
        items: Array.from(map.values()),
      })
    }
  }, [activeConflict])

  // Execute resolution
  const handleApplyResolution = async (
    strategy: "USE_SERVER" | "USE_LOCAL" | "MERGE_MANUAL" | "PRESERVE_BOTH",
  ) => {
    if (!activeConflict || !activeClinicId) return

    setIsSubmitting(true)
    setActionError(null)
    setActionSuccess(null)

    let resolutionPayload: string | null = null
    if (strategy === "MERGE_MANUAL") {
      if (activeConflict.entity_type === "PATIENT") {
        resolutionPayload = JSON.stringify(mergedPatient)
      } else if (activeConflict.entity_type === "CONSULTATION") {
        resolutionPayload = JSON.stringify(mergedConsultation)
      } else if (activeConflict.entity_type === "PRESCRIPTION") {
        resolutionPayload = JSON.stringify(mergedPrescription)
      }
    }

    try {
      const result = await resolveSyncConflict(
        activeClinicId,
        activeConflict.id,
        strategy,
        resolutionPayload,
      )

      if (result) {
        setActionSuccess(`Conflict successfully resolved using ${strategy}.`)
        setConfirmStrategy(null)
        setIsMerging(false)

        // Update local conflicts list
        setConflicts((prev) =>
          prev.map((c) =>
            c.id === activeConflict.id
              ? {
                  ...c,
                  status: "RESOLVED",
                  resolution_strategy: strategy,
                  resolved_at: new Date().toISOString(),
                  resolution_payload: resolutionPayload || c.resolution_payload,
                }
              : c,
          ),
        )

        if (onConflictResolved) {
          onConflictResolved(activeConflict.id, strategy)
        }
      } else {
        throw new Error(
          "Conflict resolution was not accepted by the desktop database.",
        )
      }
    } catch (err) {
      console.error("[Conflict UI] Failed to apply resolution:", err)
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsSubmitting(false)
    }
  }

  if (!isOpen) return null

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !isSubmitting) onClose()
      }}
    >
      <section
        className="modal modal-wide"
        style={{
          width: "min(1060px, 96vw)",
          maxHeight: "92vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="conflict-modal-title"
      >
        {/* Header */}
        <div
          className="modal-head"
          style={{ borderBottom: "1px solid var(--line)", flexShrink: 0 }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <span
              style={{
                display: "inline-flex",
                padding: "8px",
                borderRadius: "8px",
                background: "rgba(245, 158, 11, 0.12)",
                color: "#d97706",
              }}
            >
              <ShieldAlert size={22} />
            </span>
            <div>
              <div
                style={{ display: "flex", alignItems: "center", gap: "8px" }}
              >
                <h2
                  id="conflict-modal-title"
                  style={{ fontSize: "17px", fontWeight: "600", margin: 0 }}
                >
                  Clinical Sync Conflict Resolution
                </h2>
                <span
                  style={{
                    fontSize: "11px",
                    fontWeight: "600",
                    padding: "2px 8px",
                    borderRadius: "12px",
                    background: conflicts.some((c) => c.status === "OPEN")
                      ? "#fef3c7"
                      : "#e2e8f0",
                    color: conflicts.some((c) => c.status === "OPEN")
                      ? "#b45309"
                      : "#475569",
                  }}
                >
                  {conflicts.filter((c) => c.status === "OPEN").length}{" "}
                  Unresolved
                </span>
              </div>
              <p
                style={{
                  margin: "2px 0 0",
                  fontSize: "12px",
                  color: "var(--muted)",
                }}
              >
                Reconcile divergent clinical records before changes are pushed
                to cloud synchronization.
              </p>
            </div>
          </div>
          <button
            className="icon-btn"
            aria-label="Close dialog"
            onClick={onClose}
            disabled={isSubmitting}
          >
            <X size={19} />
          </button>
        </div>

        {/* Clinical Safety Banner */}
        <div
          style={{
            padding: "8px 20px",
            background: "#fffbeb",
            borderBottom: "1px solid #fde68a",
            color: "#92400e",
            fontSize: "11px",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            flexShrink: 0,
          }}
        >
          <AlertCircle size={15} style={{ flexShrink: 0 }} />
          <span>
            <strong>Clinical Safety Protocol:</strong> Differences in patient
            allergies, chronic conditions, and prescribed medications must be
            thoroughly reviewed. Never overwrite active clinical treatments
            without explicit verification.
          </span>
        </div>

        {/* Body Layout: Sidebar + Main Diff Workspace */}
        <div
          style={{ display: "flex", flex: 1, minHeight: 0, overflow: "hidden" }}
        >
          {/* Left Conflict List Column */}
          <aside
            style={{
              width: "280px",
              borderRight: "1px solid var(--line)",
              background: "#fafbfb",
              display: "flex",
              flexDirection: "column",
              flexShrink: 0,
            }}
          >
            {/* Filter Tabs */}
            <div
              style={{
                padding: "10px 14px",
                borderBottom: "1px solid var(--line)",
                display: "flex",
                gap: "6px",
              }}
            >
              <button
                className={`btn btn-sm ${
                  statusFilter === "OPEN" ? "btn-primary" : "btn-ghost"
                }`}
                style={{ fontSize: "11px", padding: "4px 8px" }}
                onClick={() => setStatusFilter("OPEN")}
              >
                Open ({conflicts.filter((c) => c.status === "OPEN").length})
              </button>
              <button
                className={`btn btn-sm ${
                  statusFilter === "ALL" ? "btn-primary" : "btn-ghost"
                }`}
                style={{ fontSize: "11px", padding: "4px 8px" }}
                onClick={() => setStatusFilter("ALL")}
              >
                All ({conflicts.length})
              </button>
              <button
                className={`btn btn-sm ${
                  statusFilter === "RESOLVED" ? "btn-primary" : "btn-ghost"
                }`}
                style={{ fontSize: "11px", padding: "4px 8px" }}
                onClick={() => setStatusFilter("RESOLVED")}
              >
                Resolved (
                {conflicts.filter((c) => c.status === "RESOLVED").length})
              </button>
            </div>

            {/* List */}
            <div style={{ flex: 1, overflowY: "auto", padding: "8px" }}>
              {isLoading && conflicts.length === 0 ? (
                <div
                  style={{
                    padding: "30px 10px",
                    textAlign: "center",
                    color: "var(--muted)",
                    fontSize: "12px",
                  }}
                >
                  <RefreshCw
                    className="animate-spin"
                    size={18}
                    style={{ margin: "0 auto 8px" }}
                  />
                  Loading sync conflicts...
                </div>
              ) : filteredConflicts.length === 0 ? (
                <div
                  style={{
                    padding: "30px 10px",
                    textAlign: "center",
                    color: "var(--muted)",
                    fontSize: "12px",
                  }}
                >
                  <CheckCircle2
                    size={24}
                    style={{ margin: "0 auto 8px", color: "var(--success)" }}
                  />
                  No conflicts in this category.
                </div>
              ) : (
                filteredConflicts.map((c) => {
                  const isSelected = c.id === selectedConflictId
                  const Icon =
                    c.entity_type === "PATIENT"
                      ? Users
                      : c.entity_type === "CONSULTATION"
                        ? ClipboardList
                        : Pill

                  return (
                    <button
                      key={c.id}
                      onClick={() => {
                        setSelectedConflictId(c.id)
                        setActionError(null)
                        setActionSuccess(null)
                        setIsMerging(false)
                      }}
                      style={{
                        width: "100%",
                        textAlign: "left",
                        padding: "10px 12px",
                        marginBottom: "6px",
                        borderRadius: "8px",
                        border: isSelected
                          ? "1.5px solid var(--accent)"
                          : "1px solid var(--line)",
                        background: isSelected ? "#f0fdf4" : "white",
                        cursor: "pointer",
                        display: "flex",
                        flexDirection: "column",
                        gap: "4px",
                        transition: "all 0.15s ease",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                        }}
                      >
                        <span
                          style={{
                            fontSize: "11px",
                            fontWeight: "600",
                            color: "var(--accent)",
                            display: "flex",
                            alignItems: "center",
                            gap: "4px",
                          }}
                        >
                          <Icon size={13} />
                          {c.entity_type}
                        </span>
                        <span
                          style={{
                            fontSize: "9px",
                            fontWeight: "600",
                            padding: "2px 6px",
                            borderRadius: "10px",
                            background:
                              c.status === "OPEN" ? "#fef3c7" : "#dcfce7",
                            color: c.status === "OPEN" ? "#92400e" : "#166534",
                          }}
                        >
                          {c.status}
                        </span>
                      </div>
                      <strong style={{ fontSize: "12px", color: "#1e293b" }}>
                        ID: {c.entity_id.slice(0, 14)}...
                      </strong>
                      <span style={{ fontSize: "10px", color: "var(--muted)" }}>
                        {formatHumanReason(c.conflict_reason)}
                      </span>
                      <span style={{ fontSize: "9px", color: "#94a3b8" }}>
                        {formatDateTimeDDMMYYYY(c.created_at)} • v
                        {c.client_version} vs v{c.server_version}
                      </span>
                    </button>
                  )
                })
              )}
            </div>
          </aside>

          {/* Right Main Details & Side-by-Side Diff Column */}
          <main
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              overflowY: "auto",
              padding: "18px 24px",
            }}
          >
            {actionError && (
              <div
                style={{
                  marginBottom: "14px",
                  padding: "10px 14px",
                  borderRadius: "8px",
                  background: "#fef2f2",
                  border: "1px solid #fecaca",
                  color: "#991b1b",
                  fontSize: "12px",
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                }}
              >
                <AlertCircle size={16} />
                <span>{actionError}</span>
              </div>
            )}

            {actionSuccess && (
              <div
                style={{
                  marginBottom: "14px",
                  padding: "10px 14px",
                  borderRadius: "8px",
                  background: "#f0fdf4",
                  border: "1px solid #bbf7d0",
                  color: "#166534",
                  fontSize: "12px",
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                }}
              >
                <Check size={16} />
                <span>{actionSuccess}</span>
              </div>
            )}

            {activeConflict ? (
              <>
                {/* Conflict Detail Heading */}
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "flex-start",
                    marginBottom: "16px",
                    paddingBottom: "12px",
                    borderBottom: "1px solid var(--line)",
                  }}
                >
                  <div>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                      }}
                    >
                      <span
                        style={{
                          fontSize: "12px",
                          fontWeight: "700",
                          padding: "2px 8px",
                          borderRadius: "4px",
                          background: "#e0f2fe",
                          color: "#0369a1",
                        }}
                      >
                        {activeConflict.entity_type}
                      </span>
                      <strong style={{ fontSize: "14px", color: "#0f172a" }}>
                        Record ID: {activeConflict.entity_id}
                      </strong>
                    </div>
                    <p
                      style={{
                        margin: "4px 0 0",
                        fontSize: "12px",
                        color: "#475569",
                      }}
                    >
                      {formatHumanReason(activeConflict.conflict_reason)}
                    </p>
                  </div>

                  <div style={{ textAlign: "right" }}>
                    <span
                      style={{
                        display: "inline-block",
                        fontSize: "11px",
                        fontWeight: "600",
                        padding: "3px 10px",
                        borderRadius: "12px",
                        background:
                          activeConflict.status === "OPEN"
                            ? "#fef3c7"
                            : "#dcfce7",
                        color:
                          activeConflict.status === "OPEN"
                            ? "#b45309"
                            : "#15803d",
                      }}
                    >
                      Status: {activeConflict.status}
                    </span>
                    {activeConflict.resolution_strategy && (
                      <span
                        style={{
                          display: "block",
                          fontSize: "10px",
                          color: "var(--muted)",
                          marginTop: "2px",
                        }}
                      >
                        Resolved via: {activeConflict.resolution_strategy}
                      </span>
                    )}
                  </div>
                </div>

                {/* Diff Viewer vs Manual Merge Workspace */}
                {!isMerging ? (
                  <>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr 1fr",
                        gap: "16px",
                        marginBottom: "20px",
                      }}
                    >
                      {/* Local Version Column */}
                      <div
                        style={{
                          border: "1px solid #cbd5e1",
                          borderRadius: "8px",
                          background: "#ffffff",
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            padding: "10px 14px",
                            background: "#f1f5f9",
                            borderBottom: "1px solid #cbd5e1",
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "6px",
                            }}
                          >
                            <span
                              style={{
                                width: "8px",
                                height: "8px",
                                borderRadius: "50%",
                                background: "#0ea5e9",
                              }}
                            />
                            <strong
                              style={{ fontSize: "13px", color: "#0f172a" }}
                            >
                              Local Version (This Device)
                            </strong>
                          </div>
                          <span
                            style={{
                              fontSize: "11px",
                              fontWeight: "600",
                              color: "#0284c7",
                            }}
                          >
                            v{activeConflict.client_version}
                          </span>
                        </div>
                        <div style={{ padding: "14px" }}>
                          <EntityFieldView
                            entityType={activeConflict.entity_type}
                            data={clientData}
                            compareData={serverData}
                            side="local"
                          />
                        </div>
                      </div>

                      {/* Server Version Column */}
                      <div
                        style={{
                          border: "1px solid #fed7aa",
                          borderRadius: "8px",
                          background: "#ffffff",
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            padding: "10px 14px",
                            background: "#fff7ed",
                            borderBottom: "1px solid #fed7aa",
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "6px",
                            }}
                          >
                            <span
                              style={{
                                width: "8px",
                                height: "8px",
                                borderRadius: "50%",
                                background: "#f97316",
                              }}
                            />
                            <strong
                              style={{ fontSize: "13px", color: "#7c2d12" }}
                            >
                              Cloud Version (Server)
                            </strong>
                          </div>
                          <span
                            style={{
                              fontSize: "11px",
                              fontWeight: "600",
                              color: "#c2410c",
                            }}
                          >
                            v{activeConflict.server_version}
                          </span>
                        </div>
                        <div style={{ padding: "14px" }}>
                          <EntityFieldView
                            entityType={activeConflict.entity_type}
                            data={serverData}
                            compareData={clientData}
                            side="server"
                          />
                        </div>
                      </div>
                    </div>

                    {/* Action Panel for OPEN conflicts */}
                    {activeConflict.status === "OPEN" && (
                      <div
                        style={{
                          marginTop: "auto",
                          padding: "16px",
                          borderRadius: "10px",
                          background: "#f8fafc",
                          border: "1px solid #e2e8f0",
                        }}
                      >
                        <div style={{ marginBottom: "12px" }}>
                          <strong
                            style={{ fontSize: "13px", color: "#0f172a" }}
                          >
                            Choose a Safe Clinical Resolution Strategy
                          </strong>
                          <p
                            style={{
                              margin: "2px 0 0",
                              fontSize: "11px",
                              color: "var(--muted)",
                            }}
                          >
                            Selected action will be durably committed to
                            encrypted SQLite and synced to the cloud.
                          </p>
                        </div>

                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns:
                              activeConflict.entity_type === "CONSULTATION"
                                ? "1fr 1fr 1fr 1.2fr"
                                : "1fr 1fr 1.2fr",
                            gap: "10px",
                          }}
                        >
                          {/* USE_SERVER */}
                          <button
                            className="btn btn-secondary"
                            style={{
                              display: "flex",
                              flexDirection: "column",
                              alignItems: "flex-start",
                              padding: "10px 12px",
                              height: "auto",
                            }}
                            onClick={() => setConfirmStrategy("USE_SERVER")}
                            disabled={isSubmitting}
                          >
                            <span
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "6px",
                                fontWeight: "600",
                                fontSize: "12px",
                              }}
                            >
                              <Download size={14} /> Accept Server
                            </span>
                            <small
                              style={{
                                fontSize: "10px",
                                color: "var(--muted)",
                                textAlign: "left",
                                marginTop: "2px",
                                lineHeight: "1.3",
                              }}
                            >
                              Discard local edits; pull remote cloud record.
                            </small>
                          </button>

                          {/* USE_LOCAL */}
                          <button
                            className="btn btn-secondary"
                            style={{
                              display: "flex",
                              flexDirection: "column",
                              alignItems: "flex-start",
                              padding: "10px 12px",
                              height: "auto",
                            }}
                            onClick={() => setConfirmStrategy("USE_LOCAL")}
                            disabled={isSubmitting}
                          >
                            <span
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "6px",
                                fontWeight: "600",
                                fontSize: "12px",
                              }}
                            >
                              <Upload size={14} /> Keep Local
                            </span>
                            <small
                              style={{
                                fontSize: "10px",
                                color: "var(--muted)",
                                textAlign: "left",
                                marginTop: "2px",
                                lineHeight: "1.3",
                              }}
                            >
                              Overwrite cloud with this device's version.
                            </small>
                          </button>

                          {/* PRESERVE_BOTH (Consultations only) */}
                          {activeConflict.entity_type === "CONSULTATION" && (
                            <button
                              className="btn btn-secondary"
                              style={{
                                display: "flex",
                                flexDirection: "column",
                                alignItems: "flex-start",
                                padding: "10px 12px",
                                height: "auto",
                                border: "1px solid #86efac",
                              }}
                              onClick={() =>
                                setConfirmStrategy("PRESERVE_BOTH")
                              }
                              disabled={isSubmitting}
                            >
                              <span
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: "6px",
                                  fontWeight: "600",
                                  fontSize: "12px",
                                  color: "#166534",
                                }}
                              >
                                <Copy size={14} /> Preserve Both
                              </span>
                              <small
                                style={{
                                  fontSize: "10px",
                                  color: "#166534",
                                  textAlign: "left",
                                  marginTop: "2px",
                                  lineHeight: "1.3",
                                }}
                              >
                                Clone local draft into a new consultation. 0%
                                data loss.
                              </small>
                            </button>
                          )}

                          {/* MERGE_MANUAL */}
                          <button
                            className="btn btn-primary"
                            style={{
                              display: "flex",
                              flexDirection: "column",
                              alignItems: "flex-start",
                              padding: "10px 12px",
                              height: "auto",
                            }}
                            onClick={() => setIsMerging(true)}
                            disabled={isSubmitting}
                          >
                            <span
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "6px",
                                fontWeight: "600",
                                fontSize: "12px",
                              }}
                            >
                              <Edit3 size={14} /> Reconcile Manually
                            </span>
                            <small
                              style={{
                                fontSize: "10px",
                                opacity: 0.9,
                                textAlign: "left",
                                marginTop: "2px",
                                lineHeight: "1.3",
                              }}
                            >
                              Review allergies, diagnosis & medicines
                              field-by-field.
                            </small>
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  /* Manual Reconciliation Workspace */
                  <div
                    style={{
                      border: "1.5px solid var(--accent)",
                      borderRadius: "10px",
                      background: "#ffffff",
                      padding: "16px 20px",
                      display: "flex",
                      flexDirection: "column",
                      gap: "14px",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}
                    >
                      <div>
                        <strong style={{ fontSize: "14px", color: "#0f172a" }}>
                          Manual Field Reconciliation Workspace
                        </strong>
                        <p
                          style={{
                            margin: "2px 0 0",
                            fontSize: "11px",
                            color: "var(--muted)",
                          }}
                        >
                          Safely combine clinical observations. The resulting
                          record will be committed to encrypted SQLite and
                          pushed to cloud.
                        </p>
                      </div>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => setIsMerging(false)}
                        disabled={isSubmitting}
                      >
                        Cancel Reconcile
                      </button>
                    </div>

                    {activeConflict.entity_type === "PATIENT" && (
                      <ManualPatientMergeForm
                        patient={mergedPatient}
                        client={clientData as ParsedPatientPayload}
                        server={serverData as ParsedPatientPayload}
                        onChange={setMergedPatient}
                      />
                    )}

                    {activeConflict.entity_type === "CONSULTATION" && (
                      <ManualConsultationMergeForm
                        consultation={mergedConsultation}
                        client={clientData as ParsedConsultationPayload}
                        server={serverData as ParsedConsultationPayload}
                        onChange={setMergedConsultation}
                      />
                    )}

                    {activeConflict.entity_type === "PRESCRIPTION" && (
                      <ManualPrescriptionMergeForm
                        prescription={mergedPrescription}
                        client={clientData as ParsedPrescriptionPayload}
                        server={serverData as ParsedPrescriptionPayload}
                        onChange={setMergedPrescription}
                      />
                    )}

                    <div
                      style={{
                        display: "flex",
                        justifyContent: "flex-end",
                        gap: "10px",
                        marginTop: "12px",
                      }}
                    >
                      <button
                        className="btn btn-secondary"
                        onClick={() => setIsMerging(false)}
                        disabled={isSubmitting}
                      >
                        Back
                      </button>
                      <button
                        className="btn btn-primary"
                        onClick={() => setConfirmStrategy("MERGE_MANUAL")}
                        disabled={isSubmitting}
                      >
                        Apply Reconciled Record <ArrowRight size={15} />
                      </button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div
                style={{
                  margin: "auto",
                  textAlign: "center",
                  color: "var(--muted)",
                }}
              >
                <Layers
                  size={36}
                  style={{ margin: "0 auto 12px", opacity: 0.5 }}
                />
                <p>Select a conflict from the list to inspect differences.</p>
              </div>
            )}
          </main>
        </div>

        {/* Confirmation Modal Overlay */}
        {confirmStrategy && activeConflict && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(15, 23, 42, 0.6)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "20px",
              zIndex: 110,
            }}
          >
            <div
              style={{
                width: "min(440px, 95%)",
                background: "white",
                borderRadius: "12px",
                padding: "20px 24px",
                boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.2)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "10px",
                  marginBottom: "12px",
                }}
              >
                <span
                  style={{
                    padding: "8px",
                    borderRadius: "8px",
                    background: "#fef3c7",
                    color: "#b45309",
                  }}
                >
                  <ShieldAlert size={20} />
                </span>
                <strong style={{ fontSize: "15px", color: "#0f172a" }}>
                  Confirm Conflict Resolution
                </strong>
              </div>

              <p
                style={{
                  fontSize: "12px",
                  color: "#475569",
                  lineHeight: "1.5",
                  margin: "0 0 16px",
                }}
              >
                {confirmStrategy === "USE_SERVER" && (
                  <>
                    Are you sure you want to adopt the{" "}
                    <strong>Cloud Version</strong>? Local modifications will be
                    replaced with the server's record.
                  </>
                )}
                {confirmStrategy === "USE_LOCAL" && (
                  <>
                    Are you sure you want to keep the{" "}
                    <strong>Local Version</strong>? This device's version will
                    overwrite the remote cloud record.
                  </>
                )}
                {confirmStrategy === "MERGE_MANUAL" && (
                  <>
                    Are you sure you want to apply the{" "}
                    <strong>Manually Reconciled Record</strong>? The unified
                    record will be committed to encrypted SQLite and uploaded to
                    the cloud.
                  </>
                )}
                {confirmStrategy === "PRESERVE_BOTH" && (
                  <>
                    Are you sure you want to{" "}
                    <strong>Preserve Both Consultations</strong>? Your local
                    draft will be safely saved as a separate consultation, and
                    the server's record will be adopted on the original record.
                  </>
                )}
              </p>

              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: "10px",
                }}
              >
                <button
                  className="btn btn-secondary"
                  onClick={() => setConfirmStrategy(null)}
                  disabled={isSubmitting}
                >
                  Cancel
                </button>
                <button
                  className="btn btn-primary"
                  onClick={() => handleApplyResolution(confirmStrategy)}
                  disabled={isSubmitting}
                >
                  {isSubmitting ? (
                    <>
                      <RefreshCw className="animate-spin" size={14} />
                      Applying...
                    </>
                  ) : (
                    "Confirm & Apply"
                  )}
                </button>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}

/**
 * Human-readable mapping for conflict reason codes
 */
function formatHumanReason(reason: string): string {
  switch (reason) {
    case "DIVERGENT_CLINICAL_DATA":
      return "Divergent clinical observations between device and cloud"
    case "CONCURRENT_DRAFT_COLLISION":
      return "Concurrent draft collision from another session"
    case "CONCURRENT_REMOTE_UPDATE":
      return "Cloud version modified while local changes were pending"
    case "STALE_VERSION":
      return "Local record was based on an outdated server revision"
    case "RECORD_DELETED_REMOTELY":
      return "Record was deleted on the server while modified locally"
    default:
      return reason || "Sync version divergence"
  }
}

/**
 * Renders structured entity fields with visual difference highlighting
 */
function EntityFieldView({
  entityType,
  data,
  compareData,
  side,
}: {
  entityType: string
  data: Record<string, unknown> | null
  compareData: Record<string, unknown> | null
  side: "local" | "server"
}) {
  if (!data) {
    return (
      <div style={{ fontSize: "12px", color: "var(--muted)" }}>
        No payload data available.
      </div>
    )
  }

  if (entityType === "PATIENT") {
    const allergies = Array.isArray(data.allergies) ? data.allergies : []
    const compareAllergies = Array.isArray(compareData?.allergies)
      ? compareData?.allergies
      : []
    const allergiesDiff =
      JSON.stringify(allergies) !== JSON.stringify(compareAllergies)

    const conditions = Array.isArray(data.conditions) ? data.conditions : []
    const compareConditions = Array.isArray(compareData?.conditions)
      ? compareData?.conditions
      : []
    const conditionsDiff =
      JSON.stringify(conditions) !== JSON.stringify(compareConditions)

    const nameDiff = data.name !== compareData?.name
    const phoneDiff = data.phone !== compareData?.phone
    const genderDiff = data.gender !== compareData?.gender
    const ageDiff = data.age !== compareData?.age

    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "10px",
          fontSize: "12px",
        }}
      >
        <FieldItem
          label="Patient Name"
          value={String(data.name || "--")}
          isDifferent={nameDiff}
        />
        <FieldItem
          label="Phone"
          value={String(data.phone || "--")}
          isDifferent={phoneDiff}
        />
        <FieldItem
          label="Gender"
          value={String(data.gender || "--")}
          isDifferent={genderDiff}
        />
        <FieldItem
          label="Age"
          value={String(data.age ?? "--")}
          isDifferent={ageDiff}
        />

        <div
          style={{
            padding: "8px",
            borderRadius: "6px",
            border: allergiesDiff ? "1px dashed #f59e0b" : "1px solid #e2e8f0",
            background: allergiesDiff ? "#fffbeb" : "#f8fafc",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginBottom: "4px",
            }}
          >
            <strong
              style={{
                fontSize: "11px",
                color: allergiesDiff ? "#b45309" : "#475569",
              }}
            >
              Allergies {allergiesDiff && "(Different)"}
            </strong>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
            {allergies.length > 0 ? (
              allergies.map((a: string) => (
                <span
                  key={a}
                  style={{
                    fontSize: "10px",
                    padding: "2px 6px",
                    borderRadius: "4px",
                    background: "#fee2e2",
                    color: "#991b1b",
                    fontWeight: "500",
                  }}
                >
                  {a}
                </span>
              ))
            ) : (
              <span style={{ fontSize: "11px", color: "var(--muted)" }}>
                None recorded
              </span>
            )}
          </div>
        </div>

        <div
          style={{
            padding: "8px",
            borderRadius: "6px",
            border: conditionsDiff ? "1px dashed #f59e0b" : "1px solid #e2e8f0",
            background: conditionsDiff ? "#fffbeb" : "#f8fafc",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginBottom: "4px",
            }}
          >
            <strong
              style={{
                fontSize: "11px",
                color: conditionsDiff ? "#b45309" : "#475569",
              }}
            >
              Chronic Conditions {conditionsDiff && "(Different)"}
            </strong>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
            {conditions.length > 0 ? (
              conditions.map((c: string) => (
                <span
                  key={c}
                  style={{
                    fontSize: "10px",
                    padding: "2px 6px",
                    borderRadius: "4px",
                    background: "#e0e7ff",
                    color: "#3730a3",
                  }}
                >
                  {c}
                </span>
              ))
            ) : (
              <span style={{ fontSize: "11px", color: "var(--muted)" }}>
                None recorded
              </span>
            )}
          </div>
        </div>
      </div>
    )
  }

  if (entityType === "CONSULTATION") {
    const chiefComplaint = String(
      data.chiefComplaint || data.chief_complaint || "--",
    )
    const compareChiefComplaint = String(
      compareData?.chiefComplaint || compareData?.chief_complaint || "--",
    )
    const ccDiff = chiefComplaint !== compareChiefComplaint

    const diagnosis = String(data.diagnosis || "--")
    const compareDiagnosis = String(compareData?.diagnosis || "--")
    const diagDiff = diagnosis !== compareDiagnosis

    const snapshot = (data.clinicalSnapshot ||
      safeParseJson(data.clinicalSnapshotJson || data.clinical_snapshot_json) ||
      {}) as Record<string, unknown>
    const compareSnapshot = (compareData?.clinicalSnapshot ||
      safeParseJson(
        compareData?.clinicalSnapshotJson ||
          compareData?.clinical_snapshot_json,
      ) ||
      {}) as Record<string, unknown>

    const vitals = (snapshot.vitals || {}) as Record<string, string>
    const compareVitals = (compareSnapshot.vitals ||
      {}) as Record<string, string>
    const vitalsDiff = JSON.stringify(vitals) !== JSON.stringify(compareVitals)

    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "10px",
          fontSize: "12px",
        }}
      >
        <FieldItem
          label="Consultation Date"
          value={String(
            data.consultationDate || data.consultation_date || "--",
          )}
          isDifferent={false}
        />
        <FieldItem
          label="Chief Complaint"
          value={chiefComplaint}
          isDifferent={ccDiff}
        />
        <FieldItem label="Diagnosis" value={diagnosis} isDifferent={diagDiff} />

        <div
          style={{
            padding: "8px",
            borderRadius: "6px",
            border: vitalsDiff ? "1px dashed #f59e0b" : "1px solid #e2e8f0",
            background: vitalsDiff ? "#fffbeb" : "#f8fafc",
          }}
        >
          <strong
            style={{
              fontSize: "11px",
              color: vitalsDiff ? "#b45309" : "#475569",
              display: "block",
              marginBottom: "4px",
            }}
          >
            Vitals {vitalsDiff && "(Different)"}
          </strong>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "4px",
              fontSize: "11px",
            }}
          >
            <span>
              BP: {vitals.systolic || "--"}/{vitals.diastolic || "--"} mmHg
            </span>
            <span>Pulse: {vitals.heartRate || "--"} bpm</span>
            <span>SpO2: {vitals.spo2 || "--"}%</span>
            <span>Temp: {vitals.temperature || "--"}°F</span>
          </div>
        </div>

        {Boolean(snapshot.followUpInstructions) && (
          <FieldItem
            label="Follow-up Instructions"
            value={String(snapshot.followUpInstructions)}
            isDifferent={false}
          />
        )}
      </div>
    )
  }

  if (entityType === "PRESCRIPTION") {
    const items: MedicineItem[] = (data.items ||
      safeParseJson(data.itemsJson || data.items_json) ||
      []) as MedicineItem[]
    const compareItems: MedicineItem[] = (compareData?.items ||
      safeParseJson(compareData?.itemsJson || compareData?.items_json) ||
      []) as MedicineItem[]
    const itemsDiff = JSON.stringify(items) !== JSON.stringify(compareItems)

    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "10px",
          fontSize: "12px",
        }}
      >
        <FieldItem
          label="Prescription Number"
          value={String(
            data.prescriptionNumber || data.prescription_number || "--",
          )}
          isDifferent={false}
        />

        <div
          style={{
            padding: "8px",
            borderRadius: "6px",
            border: itemsDiff ? "1px dashed #f59e0b" : "1px solid #e2e8f0",
            background: itemsDiff ? "#fffbeb" : "#f8fafc",
          }}
        >
          <strong
            style={{
              fontSize: "11px",
              color: itemsDiff ? "#b45309" : "#475569",
              display: "block",
              marginBottom: "6px",
            }}
          >
            Prescribed Items ({items.length}) {itemsDiff && "• Divergent"}
          </strong>

          {items.map((m, idx) => (
            <div
              key={idx}
              style={{
                padding: "4px 6px",
                borderBottom:
                  idx < items.length - 1 ? "1px solid #e2e8f0" : "none",
                fontSize: "11px",
              }}
            >
              <strong>{m.name || "Unnamed Medicine"}</strong>
              <span style={{ color: "#64748b", marginLeft: "6px" }}>
                {m.formulation} {m.strength} • {m.dose} • {m.frequency} •{" "}
                {m.duration}
              </span>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <pre
      style={{
        fontSize: "11px",
        overflowX: "auto",
        background: "#f8fafc",
        padding: "8px",
        borderRadius: "6px",
      }}
    >
      {JSON.stringify(data, null, 2)}
    </pre>
  )
}

function FieldItem({
  label,
  value,
  isDifferent,
}: {
  label: string
  value: string
  isDifferent: boolean
}) {
  return (
    <div
      style={{
        padding: "6px 8px",
        borderRadius: "6px",
        background: isDifferent ? "rgba(245, 158, 11, 0.08)" : "transparent",
        border: isDifferent ? "1px solid rgba(245, 158, 11, 0.3)" : "none",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span
          style={{
            fontSize: "11px",
            color: isDifferent ? "#b45309" : "var(--muted)",
            fontWeight: "500",
          }}
        >
          {label}
        </span>
        {isDifferent && (
          <span
            style={{
              fontSize: "9px",
              fontWeight: "600",
              padding: "1px 5px",
              borderRadius: "4px",
              background: "#fef3c7",
              color: "#b45309",
            }}
          >
            Differs
          </span>
        )}
      </div>
      <strong
        style={{
          display: "block",
          fontSize: "12px",
          color: "#1e293b",
          marginTop: "2px",
        }}
      >
        {value}
      </strong>
    </div>
  )
}

/**
 * Manual Patient Reconciliation Editor
 */
function ManualPatientMergeForm({
  patient,
  client,
  server,
  onChange,
}: {
  patient: ParsedPatientPayload
  client: ParsedPatientPayload | null
  server: ParsedPatientPayload | null
  onChange: (updated: ParsedPatientPayload) => void
}) {
  const allKnownAllergies = Array.from(
    new Set([...(client?.allergies || []), ...(server?.allergies || [])]),
  )
  const allKnownConditions = Array.from(
    new Set([...(client?.conditions || []), ...(server?.conditions || [])]),
  )

  const toggleAllergy = (a: string) => {
    const current = patient.allergies || []
    const next = current.includes(a)
      ? current.filter((x) => x !== a)
      : [...current, a]
    onChange({ ...patient, allergies: next })
  }

  const toggleCondition = (c: string) => {
    const current = patient.conditions || []
    const next = current.includes(c)
      ? current.filter((x) => x !== c)
      : [...current, c]
    onChange({ ...patient, conditions: next })
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "12px",
        fontSize: "12px",
      }}
    >
      <div
        style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}
      >
        <div>
          <label
            style={{
              display: "block",
              fontSize: "11px",
              fontWeight: "600",
              marginBottom: "4px",
            }}
          >
            Patient Name
          </label>
          <input
            className="input"
            value={patient.name || ""}
            onChange={(e) => onChange({ ...patient, name: e.target.value })}
          />
        </div>
        <div>
          <label
            style={{
              display: "block",
              fontSize: "11px",
              fontWeight: "600",
              marginBottom: "4px",
            }}
          >
            Phone Number
          </label>
          <input
            className="input"
            value={patient.phone || ""}
            onChange={(e) => onChange({ ...patient, phone: e.target.value })}
          />
        </div>
      </div>

      {/* Allergies multi-select reconcile */}
      <div
        style={{
          padding: "10px",
          borderRadius: "8px",
          background: "#f8fafc",
          border: "1px solid #e2e8f0",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "6px",
          }}
        >
          <strong style={{ fontSize: "11px", color: "#b45309" }}>
            Reconcile Allergies (Select all that apply)
          </strong>
          <button
            className="btn btn-ghost btn-sm"
            style={{ fontSize: "10px", padding: "2px 6px" }}
            onClick={() =>
              onChange({ ...patient, allergies: allKnownAllergies })
            }
          >
            Union All
          </button>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
          {allKnownAllergies.length > 0 ? (
            allKnownAllergies.map((a) => {
              const selected = (patient.allergies || []).includes(a)
              return (
                <button
                  key={a}
                  onClick={() => toggleAllergy(a)}
                  style={{
                    padding: "3px 8px",
                    borderRadius: "6px",
                    border: selected
                      ? "1px solid #b91c1c"
                      : "1px solid #cbd5e1",
                    background: selected ? "#fee2e2" : "#ffffff",
                    color: selected ? "#991b1b" : "#475569",
                    fontSize: "11px",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: "4px",
                  }}
                >
                  {selected && <Check size={12} />}
                  {a}
                </button>
              )
            })
          ) : (
            <span style={{ fontSize: "11px", color: "var(--muted)" }}>
              No allergies reported in either version.
            </span>
          )}
        </div>
      </div>

      {/* Chronic conditions multi-select reconcile */}
      <div
        style={{
          padding: "10px",
          borderRadius: "8px",
          background: "#f8fafc",
          border: "1px solid #e2e8f0",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "6px",
          }}
        >
          <strong style={{ fontSize: "11px", color: "#3730a3" }}>
            Reconcile Conditions (Select all that apply)
          </strong>
          <button
            className="btn btn-ghost btn-sm"
            style={{ fontSize: "10px", padding: "2px 6px" }}
            onClick={() =>
              onChange({ ...patient, conditions: allKnownConditions })
            }
          >
            Union All
          </button>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
          {allKnownConditions.length > 0 ? (
            allKnownConditions.map((c) => {
              const selected = (patient.conditions || []).includes(c)
              return (
                <button
                  key={c}
                  onClick={() => toggleCondition(c)}
                  style={{
                    padding: "3px 8px",
                    borderRadius: "6px",
                    border: selected
                      ? "1px solid #4338ca"
                      : "1px solid #cbd5e1",
                    background: selected ? "#e0e7ff" : "#ffffff",
                    color: selected ? "#3730a3" : "#475569",
                    fontSize: "11px",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: "4px",
                  }}
                >
                  {selected && <Check size={12} />}
                  {c}
                </button>
              )
            })
          ) : (
            <span style={{ fontSize: "11px", color: "var(--muted)" }}>
              No conditions recorded in either version.
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Manual Consultation Reconciliation Editor
 */
function ManualConsultationMergeForm({
  consultation,
  client,
  server,
  onChange,
}: {
  consultation: ParsedConsultationPayload
  client: ParsedConsultationPayload | null
  server: ParsedConsultationPayload | null
  onChange: (updated: ParsedConsultationPayload) => void
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        fontSize: "12px",
      }}
    >
      <div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "4px",
          }}
        >
          <label style={{ fontSize: "11px", fontWeight: "600" }}>
            Chief Complaint
          </label>
          <div style={{ display: "flex", gap: "6px" }}>
            <button
              className="btn btn-ghost btn-sm"
              style={{ fontSize: "10px", padding: "1px 6px" }}
              onClick={() =>
                onChange({
                  ...consultation,
                  chiefComplaint:
                    client?.chiefComplaint || client?.chief_complaint || "",
                })
              }
            >
              Use Local
            </button>
            <button
              className="btn btn-ghost btn-sm"
              style={{ fontSize: "10px", padding: "1px 6px" }}
              onClick={() =>
                onChange({
                  ...consultation,
                  chiefComplaint:
                    server?.chiefComplaint || server?.chief_complaint || "",
                })
              }
            >
              Use Server
            </button>
          </div>
        </div>
        <textarea
          className="input textarea"
          rows={2}
          value={consultation.chiefComplaint || ""}
          onChange={(e) =>
            onChange({ ...consultation, chiefComplaint: e.target.value })
          }
        />
      </div>

      <div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "4px",
          }}
        >
          <label style={{ fontSize: "11px", fontWeight: "600" }}>
            Diagnosis
          </label>
          <div style={{ display: "flex", gap: "6px" }}>
            <button
              className="btn btn-ghost btn-sm"
              style={{ fontSize: "10px", padding: "1px 6px" }}
              onClick={() =>
                onChange({
                  ...consultation,
                  diagnosis: client?.diagnosis || "",
                })
              }
            >
              Use Local
            </button>
            <button
              className="btn btn-ghost btn-sm"
              style={{ fontSize: "10px", padding: "1px 6px" }}
              onClick={() =>
                onChange({
                  ...consultation,
                  diagnosis: server?.diagnosis || "",
                })
              }
            >
              Use Server
            </button>
          </div>
        </div>
        <input
          className="input"
          value={consultation.diagnosis || ""}
          onChange={(e) =>
            onChange({ ...consultation, diagnosis: e.target.value })
          }
        />
      </div>
    </div>
  )
}

/**
 * Manual Prescription Reconciliation Editor
 */
function ManualPrescriptionMergeForm({
  prescription,
  client,
  server,
  onChange,
}: {
  prescription: ParsedPrescriptionPayload
  client: ParsedPrescriptionPayload | null
  server: ParsedPrescriptionPayload | null
  onChange: (updated: ParsedPrescriptionPayload) => void
}) {
  const currentItems = prescription.items || []

  const removeItem = (idx: number) => {
    onChange({
      ...prescription,
      items: currentItems.filter((_, i) => i !== idx),
    })
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        fontSize: "12px",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <strong style={{ fontSize: "12px", color: "#0f172a" }}>
          Reconcile Prescribed Medicines
        </strong>
        <span style={{ fontSize: "11px", color: "var(--muted)" }}>
          {currentItems.length} items selected
        </span>
      </div>

      <div
        style={{
          border: "1px solid #e2e8f0",
          borderRadius: "8px",
          overflow: "hidden",
        }}
      >
        {currentItems.map((m, idx) => (
          <div
            key={idx}
            style={{
              padding: "8px 12px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              borderBottom:
                idx < currentItems.length - 1 ? "1px solid #e2e8f0" : "none",
              background: idx % 2 === 0 ? "#ffffff" : "#f8fafc",
            }}
          >
            <div>
              <strong>{m.name}</strong>
              <span
                style={{
                  marginLeft: "6px",
                  color: "var(--muted)",
                  fontSize: "11px",
                }}
              >
                {m.formulation} {m.strength} • {m.dose} • {m.frequency} •{" "}
                {m.duration}
              </span>
            </div>
            <button
              className="btn btn-ghost btn-sm"
              style={{ color: "#ef4444", padding: "2px 6px" }}
              onClick={() => removeItem(idx)}
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
export default ConflictResolutionModal
