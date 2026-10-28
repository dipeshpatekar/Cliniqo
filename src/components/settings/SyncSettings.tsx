import { useState, useEffect } from "react"
import { Cloud, AlertCircle, WifiOff } from "lucide-react"
import { cn } from "../../utils/cn"
import { StatusPill } from "../common"
import {
  isTauriDesktop,
  getSyncStatus,
  type SyncStatusInfo,
} from "../../desktop/desktop-bridge"

export interface SyncSettingsProps {
  onOpenConflictModal?: () => void
}

export function SyncSettings({ onOpenConflictModal }: SyncSettingsProps) {
  const [syncEnabled, setSyncEnabled] = useState(false)
  const [nativeStatus, setNativeStatus] = useState<SyncStatusInfo | null>(null)

  useEffect(() => {
    if (!isTauriDesktop()) return

    let mounted = true
    const fetchStatus = async () => {
      try {
        const s = await getSyncStatus()
        if (mounted && s) {
          setNativeStatus(s)
        }
      } catch (err) {
        console.warn("Failed to query sync status:", err)
      }
    }

    fetchStatus()
    const interval = setInterval(fetchStatus, 3000)
    return () => {
      mounted = false
      clearInterval(interval)
    }
  }, [])

  if (isTauriDesktop()) {
    const isLive = nativeStatus?.is_running ?? false
    const tone =
      nativeStatus?.status === "SYNCING"
        ? "info"
        : nativeStatus?.status === "OFFLINE"
          ? "warning"
          : nativeStatus?.status === "ERROR"
            ? "danger"
            : "success"

    return (
      <section className="settings-section">
        <div className="settings-title with-status">
          <div>
            <h2>Native Synchronization Engine</h2>
            <p>
              Background worker with transactional SQLite persistence and cloud
              sync.
            </p>
          </div>
          <StatusPill tone={tone}>
            {nativeStatus?.status || (isLive ? "RUNNING" : "STOPPED")}
          </StatusPill>
        </div>

        <div className="sync-hero">
          <span>
            <Cloud size={24} />
          </span>
          <div>
            <strong>
              {nativeStatus?.active_clinic_id
                ? `Active Clinic: ${nativeStatus.active_clinic_id}`
                : "No active clinic session"}
            </strong>
            <p>
              {nativeStatus?.last_synced_at
                ? `Last synchronized: ${new Date(
                    nativeStatus.last_synced_at,
                  ).toLocaleTimeString()}`
                : "Awaiting initial sync cycle"}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3 my-4">
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 bg-slate-50 dark:bg-slate-900/50">
            <span className="text-xs text-slate-500 uppercase tracking-wider block">
              Pending Mutations
            </span>
            <span className="text-xl font-bold text-slate-800 dark:text-slate-100">
              {nativeStatus?.pending_mutations ?? 0}
            </span>
          </div>
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 bg-slate-50 dark:bg-slate-900/50">
            <span className="text-xs text-slate-500 uppercase tracking-wider block">
              In-Flight Jobs
            </span>
            <span className="text-xl font-bold text-slate-800 dark:text-slate-100">
              {nativeStatus?.in_flight_mutations ?? 0}
            </span>
          </div>
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 bg-slate-50 dark:bg-slate-900/50">
            <span className="text-xs text-slate-500 uppercase tracking-wider block">
              Conflicts Recorded
            </span>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginTop: "4px",
              }}
            >
              <span className="text-xl font-bold text-amber-600 dark:text-amber-400">
                {nativeStatus?.conflicts_count ?? 0}
              </span>
              {onOpenConflictModal && (
                <button
                  className="btn btn-sm btn-secondary"
                  style={{ fontSize: "11px", padding: "2px 8px" }}
                  onClick={onOpenConflictModal}
                >
                  Review Conflicts
                </button>
              )}
            </div>
          </div>
        </div>

        {nativeStatus?.last_error && (
          <div className="info-callout text-amber-700 bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-900 mb-3">
            <AlertCircle size={17} />
            <p>
              <strong>Sync Alert:</strong> {nativeStatus.last_error}
            </p>
          </div>
        )}

        <div className="info-callout">
          <Cloud size={17} />
          <p>
            <strong>Phase 5C Native Sync Active:</strong> Patient demographics
            and clinical snapshots are encrypted with AES-256-GCM before local
            SQLite persistence. Mutations push with backend idempotency keys,
            and changes pull with monotonic sequence cursors.
          </p>
        </div>
      </section>
    )
  }

  return (
    <section className="settings-section">
      <div className="settings-title with-status">
        <div>
          <h2>Synchronization & data</h2>
          <p>
            This frontend keeps workflow data in memory unless explicitly noted.
          </p>
        </div>
        <StatusPill tone={syncEnabled ? "info" : "warning"}>
          {syncEnabled ? "UI demo on" : "UI demo off"}
        </StatusPill>
      </div>
      <div className="sync-hero">
        <span>
          <Cloud size={24} />
        </span>
        <div>
          <strong>
            {syncEnabled ? "Sync preference is on" : "Sync preference is off"}
          </strong>
          <p>
            {syncEnabled
              ? "UI state only — no data is uploaded to or downloaded from a cloud service"
              : "Local workflow data stays in this browser session"}
          </p>
        </div>
        <button
          className={cn("theme-switch", syncEnabled && "active")}
          role="switch"
          aria-checked={syncEnabled}
          aria-label="Toggle synchronization demo"
          onClick={() => setSyncEnabled((enabled) => !enabled)}
        >
          <span />
        </button>
      </div>
      <div className="info-callout">
        <WifiOff size={17} />
        <p>
          <strong>UI prototype only:</strong> Turning this switch on does not
          upload, download, back up, or synchronize patient data. A secure
          backend and authenticated clinic account are required for real cloud
          sync.
        </p>
      </div>
    </section>
  )
}

export default SyncSettings
