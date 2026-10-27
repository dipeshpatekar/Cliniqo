/**
 * Cliniqo Desktop Bridge
 * Provides typed Tauri 2 IPC bindings when running inside the Tauri Windows desktop shell,
 * with graceful fallback for standard web browser environments and cryptographically verified sessions.
 */

export interface DesktopInfo {
  os: string
  arch: string
  app_version: string
  is_desktop: boolean
  db_initialized: boolean
  db_path?: string
}

export interface DesktopSessionContext {
  doctor_id: string
  clinic_id: string
  doctor_email: string
  doctor_name: string
  role: string
  expires_at: number
}

export interface ClinicItem {
  id: string
  name: string
  slug: string
  role: string
  status: string
}

export interface DesktopLoginResult {
  session: DesktopSessionContext
  clinics: ClinicItem[]
  active_clinic_id: string
}

export interface SyncStatusInfo {
  active_clinic_id: string | null
  status: "IDLE" | "SYNCING" | "OFFLINE" | "ERROR"
  is_running: boolean
  last_synced_at: string | null
  pending_mutations: number
  in_flight_mutations: number
  conflicts_count: number
  last_error: string | null
}


export interface LocalPatientArgs {
  id?: string | null
  clinic_id: string
  patient_code: string
  name: string
  phone: string
  gender: string
  date_of_birth?: string | null
  age: number
  allergies: string[]
  conditions: string[]
  sensitive_notes?: string | null
}

export interface LocalPatientRecord {
  id: string
  server_id: string | null
  clinic_id: string
  patient_code: string
  name: string
  phone: string
  gender: string
  date_of_birth: string | null
  age: number
  allergies: string[]
  conditions: string[]
  sensitive_notes?: string | null
  sync_status: "PENDING" | "SYNCED" | "CONFLICT"
  server_version: number
  local_version: number
  updated_at: string
}

export interface LocalConsultationArgs {
  clinic_id: string
  patient_id: string
  consultation_date: string
  chief_complaint: string
  diagnosis: string
  clinical_snapshot_json?: string | null
}

export interface LocalConsultationRecord {
  id: string
  server_id: string | null
  clinic_id: string
  patient_id: string
  doctor_id: string
  consultation_date: string
  status: string
  chief_complaint: string
  diagnosis: string
  clinical_snapshot_json: string | null
  sync_status: "PENDING" | "SYNCED" | "CONFLICT"
  server_version: number
  local_version: number
  updated_at: string
}

export interface LocalPrescriptionArgs {
  clinic_id: string
  consultation_id: string
  patient_id: string
  prescription_number: string
  items_json: string
}

export interface LocalPrescriptionRecord {
  id: string
  server_id: string | null
  clinic_id: string
  consultation_id: string
  patient_id: string
  doctor_id: string
  prescription_number: string
  revision_number: number
  status: string
  items_json: string | null
  sync_status: "PENDING" | "SYNCED" | "CONFLICT"
  server_version: number
  local_version: number
  created_at: string
}

export interface SyncOutboxSummary {
  pending_count: number
  in_flight_count: number
  synced_count: number
  conflict_count: number
  failed_count: number
}

/**
 * Detects if the current application is running inside a Tauri desktop container.
 */
export function isTauriDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

/**
 * Returns the configured API base URL, safely falling back to local backend in development.
 * Never leaks MongoDB credentials or administrative secrets to the frontend.
 */
export function getApiBaseUrl(): string {
  if (
    typeof import.meta !== "undefined" &&
    import.meta.env?.VITE_API_BASE_URL
  ) {
    return import.meta.env.VITE_API_BASE_URL
  }
  return "http://localhost:3000"
}

/**
 * Safely invokes a Tauri command if running in desktop mode.
 */
async function invokeTauri<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T | null> {
  if (!isTauriDesktop()) {
    return null
  }

  try {
    const { invoke } = await import("@tauri-apps/api/core")
    return await invoke<T>(cmd, args)
  } catch (err) {
    console.error(`[Tauri Bridge] Error invoking ${cmd}:`, err)
    throw err
  }
}

export async function getDesktopInfo(): Promise<DesktopInfo | null> {
  return invokeTauri<DesktopInfo>("get_desktop_info")
}

export async function loginDesktop(
  email: string,
  password: string,
): Promise<DesktopLoginResult | null> {
  return invokeTauri<DesktopLoginResult>("login_desktop", {
    email,
    password,
  })
}

export async function loginDesktopSession(
  token: string,
  clinicId: string,
  role: string,
  refreshToken?: string,
): Promise<DesktopSessionContext | null> {
  return invokeTauri<DesktopSessionContext>("login_desktop_session", {
    token,
    clinicId,
    role,
    refreshToken: refreshToken || null,
  })
}

export async function logoutDesktopSession(): Promise<void> {
  await invokeTauri<void>("logout_desktop_session")
}

export async function refreshDesktopSession(
  _clinicId?: string,
  _role?: string,
): Promise<DesktopLoginResult | null> {
  try {
    return await invokeTauri<DesktopLoginResult>("refresh_desktop_session")
  } catch (err) {
    console.warn("[Desktop Bridge] Refresh failed closed:", err)
    return null
  }
}

export async function getSyncStatus(): Promise<SyncStatusInfo | null> {
  return invokeTauri<SyncStatusInfo>("get_sync_status")
}

export async function switchActiveClinic(
  clinicId: string,
  role: string,
): Promise<DesktopSessionContext | null> {
  return invokeTauri<DesktopSessionContext>("switch_active_clinic", {
    clinicId,
    role,
  })
}

export async function hasPersistedRefreshToken(): Promise<boolean> {
  const result = await invokeTauri<boolean>("has_persisted_refresh_token")
  return result ?? false
}

export async function getDesktopSession(): Promise<DesktopSessionContext | null> {
  return invokeTauri<DesktopSessionContext | null>("get_desktop_session")
}

export async function saveLocalPatient(
  args: LocalPatientArgs,
): Promise<string | null> {
  return invokeTauri<string>("save_local_patient", { args })
}

export async function deleteLocalPatient(
  clinicId: string,
  patientId: string,
): Promise<boolean> {
  const result = await invokeTauri<void>("delete_local_patient", {
    clinicId,
    patientId,
  })
  return result !== null
}

export async function getLocalPatients(
  clinicId: string,
): Promise<LocalPatientRecord[]> {
  const result = await invokeTauri<LocalPatientRecord[]>("get_local_patients", {
    clinicId,
  })
  return result ?? []
}

export async function saveLocalConsultation(
  args: LocalConsultationArgs,
): Promise<string | null> {
  return invokeTauri<string>("save_local_consultation", { args })
}

export async function getLocalConsultations(
  clinicId: string,
): Promise<LocalConsultationRecord[]> {
  const result = await invokeTauri<LocalConsultationRecord[]>(
    "get_local_consultations",
    { clinicId },
  )
  return result ?? []
}

export async function saveLocalPrescription(
  args: LocalPrescriptionArgs,
): Promise<string | null> {
  return invokeTauri<string>("save_local_prescription", { args })
}

export async function getLocalPrescriptions(
  clinicId: string,
): Promise<LocalPrescriptionRecord[]> {
  const result = await invokeTauri<LocalPrescriptionRecord[]>(
    "get_local_prescriptions",
    { clinicId },
  )
  return result ?? []
}

export async function getSyncOutboxSummary(
  clinicId: string,
): Promise<SyncOutboxSummary | null> {
  return invokeTauri<SyncOutboxSummary>("get_sync_outbox_summary", { clinicId })
}

export interface LocalSyncStateRecord {
  clinic_id: string
  last_pulled_seq: number
  last_pulled_at: string
  last_pushed_at: string | null
  in_sync: boolean
}

export async function getSyncState(
  clinicId: string,
): Promise<LocalSyncStateRecord | null> {
  return invokeTauri<LocalSyncStateRecord | null>("get_sync_state", {
    clinicId,
  })
}
