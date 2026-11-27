import { useState, useEffect, useRef } from "react"
import {
  Cloud,
  AlertCircle,
  Download,
  Upload,
  ShieldCheck,
  RefreshCw,
  CheckCircle2,
  Lock,
  HardDrive,
} from "lucide-react"
import { StatusPill, Button, Modal } from "../common"
import { formatDateTimeDDMMYYYY } from "../../types"
import {
  isTauriDesktop,
  getSyncStatus,
  getClinicProfile,
  type SyncStatusInfo,
  exportEncryptedBackup,
  restoreEncryptedBackup,
  getAutoBackupStatus,
  updateAutoBackupConfig,
  runAutoBackupNow,
  runDatabaseDiagnostics,
  checkAppUpdate,
  downloadAndLaunchUpdate,
  getUpdateCompletionStatus,
  onUpdaterProgress,
  getDesktopInfo,
  type BackupExportResult,
  type BackupRestoreResult,
  type AutoBackupStatus,
  type DatabaseDiagnosticsResult,
  type UpdateCheckResult,
  type UpdateProgressEvent,
  type UpdateCompletionStatus,
} from "../../desktop/desktop-bridge"

export interface SyncSettingsProps {
  onOpenConflictModal?: () => void
}

export function SyncSettings({ onOpenConflictModal }: SyncSettingsProps) {
  const [nativeStatus, setNativeStatus] = useState<SyncStatusInfo | null>(null)
  const [clinicName, setClinicName] = useState<string>("")

  // Backup state
  const [isExporting, setIsExporting] = useState(false)
  const [exportResult, setExportResult] = useState<BackupExportResult | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)
  const [passphrase, setPassphrase] = useState<string>("")
  const [usePassphrase, setUsePassphrase] = useState(false)

  // Restore state
  const [isRestoring, setIsRestoring] = useState(false)
  const [restoreResult, setRestoreResult] = useState<BackupRestoreResult | null>(null)
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const [restorePassphrase, setRestorePassphrase] = useState<string>("")
  const [showRestoreConfirm, setShowRestoreConfirm] = useState(false)
  const [pendingRestoreBytes, setPendingRestoreBytes] = useState<string | null>(null)
  const [pendingFileName, setPendingFileName] = useState<string | null>(null)

  // Automatic local backup & DB diagnostics state
  const [autoBackupStatus, setAutoBackupStatus] = useState<AutoBackupStatus | null>(null)
  const [isRunningAutoBackup, setIsRunningAutoBackup] = useState(false)
  const [autoBackupError, setAutoBackupError] = useState<string | null>(null)
  const [diagnostics, setDiagnostics] = useState<DatabaseDiagnosticsResult | null>(null)
  const [isRunningDiagnostics, setIsRunningDiagnostics] = useState(false)
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)

  // Updater state
  const [appVersion, setAppVersion] = useState<string>("1.0.5")
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false)
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const [isInstallingUpdate, setIsInstallingUpdate] = useState(false)
  const [updateStatusMessage, setUpdateStatusMessage] = useState<string | null>(null)
  const [updateProgress, setUpdateProgress] = useState<UpdateProgressEvent | null>(null)
  const [updateCompletion, setUpdateCompletion] = useState<UpdateCompletionStatus | null>(null)

  useEffect(() => {
    if (isTauriDesktop()) {
      getDesktopInfo()
        .then((info) => {
          if (info?.app_version) setAppVersion(info.app_version)
        })
        .catch(() => {})
      getUpdateCompletionStatus()
        .then((completion) => {
          if (completion && completion.status !== "none") {
            setUpdateCompletion(completion)
          }
        })
        .catch(() => {})
    }
  }, [])

  useEffect(() => {
    if (!isTauriDesktop()) return
    let active = true
    let unlistenFn: (() => void) | null = null
    onUpdaterProgress((evt) => {
      if (!active) return
      setUpdateProgress(evt)
      if (evt.stage === "error" || evt.stage === "cancelled") {
        setIsInstallingUpdate(false)
      }
    }).then((fn) => {
      if (active) {
        unlistenFn = fn
      } else {
        fn()
      }
    })
    return () => {
      active = false
      if (unlistenFn) unlistenFn()
    }
  }, [])

  useEffect(() => {
    const cid = nativeStatus?.active_clinic_id
    if (!cid) return
    let active = true
    getClinicProfile(cid).then((profile) => {
      if (active && profile?.name) {
        setClinicName(profile.name)
      }
    })
    return () => {
      active = false
    }
  }, [nativeStatus?.active_clinic_id])

  const displayClinic =
    clinicName ||
    (nativeStatus?.active_clinic_id &&
    !/^[0-9a-fA-F]{24}$/.test(nativeStatus.active_clinic_id)
      ? nativeStatus.active_clinic_id
      : "Medical Clinic")

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

  useEffect(() => {
    const cid = nativeStatus?.active_clinic_id
    if (!cid || !isTauriDesktop()) return
    let active = true
    getAutoBackupStatus(cid)
      .then((st) => {
        if (active && st) setAutoBackupStatus(st)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [nativeStatus?.active_clinic_id, exportResult, restoreResult])

  const handleToggleAutoBackup = async (enabled: boolean) => {
    const cid = nativeStatus?.active_clinic_id || "clinic_default"
    const current = autoBackupStatus?.config || {
      enabled: true,
      interval_hours: 24,
      max_retained: 7,
    }
    setAutoBackupError(null)
    try {
      const updated = await updateAutoBackupConfig(cid, {
        ...current,
        enabled,
      })
      if (updated) setAutoBackupStatus(updated)
    } catch (err: unknown) {
      setAutoBackupError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleUpdateAutoBackupConfig = async (
    patch: Partial<{ interval_hours: number; max_retained: number }>,
  ) => {
    const cid = nativeStatus?.active_clinic_id || "clinic_default"
    const current = autoBackupStatus?.config || {
      enabled: true,
      interval_hours: 24,
      max_retained: 7,
    }
    setAutoBackupError(null)
    try {
      const updated = await updateAutoBackupConfig(cid, {
        ...current,
        ...patch,
      })
      if (updated) setAutoBackupStatus(updated)
    } catch (err: unknown) {
      setAutoBackupError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleRunAutoBackupNow = async () => {
    const cid = nativeStatus?.active_clinic_id || "clinic_default"
    setIsRunningAutoBackup(true)
    setAutoBackupError(null)
    try {
      const st = await runAutoBackupNow(cid)
      if (st) setAutoBackupStatus(st)
    } catch (err: unknown) {
      setAutoBackupError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsRunningAutoBackup(false)
    }
  }

  const handleRunDatabaseDiagnostics = async () => {
    setIsRunningDiagnostics(true)
    setDiagnosticsError(null)
    try {
      const res = await runDatabaseDiagnostics()
      if (res) setDiagnostics(res)
    } catch (err: unknown) {
      setDiagnosticsError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsRunningDiagnostics(false)
    }
  }

  // 1. Handle One-Click Encrypted Backup Export
  const handleExportBackup = async () => {
    setIsExporting(true)
    setExportError(null)
    setExportResult(null)

    try {
      const clinicId = nativeStatus?.active_clinic_id || "clinic_default"
      const res = await exportEncryptedBackup(
        clinicId,
        usePassphrase && passphrase ? passphrase : undefined,
      )

      setExportResult(res)

      // In browser preview, trigger immediate download
      if (res.backup_bytes_base64 && !res.backup_file_path) {
        const link = document.createElement("a")
        link.href = `data:application/octet-stream;base64,${res.backup_bytes_base64}`
        link.download = res.backup_file_name
        document.body.appendChild(link)
        link.click()
        document.body.removeChild(link)
      }
    } catch (err: unknown) {
      console.error("Backup export failed:", err)
      setExportError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsExporting(false)
    }
  }

  // 2. Handle File Selection for Restore
  const handleFileSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setRestoreError(null)
    setRestoreResult(null)
    setPendingFileName(file.name)

    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      // Extract base64 part
      const base64Index = result.indexOf(",")
      const base64 = base64Index >= 0 ? result.slice(base64Index + 1) : result
      setPendingRestoreBytes(base64)
      setShowRestoreConfirm(true)
    }
    reader.onerror = () => {
      setRestoreError("Failed to read the selected backup file.")
    }
    reader.readAsDataURL(file)
  }

  // 3. Confirm and Execute Restore
  const handleExecuteRestore = async () => {
    if (!pendingRestoreBytes) return
    setShowRestoreConfirm(false)
    setIsRestoring(true)
    setRestoreError(null)

    try {
      const clinicId = nativeStatus?.active_clinic_id
      const res = await restoreEncryptedBackup({
        clinicId: clinicId || undefined,
        backupBytesBase64: pendingRestoreBytes,
        passphrase: restorePassphrase || undefined,
      })
      setRestoreResult(res)
      setPendingRestoreBytes(null)
      setPendingFileName(null)
      setRestorePassphrase("")
    } catch (err: unknown) {
      console.error("Backup restore failed:", err)
      setRestoreError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsRestoring(false)
    }
  }

  // 4. Handle Check for Updates
  const handleCheckUpdate = async () => {
    setIsCheckingUpdate(true)
    setUpdateError(null)
    setUpdateStatusMessage(null)

    try {
      const res = await checkAppUpdate()
      setUpdateResult(res)
      if (!res.available) {
        setUpdateStatusMessage(`Cliniqo is up to date (v${res.current_version}).`)
      }
    } catch (err: unknown) {
      console.error("Update check failed:", err)
      setUpdateError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsCheckingUpdate(false)
    }
  }

  // 5. Handle Download & Install Update
  const handleInstallUpdate = async () => {
    if (!updateResult?.download_url || !updateResult?.target_version) return
    setIsInstallingUpdate(true)
    setUpdateError(null)
    setUpdateProgress({
      stage: "downloading",
      target_version: updateResult.target_version,
      downloaded_bytes: 0,
      total_bytes: null,
      percent: 0,
      message: `Downloading Cliniqo v${updateResult.target_version}...`,
    })

    try {
      const res = await downloadAndLaunchUpdate(
        updateResult.download_url,
        updateResult.target_version,
        updateResult.signature,
      )
      setUpdateStatusMessage(res.status_message)
      if (!res.install_initiated) {
        setIsInstallingUpdate(false)
      }
    } catch (err: unknown) {
      console.error("Update installation failed:", err)
      setUpdateError(err instanceof Error ? err.message : String(err))
      setUpdateProgress(null)
      setIsInstallingUpdate(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* SECTION: Encrypted Backup & Restore */}
      <section className="settings-section">
        <div className="settings-title with-status">
          <div>
            <h2>Encrypted Backup & Recovery</h2>
          </div>
          <StatusPill tone="success">AES-256-GCM ENCRYPTED</StatusPill>
        </div>

        <div className="space-y-4">
          <div className="p-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/40">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <strong className="block text-sm font-semibold text-slate-800 dark:text-slate-100">
                  Export Encrypted Backup (.clxbk)
                </strong>
              </div>

              <Button
                variant="primary"
                onClick={handleExportBackup}
                loading={isExporting}
                icon={Download}
              >
                Export Backup Now
              </Button>
            </div>

            <div className="mt-3 pt-3 border-t border-slate-200 dark:border-slate-800/80">
              <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={usePassphrase}
                  onChange={(e) => setUsePassphrase(e.target.checked)}
                  className="rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                />
                Protect with custom passphrase (recommended for migration to another machine)
              </label>

              {usePassphrase && (
                <div className="mt-2 flex items-center gap-2 max-w-sm">
                  <input
                    type="password"
                    placeholder="Enter backup passphrase..."
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    className="w-full text-xs px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800"
                  />
                </div>
              )}
            </div>

            {exportResult && (
              <div className="mt-3 p-3 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 rounded text-xs text-emerald-800 dark:text-emerald-200 flex items-start gap-2">
                <CheckCircle2 size={16} className="mt-0.5 text-emerald-600 shrink-0" />
                <div>
                  <strong>Backup Created Successfully:</strong>
                  <div className="mt-1 font-mono text-[11px] space-y-0.5">
                    <div>File: {exportResult.backup_file_name}</div>
                    {exportResult.backup_file_path && (
                      <div>Path: {exportResult.backup_file_path}</div>
                    )}
                    <div>
                      Records: {exportResult.manifest.patients_count} patients •{" "}
                      {exportResult.manifest.consultations_count} consultations •{" "}
                      {exportResult.manifest.prescriptions_count} prescriptions
                    </div>
                  </div>
                </div>
              </div>
            )}

            {exportError && (
              <div className="mt-3 p-3 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded text-xs text-rose-800 dark:text-rose-200 flex items-start gap-2">
                <AlertCircle size={16} className="mt-0.5 text-rose-600 shrink-0" />
                <div>
                  <strong>Export Failed:</strong> {exportError}
                </div>
              </div>
            )}
          </div>

          <div className="p-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/40">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <strong className="block text-sm font-semibold text-slate-800 dark:text-slate-100">
                  Restore Encrypted Backup
                </strong>
              </div>

              <div>
                <input
                  type="file"
                  ref={fileInputRef}
                  accept=".clxbk,.cliniqobak,.bak"
                  className="hidden"
                  onChange={handleFileSelected}
                />
                <Button
                  variant="secondary"
                  onClick={() => fileInputRef.current?.click()}
                  loading={isRestoring}
                  icon={Upload}
                >
                  Select Backup File
                </Button>
              </div>
            </div>

            {restoreResult && (
              <div className="mt-3 p-3 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 rounded text-xs text-emerald-800 dark:text-emerald-200 flex items-start gap-2">
                <CheckCircle2 size={16} className="mt-0.5 text-emerald-600 shrink-0" />
                <div>
                  <strong>Database Restored Successfully:</strong>
                  <div className="mt-1 font-mono text-[11px]">
                    {restoreResult.patients_count} patients, {restoreResult.consultations_count}{" "}
                    consultations, and {restoreResult.prescriptions_count} prescriptions restored.
                  </div>
                </div>
              </div>
            )}

            {restoreError && (
              <div className="mt-3 p-3 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded text-xs text-rose-800 dark:text-rose-200 flex items-start gap-2">
                <AlertCircle size={16} className="mt-0.5 text-rose-600 shrink-0" />
                <div>
                  <strong>Restore Failed:</strong> {restoreError}
                </div>
              </div>
            )}
          </div>

          {isTauriDesktop() && (
            <div className="p-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/40 space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-start gap-2.5">
                  <HardDrive size={18} className="mt-0.5 text-teal-600 shrink-0" />
                  <div>
                    <strong className="block text-sm font-semibold text-slate-800 dark:text-slate-100">
                      Automatic Local Backups &amp; Rotation
                    </strong>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      Saved strictly on this PC in Documents/Cliniqo/Backups. Never uploaded to cloud.
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={handleRunAutoBackupNow}
                    loading={isRunningAutoBackup}
                  >
                    Run Auto-Backup Now
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={handleRunDatabaseDiagnostics}
                    loading={isRunningDiagnostics}
                    icon={ShieldCheck}
                  >
                    Verify DB Integrity
                  </Button>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2 border-t border-slate-200 dark:border-slate-800/80 text-xs">
                <label className="flex items-center gap-2 text-slate-700 dark:text-slate-200 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={autoBackupStatus?.config.enabled ?? true}
                    onChange={(e) => handleToggleAutoBackup(e.target.checked)}
                    className="rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                  />
                  Enable automatic local backups
                </label>

                <label className="flex items-center gap-2 text-slate-700 dark:text-slate-200">
                  <span>Frequency:</span>
                  <select
                    aria-label="Auto-backup frequency"
                    value={autoBackupStatus?.config.interval_hours ?? 24}
                    onChange={(e) =>
                      handleUpdateAutoBackupConfig({
                        interval_hours: Number(e.target.value),
                      })
                    }
                    className="px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800"
                  >
                    <option value={6}>Every 6 hours</option>
                    <option value={12}>Every 12 hours</option>
                    <option value={24}>Every 24 hours</option>
                    <option value={168}>Weekly</option>
                  </select>
                </label>

                <label className="flex items-center gap-2 text-slate-700 dark:text-slate-200">
                  <span>Keep recent:</span>
                  <select
                    aria-label="Auto-backup retention"
                    value={autoBackupStatus?.config.max_retained ?? 7}
                    onChange={(e) =>
                      handleUpdateAutoBackupConfig({
                        max_retained: Number(e.target.value),
                      })
                    }
                    className="px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800"
                  >
                    <option value={3}>3 backups</option>
                    <option value={7}>7 backups</option>
                    <option value={14}>14 backups</option>
                    <option value={30}>30 backups</option>
                  </select>
                </label>
              </div>

              {autoBackupStatus && (
                <div className="text-[11px] text-slate-600 dark:text-slate-300 flex flex-wrap gap-x-4 gap-y-1">
                  <span>
                    Status: <strong className="uppercase">{autoBackupStatus.last_status}</strong>
                  </span>
                  <span>
                    Retained auto-backups: <strong>{autoBackupStatus.retained_count}</strong> •
                    Manual backups: <strong>{autoBackupStatus.manual_count}</strong>
                  </span>
                  {autoBackupStatus.last_backup_at && (
                    <span>
                      Last backup: {formatDateTimeDDMMYYYY(new Date(autoBackupStatus.last_backup_at))}
                    </span>
                  )}
                </div>
              )}

              {autoBackupError && (
                <div className="p-2.5 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded text-xs text-rose-800 dark:text-rose-200">
                  <strong>Auto-backup notice:</strong> {autoBackupError}
                </div>
              )}

              {diagnostics && (
                <div
                  className={
                    diagnostics.health_status === "healthy"
                      ? "p-2.5 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 rounded text-xs text-emerald-800 dark:text-emerald-200"
                      : "p-2.5 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded text-xs text-amber-800 dark:text-amber-200"
                  }
                >
                  <div>
                    <strong>Database Health ({diagnostics.health_status.toUpperCase()}):</strong>{" "}
                    Schema v{diagnostics.schema_version} • Integrity: {diagnostics.integrity_details} •
                    FK violations: {diagnostics.foreign_key_violations}
                  </div>
                  {diagnostics.messages.map((m, i) => (
                    <div key={i} className="mt-1 text-[11px]">
                      {m}
                    </div>
                  ))}
                </div>
              )}

              {diagnosticsError && (
                <div className="p-2.5 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded text-xs text-rose-800 dark:text-rose-200">
                  <strong>Diagnostics failed:</strong> {diagnosticsError}
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      {/* SECTION 3: Application Auto-Updater */}
      <section className="settings-section">
        <div className="settings-title with-status">
          <div>
            <h2>Application Updates</h2>
          </div>
          <StatusPill tone="info">STABLE CHANNEL</StatusPill>
        </div>

        <div className="p-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/40 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <strong className="block text-sm font-semibold text-slate-800 dark:text-slate-100">
                Cliniqo Desktop Version {appVersion}
              </strong>
            </div>

            <Button
              variant="secondary"
              onClick={handleCheckUpdate}
              loading={isCheckingUpdate}
              icon={RefreshCw}
            >
              Check for Updates
            </Button>
          </div>

          {updateCompletion?.status === "completed" && updateCompletion.message && (
            <div className="p-3 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 rounded text-xs text-emerald-800 dark:text-emerald-200 flex items-center gap-2">
              <CheckCircle2 size={16} className="text-emerald-600 shrink-0" />
              <span>{updateCompletion.message}</span>
            </div>
          )}

          {updateCompletion?.status === "failed" && updateCompletion.message && (
            <div className="p-3 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded text-xs text-amber-800 dark:text-amber-200 flex items-start gap-2">
              <AlertCircle size={16} className="mt-0.5 text-amber-600 shrink-0" />
              <span>{updateCompletion.message}</span>
            </div>
          )}

          {updateStatusMessage && !updateResult?.available && (
            <div className="p-3 bg-slate-100 dark:bg-slate-800/80 rounded text-xs text-slate-700 dark:text-slate-200 flex items-center gap-2">
              <CheckCircle2 size={16} className="text-emerald-500 shrink-0" />
              <span>{updateStatusMessage}</span>
            </div>
          )}

          {updateResult?.available && (
            <div className="p-4 bg-teal-50 dark:bg-teal-950/40 border border-teal-200 dark:border-teal-900 rounded-lg space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-xs font-semibold uppercase tracking-wider text-teal-700 dark:text-teal-300">
                    Update Available
                  </span>
                  <div className="text-base font-bold text-slate-900 dark:text-white mt-0.5">
                    Cliniqo Version {updateResult.target_version}
                  </div>
                </div>
                <Button
                  variant="primary"
                  onClick={handleInstallUpdate}
                  loading={isInstallingUpdate}
                  disabled={isInstallingUpdate}
                >
                  Update Now
                </Button>
              </div>

              {isInstallingUpdate && updateProgress && (
                <div className="space-y-1.5 pt-1">
                  <div className="flex items-center justify-between text-xs text-teal-800 dark:text-teal-200">
                    <span>{updateProgress.message}</span>
                    {typeof updateProgress.percent === "number" && (
                      <span className="font-semibold">{updateProgress.percent}%</span>
                    )}
                  </div>
                  <div className="w-full h-2 rounded-full bg-teal-200/70 dark:bg-teal-900 overflow-hidden">
                    <div
                      className="h-full bg-teal-600 transition-all duration-200"
                      style={{
                        width: `${Math.min(100, Math.max(5, updateProgress.percent ?? 15))}%`,
                      }}
                    />
                  </div>
                </div>
              )}

              {!isInstallingUpdate && updateStatusMessage && (
                <div className="text-xs text-teal-800 dark:text-teal-200">
                  {updateStatusMessage}
                </div>
              )}

              {updateResult.release_notes && (
                <div className="text-xs text-slate-600 dark:text-slate-300 border-t border-teal-200 dark:border-teal-900/60 pt-2">
                  <strong>Release Notes:</strong>
                  <p className="mt-1">{updateResult.release_notes}</p>
                </div>
              )}

              <div className="text-[11px] text-teal-800 dark:text-teal-300/80 flex items-center gap-1.5 pt-1">
                <ShieldCheck size={14} />
                <span>Existing SQLite patient database and DPAPI encryption keys are preserved.</span>
              </div>
            </div>
          )}

          {updateError && (
            <div className="p-3 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded text-xs text-rose-800 dark:text-rose-200 flex items-start gap-2">
              <AlertCircle size={16} className="mt-0.5 text-rose-600 shrink-0" />
              <div>
                <strong>Update Error:</strong> {updateError}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Restore Confirmation Dialog */}
      {showRestoreConfirm && (
        <Modal
          title="Restore Encrypted Backup?"
          description="Confirm that you have reviewed the backup file and understand the restore process."
          onClose={() => {
            if (!isRestoring) {
              setShowRestoreConfirm(false)
              setPendingRestoreBytes(null)
              setPendingFileName(null)
            }
          }}
        >
          <div className="space-y-3 text-sm text-slate-600 dark:text-slate-300">
            <p>
              You are about to restore backup file:{" "}
              <strong className="text-slate-900 dark:text-white font-mono text-xs">
                {pendingFileName}
              </strong>
            </p>
            <div className="p-3 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded text-xs text-amber-800 dark:text-amber-200 flex items-start gap-2">
              <AlertCircle size={16} className="mt-0.5 text-amber-600 shrink-0" />
              <span>
                Restoring will replace the current local SQLite database with this backup.
                Existing records not present in the backup will be overwritten.
              </span>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Passphrase (leave blank if exported without password):
              </label>
              <div className="relative">
                <Lock size={15} className="absolute left-2.5 top-2.5 text-slate-400" />
                <input
                  type="password"
                  placeholder="Optional backup passphrase..."
                  value={restorePassphrase}
                  onChange={(e) => setRestorePassphrase(e.target.value)}
                  className="w-full text-xs pl-8 pr-3 py-2 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800"
                />
              </div>
            </div>
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: "8px",
              marginTop: "20px",
            }}
          >
            <Button
              variant="secondary"
              onClick={() => {
                setShowRestoreConfirm(false)
                setPendingRestoreBytes(null)
                setPendingFileName(null)
              }}
              disabled={isRestoring}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={handleExecuteRestore}
              disabled={isRestoring}
              loading={isRestoring}
            >
              {isRestoring ? "Restoring..." : "Restore Database"}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  )
}

export default SyncSettings
