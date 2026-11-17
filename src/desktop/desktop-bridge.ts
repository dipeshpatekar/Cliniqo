/**
 * Cliniqo Desktop Bridge
 * Provides typed Tauri 2 IPC bindings when running inside the Tauri Windows desktop shell,
 * with graceful fallback for standard web browser environments and cryptographically verified sessions.
 */
import type { CatalogueItem, CatalogueSearchResult } from "../types"
import stockReportData from "../data/stock-report-18-10-26.json"

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
  clinic_name?: string
  doctor_email: string
  doctor_name: string
  role: string
  expires_at: number
  is_offline?: boolean
}

export interface ClinicAddressData {
  street?: string
  city?: string
  state?: string
  postalCode?: string
  country?: string
}

export interface ClinicItem {
  id: string
  name: string
  slug: string
  role: string
  status: string
  phone?: string
  email?: string
  address?: ClinicAddressData
  location_link?: string
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

export interface SavePatientResult {
  id: string
  patient_code: string
}

export type DiagnosticCategory =
  | "SESSION_EXPIRED"
  | "CLINIC_MISMATCH"
  | "DATABASE_BUSY"
  | "DATABASE_CONSTRAINT"
  | "DATABASE_FULL"
  | "ENCRYPTION_FAILURE"
  | "PATIENT_ID_ALLOCATION_FAILURE"
  | "DATABASE_TRANSACTION_FAILURE"
  | "UNKNOWN_SAVE_FAILURE"

export interface PatientSaveDiagnostic {
  category: DiagnosticCategory
  stage: string
  command: string
  sqlite_error_code?: string | null
  message: string
  retryable: boolean
}

export class PatientSaveError extends Error {
  diagnostic: PatientSaveDiagnostic
  constructor(diagnostic: PatientSaveDiagnostic) {
    super(diagnostic.message)
    this.name = "PatientSaveError"
    this.diagnostic = diagnostic
  }
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
  age_months?: number | null
  allergies: string[]
  conditions: string[]
  sensitive_notes?: string | null
  client_mutation_id?: string | null
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
  age_months?: number | null
  allergies: string[]
  conditions: string[]
  sensitive_notes?: string | null
  sync_status: "PENDING" | "SYNCED" | "CONFLICT"
  server_version: number
  local_version: number
  updated_at: string
  last_visit?: string | null
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

export interface ReviseLocalPrescriptionArgs {
  clinic_id: string
  prescription_id: string
  expected_revision_number: number
  items_json: string
  reason_for_revision: string
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
 * Production and development backend API URLs.
 * In production desktop and web builds, never points at localhost.
 */
export const PRODUCTION_API_URL = "https://cliniqo-backend-68x3.onrender.com"
export const DEFAULT_DEV_API_URL = "http://localhost:3000"

/**
 * Returns the configured API base URL, safely falling back to local backend in development.
 * Never leaks MongoDB credentials or administrative secrets to the frontend.
 * In production builds, never returns localhost to avoid targeting non-existent local servers.
 */
export function getApiBaseUrl(): string {
  if (
    typeof import.meta !== "undefined" &&
    import.meta.env?.VITE_API_BASE_URL
  ) {
    const customUrl = import.meta.env.VITE_API_BASE_URL.trim()
    if (customUrl) {
      return customUrl.replace(/\/+$/, "")
    }
  }

  // In production builds (packaged app or production deployment), never default to localhost
  if (typeof import.meta !== "undefined" && import.meta.env?.PROD) {
    return PRODUCTION_API_URL
  }

  return DEFAULT_DEV_API_URL
}

export const getBackendUrl = getApiBaseUrl

/**
 * Returns the trusted backend API URL from the native desktop environment if available.
 */
export async function getTrustedApiUrl(): Promise<string> {
  if (isTauriDesktop()) {
    try {
      const url = await invokeTauri<string>("get_trusted_api_url")
      if (url) return url
    } catch {
      // Fallback to getApiBaseUrl
    }
  }
  return getApiBaseUrl()
}

export interface RegisterDoctorInput {
  fullName: string
  email: string
  password: string
  phone?: string
}

export interface RegisterDoctorResult {
  accessToken: string
  refreshToken: string
  doctor: {
    id: string
    email: string
    fullName: string
    phone?: string
  }
  session?: DesktopSessionContext | null
}

export interface CreateClinicInput {
  name: string
  slug?: string
  phone: string
  email: string
  address: {
    street: string
    city: string
    state: string
    postalCode: string
    country: string
  }
  location_link?: string
}

export interface CreateClinicResult {
  clinic: {
    _id?: string
    id?: string
    name: string
    slug: string
    phone: string
    email: string
    address?: ClinicAddressData
    location_link?: string
  }
  membership: {
    _id?: string
    id?: string
    clinicId?: string
    doctorId?: string
    role: string
  }
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
  } catch (err: any) {
    console.error(`[Tauri Bridge] Error invoking ${cmd}:`, err)
    if (typeof err === "string") {
      const normalized = new Error(err)
      const lower = err.toLowerCase()
      if (
        lower.includes("unreachable") ||
        lower.includes("dns error") ||
        lower.includes("failed to lookup") ||
        lower.includes("no such host") ||
        lower.includes("connection refused") ||
        lower.includes("connection timed out") ||
        lower.includes("network")
      ) {
        ;(normalized as any).isNetworkError = true
      }
      throw normalized
    }
    throw err
  }
}

export async function registerDoctor(
  input: RegisterDoctorInput,
): Promise<RegisterDoctorResult> {
  // If running in Tauri desktop environment, use native Rust command for DPAPI storage
  // and direct OS network stack request (bypassing WebView2 CORS and local loopback issues)
  if (isTauriDesktop()) {
    const desktopResult = await invokeTauri<RegisterDoctorResult>(
      "register_desktop",
      { input },
    )
    if (desktopResult) {
      return desktopResult
    }
  }

  const baseUrl = getApiBaseUrl()
  const url = `${baseUrl}/auth/register`
  let res: Response | null = null
  let lastNetErr: any = null

  const maxAttempts = 3
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      })
      break
    } catch (netErr: any) {
      lastNetErr = netErr
      const isFetchFail =
        netErr?.message === "Failed to fetch" ||
        netErr?.name === "TypeError" ||
        netErr?.code === "ECONNREFUSED"
      if (attempt < maxAttempts && isFetchFail) {
        await new Promise((r) => setTimeout(r, attempt * 1000))
        continue
      }
      break
    }
  }

  if (!res) {
    const isFetchFail =
      lastNetErr?.message === "Failed to fetch" ||
      lastNetErr?.name === "TypeError" ||
      lastNetErr?.code === "ECONNREFUSED"
    const message = isFetchFail
      ? `Unable to connect to the Cliniqo authentication server at ${baseUrl}. Please check your internet connection or verify the server is running.`
      : lastNetErr?.message || "Registration request failed"
    const err = new Error(message)
    ;(err as any).isNetworkError = true
    throw err
  }

  const data = await res.json().catch(() => ({}))

  if (!res.ok) {
    if (res.status === 409) {
      // Conflict recovery: verify if doctor was registered during an interrupted connection
      try {
        const loginRes = await fetch(`${baseUrl}/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: input.email,
            password: input.password,
          }),
        })
        if (loginRes.ok) {
          const loginData = await loginRes.json()
          if (loginData?.accessToken && loginData?.doctor) {
            return loginData as RegisterDoctorResult
          }
        }
      } catch {
        // Fall through to 409 error
      }
    }

    let message = data?.message
    if (Array.isArray(message)) {
      message = message.join(", ")
    }
    if (!message) {
      message =
        res.status === 409
          ? "An account with this email address already exists."
          : `Registration failed (${res.status})`
    }
    const err = new Error(message)
    ;(err as any).status = res.status
    throw err
  }

  return data as RegisterDoctorResult
}

export async function createClinic(
  token: string,
  input: CreateClinicInput,
): Promise<CreateClinicResult> {
  if (isTauriDesktop()) {
    const desktopResult = await invokeTauri<CreateClinicResult>(
      "create_clinic_desktop",
      { input },
    )
    if (desktopResult) {
      return desktopResult
    }
  }

  const baseUrl = getApiBaseUrl()
  const url = `${baseUrl}/clinics`
  let res: Response
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(input),
    })
  } catch (netErr: any) {
    const isFetchFail =
      netErr?.message === "Failed to fetch" ||
      netErr?.name === "TypeError" ||
      netErr?.code === "ECONNREFUSED"
    const message = isFetchFail
      ? `Unable to connect to the Cliniqo server at ${baseUrl}. Please check your network connection.`
      : netErr?.message || "Failed to create clinic"
    const err = new Error(message)
    ;(err as any).isNetworkError = true
    throw err
  }

  const data = await res.json().catch(() => ({}))

  if (!res.ok) {
    let message = data?.message
    if (Array.isArray(message)) {
      message = message.join(", ")
    }
    if (!message) {
      message =
        res.status === 401
          ? "Unauthorized session. Token has expired."
          : `Failed to create clinic (${res.status})`
    }
    const err = new Error(message)
    ;(err as any).status = res.status
    throw err
  }

  return data as CreateClinicResult
}

export async function refreshAuthTokens(
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const baseUrl = getApiBaseUrl()
  const url = `${baseUrl}/auth/refresh`
  let res: Response
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ refreshToken }),
    })
  } catch (netErr: any) {
    const isFetchFail =
      netErr?.message === "Failed to fetch" ||
      netErr?.name === "TypeError" ||
      netErr?.code === "ECONNREFUSED"
    const message = isFetchFail
      ? `Unable to connect to the Cliniqo server at ${baseUrl}. Please check your network connection.`
      : netErr?.message || "Failed to refresh authentication session"
    const err = new Error(message)
    ;(err as any).isNetworkError = true
    throw err
  }

  const data = await res.json().catch(() => ({}))

  if (!res.ok) {
    const err = new Error(
      data?.message || "Failed to refresh authentication session",
    )
    ;(err as any).status = res.status
    throw err
  }

  return data
}

export interface ForgotPasswordResult {
  message: string
}

export interface VerifyOtpResult {
  message: string
  resetToken: string
}

export interface ResetPasswordResult {
  message: string
}

export async function requestPasswordResetOtp(
  email: string,
): Promise<ForgotPasswordResult> {
  const baseUrl = getApiBaseUrl()
  const res = await fetch(`${baseUrl}/auth/forgot-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: email.trim().toLowerCase() }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const errorMsg =
      data?.message || data?.error || "Failed to send verification code."
    const err = new Error(
      Array.isArray(errorMsg) ? errorMsg.join(" ") : errorMsg,
    )
    ;(err as any).status = res.status
    throw err
  }
  return data
}

export async function verifyPasswordResetOtp(
  email: string,
  otp: string,
): Promise<VerifyOtpResult> {
  const baseUrl = getApiBaseUrl()
  const res = await fetch(`${baseUrl}/auth/verify-otp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: email.trim().toLowerCase(),
      otp: otp.trim(),
    }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const errorMsg =
      data?.message ||
      data?.error ||
      "That code is not valid. Check all six digits and try again."
    const err = new Error(
      Array.isArray(errorMsg) ? errorMsg.join(" ") : errorMsg,
    )
    ;(err as any).status = res.status
    throw err
  }
  return data
}

export async function resetPasswordWithToken(
  token: string,
  newPassword: string,
): Promise<ResetPasswordResult> {
  const baseUrl = getApiBaseUrl()
  const res = await fetch(`${baseUrl}/auth/reset-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, newPassword }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const errorMsg = data?.message || data?.error || "Failed to reset password."
    const err = new Error(
      Array.isArray(errorMsg) ? errorMsg.join(" ") : errorMsg,
    )
    ;(err as any).status = res.status
    throw err
  }
  return data
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
    console.warn("[Desktop Bridge] Refresh encountered error. Attempting offline fallback:", err)
    try {
      const offline = await invokeTauri<DesktopLoginResult | null>(
        "restore_offline_desktop_session",
      )
      if (offline) return offline
    } catch {}
    return null
  }
}

export async function restoreOfflineDesktopSession(): Promise<DesktopLoginResult | null> {
  try {
    return await invokeTauri<DesktopLoginResult | null>(
      "restore_offline_desktop_session",
    )
  } catch (err) {
    console.warn("[Desktop Bridge] Offline restoration failed:", err)
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

export async function getNextPatientCode(
  clinicId: string,
): Promise<string | null> {
  if (!isTauriDesktop()) {
    return null
  }
  return invokeTauri<string>("get_next_patient_code", { clinicId })
}

function classifyDiagnosticError(err: any): PatientSaveDiagnostic {
  const errMsg =
    typeof err === "string"
      ? err
      : err?.message || String(err || "")
  const lower = errMsg.toLowerCase()

  let category: DiagnosticCategory = "UNKNOWN_SAVE_FAILURE"
  let retryable = true

  if (
    lower.includes("session expired") ||
    lower.includes("unauthenticated") ||
    lower.includes("session_expired")
  ) {
    category = "SESSION_EXPIRED"
    retryable = true
  } else if (
    lower.includes("clinic mismatch") ||
    lower.includes("crossclinic") ||
    lower.includes("clinic_mismatch")
  ) {
    category = "CLINIC_MISMATCH"
    retryable = false
  } else if (
    lower.includes("busy") ||
    lower.includes("locked") ||
    lower.includes("database_busy")
  ) {
    category = "DATABASE_BUSY"
    retryable = true
  } else if (
    lower.includes("disk") ||
    lower.includes("full") ||
    lower.includes("database_full")
  ) {
    category = "DATABASE_FULL"
    retryable = false
  } else if (
    lower.includes("constraint") ||
    lower.includes("unique") ||
    lower.includes("database_constraint")
  ) {
    category = "DATABASE_CONSTRAINT"
    retryable = false
  } else if (
    lower.includes("encryption") ||
    lower.includes("crypto") ||
    lower.includes("encryption_failure")
  ) {
    category = "ENCRYPTION_FAILURE"
    retryable = false
  } else if (
    lower.includes("allocation") ||
    lower.includes("patient_id_allocation")
  ) {
    category = "PATIENT_ID_ALLOCATION_FAILURE"
    retryable = true
  } else if (
    lower.includes("transaction") ||
    lower.includes("database_transaction")
  ) {
    category = "DATABASE_TRANSACTION_FAILURE"
    retryable = true
  }

  return {
    category,
    stage: "save_local_patient",
    command: "save_local_patient",
    sqlite_error_code: null,
    message: errMsg || "Failed to save patient.",
    retryable,
  }
}

export async function saveLocalPatient(
  args: LocalPatientArgs,
): Promise<SavePatientResult | null> {
  if (!isTauriDesktop()) {
    return null
  }

  try {
    const res = await invokeTauri<SavePatientResult>("save_local_patient", {
      args,
    })
    return res
  } catch (err: any) {
    let diag: PatientSaveDiagnostic
    try {
      const raw = typeof err === "string" ? err : err?.message
      const parsed = typeof raw === "string" ? JSON.parse(raw) : err
      if (parsed && typeof parsed.category === "string") {
        diag = {
          category: parsed.category as DiagnosticCategory,
          stage: parsed.stage || "save_local_patient",
          command: parsed.command || "save_local_patient",
          sqlite_error_code: parsed.sqlite_error_code || null,
          message: parsed.message || "Failed to save patient record.",
          retryable: parsed.retryable ?? true,
        }
      } else {
        diag = classifyDiagnosticError(err)
      }
    } catch {
      diag = classifyDiagnosticError(err)
    }

    // Diagnostic logging strictly avoiding any PII
    console.error("[PatientSaveDiagnostic]", {
      category: diag.category,
      stage: diag.stage,
      command: diag.command,
      sqlite_error_code: diag.sqlite_error_code,
      retryable: diag.retryable,
    })

    throw new PatientSaveError(diag)
  }
}

export async function deleteLocalPatient(
  clinicId: string,
  patientId: string,
): Promise<boolean> {
  if (!isTauriDesktop()) {
    return false
  }
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
  patientId?: string | null,
): Promise<LocalConsultationRecord[]> {
  const result = await invokeTauri<LocalConsultationRecord[]>(
    "get_local_consultations",
    { clinicId, patientId: patientId || null },
  )
  return result ?? []
}

export async function saveLocalPrescription(
  args: LocalPrescriptionArgs,
): Promise<string | null> {
  return invokeTauri<string>("save_local_prescription", { args })
}

export async function reviseLocalPrescription(
  args: ReviseLocalPrescriptionArgs,
): Promise<string | null> {
  return invokeTauri<string>("revise_local_prescription", { args })
}

export async function getLocalPrescriptions(
  clinicId: string,
  patientId?: string | null,
): Promise<LocalPrescriptionRecord[]> {
  const result = await invokeTauri<LocalPrescriptionRecord[]>(
    "get_local_prescriptions",
    { clinicId, patientId: patientId || null },
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

export interface SyncConflictRecord {
  id: string
  outbox_id: string
  entity_type: "PATIENT" | "CONSULTATION" | "PRESCRIPTION" | string
  entity_id: string
  server_version: number
  client_version: number
  server_payload: string
  client_payload: string
  conflict_reason: string
  resolution_payload: string | null
  status: "OPEN" | "RESOLVED" | "DISMISSED" | string
  resolved_at: string | null
  resolution_strategy: "USE_SERVER" | "USE_LOCAL" | "MERGE_MANUAL" | "PRESERVE_BOTH" | string | null
  created_at: string
}

export async function getSyncConflicts(
  clinicId: string,
  statusFilter?: "OPEN" | "RESOLVED" | "DISMISSED" | null,
): Promise<SyncConflictRecord[]> {
  const result = await invokeTauri<SyncConflictRecord[]>("get_sync_conflicts", {
    clinicId,
    statusFilter: statusFilter ?? null,
  })
  return result ?? []
}

export async function resolveSyncConflict(
  clinicId: string,
  conflictId: string,
  strategy: "USE_SERVER" | "USE_LOCAL" | "MERGE_MANUAL" | "PRESERVE_BOTH",
  resolutionPayload?: string | null,
): Promise<SyncConflictRecord | null> {
  return invokeTauri<SyncConflictRecord>("resolve_sync_conflict", {
    clinicId,
    conflictId,
    strategy,
    resolutionPayload: resolutionPayload ?? null,
  })
}

export interface LocalInvoiceItem {
  description: string
  quantity: number
  unit_price_paise: number
  total_paise: number
  name?: string
  line_total_paise?: number
}

export interface SaveInvoiceArgs {
  id?: string | null
  clinic_id: string
  patient_id: string
  consultation_id?: string | null
  invoice_number: string
  invoice_date: string
  status?: string | null
  payment_status?: string | null
  items: LocalInvoiceItem[]
  discount_paise?: number | null
  tax_rate_percent?: number | null
  notes?: string | null
  subtotal_paise?: number
  tax_paise?: number
  total_paise?: number
  payment_notes?: string | null
}

export interface LocalInvoiceRecord {
  id: string
  server_id: string | null
  clinic_id: string
  patient_id: string
  consultation_id: string | null
  invoice_number: string
  invoice_date: string
  status: "DRAFT" | "FINALIZED" | "CANCELLED" | string
  payment_status: "UNPAID" | "PAID" | string
  subtotal_paise: number
  discount_paise: number
  tax_rate_percent: number
  tax_paise: number
  total_paise: number
  items: LocalInvoiceItem[]
  notes: string | null
  payment_notes: string | null
  sync_status: "PENDING" | "SYNCED" | "CONFLICT" | string
  server_version: number
  local_version: number
  created_at: string
  updated_at: string
}

export interface LocalFormularyItemRecord {
  id: string
  server_id: string | null
  clinic_id: string
  name: string
  formulation: string
  strength: string | null
  active_ingredient: string | null
  default_dosage: string | null
  default_route: string | null
  default_frequency: string | null
  default_duration: string | null
  default_instructions: string | null
  is_active: boolean
  sync_status: string
  updated_at: string
}

export interface SaveFormularyArgs {
  id?: string | null
  clinic_id: string
  name: string
  formulation: string
  strength?: string | null
  active_ingredient?: string | null
  default_dosage?: string | null
  default_route?: string | null
  default_frequency?: string | null
  default_duration?: string | null
  default_instructions?: string | null
}

export async function saveLocalInvoice(
  args: SaveInvoiceArgs,
): Promise<string | null> {
  const normalizedItems: LocalInvoiceItem[] = (args.items || []).map((it) => {
    const desc = it.description || it.name || "Service"
    const qty = Math.max(1, Math.floor(Number(it.quantity) || 1))
    const unitPaise = Math.max(0, Math.round(Number(it.unit_price_paise) || 0))
    const totalPaise =
      typeof it.total_paise === "number"
        ? it.total_paise
        : typeof it.line_total_paise === "number"
          ? it.line_total_paise
          : qty * unitPaise
    return {
      description: desc,
      quantity: qty,
      unit_price_paise: unitPaise,
      total_paise: totalPaise,
      name: desc,
      line_total_paise: totalPaise,
    }
  })

  const payload: SaveInvoiceArgs = {
    id: args.id || null,
    clinic_id: args.clinic_id,
    patient_id: args.patient_id,
    consultation_id: args.consultation_id || null,
    invoice_number: args.invoice_number,
    invoice_date: args.invoice_date || new Date().toISOString().split("T")[0],
    status: args.status || null,
    payment_status: args.payment_status || null,
    items: normalizedItems,
    discount_paise: args.discount_paise ?? null,
    tax_rate_percent: args.tax_rate_percent ?? null,
    notes: args.notes || null,
  }

  return invokeTauri<string>("save_local_invoice", { args: payload })
}

export async function getNextInvoiceNumber(clinicId: string): Promise<string> {
  if (isTauriDesktop()) {
    try {
      const res = await invokeTauri<string>("get_next_invoice_number", { clinicId })
      if (res && res.trim()) {
        return res.trim()
      }
    } catch (err) {
      console.warn("Failed to get next sequential invoice number from desktop bridge:", err)
    }
  }
  const currentYear = new Date().getFullYear()
  return `INV-${currentYear}-0001`
}

export async function getLocalInvoices(
  clinicId: string,
  patientId?: string | null,
): Promise<LocalInvoiceRecord[]> {
  const result = await invokeTauri<LocalInvoiceRecord[]>("get_local_invoices", {
    clinicId,
    patientId: patientId ?? null,
  })
  return result ?? []
}

export async function getLocalInvoiceById(
  clinicId: string,
  invoiceId: string,
): Promise<LocalInvoiceRecord | null> {
  return invokeTauri<LocalInvoiceRecord | null>("get_local_invoice_by_id", {
    clinicId,
    invoiceId,
  })
}

export async function finalizeLocalInvoice(
  clinicId: string,
  invoiceId: string,
): Promise<LocalInvoiceRecord | null> {
  return invokeTauri<LocalInvoiceRecord>("finalize_local_invoice", {
    clinicId,
    invoiceId,
  })
}

export async function saveLocalFormularyItem(
  args: SaveFormularyArgs,
): Promise<string | null> {
  return invokeTauri<string>("save_local_formulary_item", { args })
}

export async function getLocalFormulary(
  clinicId: string,
): Promise<LocalFormularyItemRecord[]> {
  const result = await invokeTauri<LocalFormularyItemRecord[]>(
    "get_local_formulary",
    { clinicId },
  )
  return result ?? []
}

export async function deleteLocalFormularyItem(
  clinicId: string,
  id: string,
): Promise<boolean> {
  const result = await invokeTauri<void>("delete_local_formulary_item", {
    clinicId,
    id,
  })
  return result !== null
}

export interface StockItemInput {
  product_name: string
  unit: string
  company: string
  quantity: number
  value?: number | null
  batch_number?: string | null
}

export interface StockItemRecord {
  id: string
  clinic_id: string
  product_name: string
  unit: string
  company: string
  quantity: number
  value: number | null
  batch_number: string | null
  source_report: string
  created_at: string
  updated_at: string
}

export interface StockImportSummary {
  total_records: number
  successful: number
  skipped: number
  failed: number
  total_quantity: number
  total_value: number
  errors: string[]
}

export interface StockSummaryRecord {
  total_products: number
  total_quantity: number
  total_value: number
}

export async function importInventoryStock(
  clinicId: string,
  items: StockItemInput[],
  overwrite = false,
  sourceReport?: string,
): Promise<StockImportSummary> {
  if (isTauriDesktop()) {
    const result = await invokeTauri<StockImportSummary>(
      "import_inventory_stock",
      {
        clinicId,
        items,
        overwrite,
        sourceReport: sourceReport || null,
      },
    )
    if (result) return result
  }

  // Safe Web / Mock fallback for tests and development
  let successful = 0
  let skipped = 0
  let failed = 0
  let total_quantity = 0
  let total_value = 0
  const errors: string[] = []

  const storageKey = `cliniqo-inventory-${clinicId}`
  const existing: StockItemRecord[] = JSON.parse(
    (typeof window !== "undefined" &&
      window.localStorage?.getItem(storageKey)) ||
      "[]",
  )

  for (const item of items) {
    if (!item.product_name || !item.product_name.trim()) {
      failed++
      errors.push("Skipped item with empty product name")
      continue
    }
    if (item.quantity < 0) {
      failed++
      errors.push(`Product '${item.product_name}' has negative quantity`)
      continue
    }

    const idx = existing.findIndex(
      (e) =>
        e.product_name.trim().toLowerCase() ===
          item.product_name.trim().toLowerCase() &&
        e.unit.trim().toLowerCase() === item.unit.trim().toLowerCase() &&
        e.company.trim().toLowerCase() === item.company.trim().toLowerCase(),
    )

    if (idx >= 0) {
      if (!overwrite) {
        skipped++
      } else {
        existing[idx].quantity = item.quantity
        existing[idx].value = item.value ?? null
        existing[idx].batch_number =
          item.batch_number ?? existing[idx].batch_number
        existing[idx].source_report =
          sourceReport || existing[idx].source_report
        existing[idx].updated_at = new Date().toISOString()
        successful++
        total_quantity += item.quantity
        if (item.value != null) total_value += item.value
      }
    } else {
      existing.push({
        id: `mock-inv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        clinic_id: clinicId,
        product_name: item.product_name.trim(),
        unit: item.unit.trim(),
        company: item.company.trim(),
        quantity: item.quantity,
        value: item.value ?? null,
        batch_number: item.batch_number ?? null,
        source_report: sourceReport || "STOCK REPORT (18-10-26)",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      successful++
      total_quantity += item.quantity
      if (item.value != null) total_value += item.value
    }
  }

  if (typeof window !== "undefined" && window.localStorage) {
    window.localStorage.setItem(storageKey, JSON.stringify(existing))
  }

  return {
    total_records: successful + skipped + failed,
    successful,
    skipped,
    failed,
    total_quantity,
    total_value,
    errors,
  }
}

export async function getInventoryStock(
  clinicId: string,
  query?: string,
): Promise<StockItemRecord[]> {
  if (isTauriDesktop()) {
    const result = await invokeTauri<StockItemRecord[]>("get_inventory_stock", {
      clinicId,
      query: query || null,
    })
    if (result) return result
  }

  const storageKey = `cliniqo-inventory-${clinicId}`
  const list: StockItemRecord[] = JSON.parse(
    (typeof window !== "undefined" &&
      window.localStorage?.getItem(storageKey)) ||
      "[]",
  )
  if (!query || !query.trim()) return list
  const q = query.trim().toLowerCase()
  return list.filter(
    (item) =>
      item.product_name.toLowerCase().includes(q) ||
      item.company.toLowerCase().includes(q) ||
      item.unit.toLowerCase().includes(q),
  )
}

export async function getInventoryStockSummary(
  clinicId: string,
): Promise<StockSummaryRecord> {
  if (isTauriDesktop()) {
    const result = await invokeTauri<StockSummaryRecord>(
      "get_inventory_stock_summary",
      { clinicId },
    )
    if (result) return result
  }

  const storageKey = `cliniqo-inventory-${clinicId}`
  const list: StockItemRecord[] = JSON.parse(
    (typeof window !== "undefined" &&
      window.localStorage?.getItem(storageKey)) ||
      "[]",
  )
  const total_quantity = list.reduce(
    (sum, item) => sum + (item.quantity || 0),
    0,
  )
  const total_value = list.reduce((sum, item) => sum + (item.value || 0), 0)
  return {
    total_products: list.length,
    total_quantity,
    total_value,
  }
}

export interface LocalCatalogueCacheRecord {
  id: string
  item_type: string
  name: string
  brand_name?: string | null
  generic_name?: string | null
  product_name?: string | null
  dosage_form?: string | null
  route?: string | null
  active_ingredients_json?: string | null
  strengths_json: string
  raw_strength_summary: string
  is_combination: boolean
  is_verified: boolean
  source_provenance: string
  cached_at: string
}

export async function searchLocalCatalogueCache(
  query: string,
  limit = 20,
  formulation?: string,
): Promise<CatalogueItem[]> {
  const result = await invokeTauri<LocalCatalogueCacheRecord[]>(
    "search_catalogue_cache",
    { query, limit, formulation: formulation || null },
  )
  if (!result) return []
  return result.map((r) => {
    let parsedStrengths = []
    try {
      parsedStrengths = JSON.parse(r.strengths_json)
    } catch {
      // ignore
    }
    let extraMeta: { releaseType?: string; manufacturer?: string } = {}
    if (r.active_ingredients_json) {
      try {
        extraMeta = JSON.parse(r.active_ingredients_json)
      } catch {
        // ignore
      }
    }
    return {
      id: r.id,
      sourceIdentifier: r.id,
      type: r.item_type as "BRAND" | "GENERIC",
      name: r.name,
      brandName: r.brand_name || undefined,
      genericName: r.generic_name || undefined,
      productName: r.product_name || undefined,
      dosageForm: r.dosage_form || undefined,
      route: r.route || undefined,
      strengths: parsedStrengths,
      rawStrengthSummary: r.raw_strength_summary,
      releaseType: extraMeta.releaseType,
      manufacturer: extraMeta.manufacturer,
      isCombination: r.is_combination,
      isStrengthVerified: r.is_verified,
      sourceProvenance: r.source_provenance,
      cachedAt: r.cached_at,
    }
  })
}

export async function getLocalCatalogueStrengthsCache(
  medicineName: string,
  formulation?: string,
): Promise<string[]> {
  const result = await invokeTauri<string[]>("get_catalogue_strengths_cache", {
    medicineName,
    formulation: formulation || null,
  })
  return result || []
}

export async function saveCatalogueCacheItems(
  items: CatalogueItem[],
): Promise<number> {
  const payload = items.map((it) => ({
    id: it.id || it.sourceIdentifier,
    item_type: it.type,
    name: it.name,
    brand_name: it.brandName || null,
    generic_name: it.genericName || null,
    product_name: it.productName || null,
    dosage_form: it.dosageForm || null,
    route: it.route || null,
    active_ingredients_json:
      it.releaseType || it.manufacturer
        ? JSON.stringify({
            releaseType: it.releaseType,
            manufacturer: it.manufacturer,
          })
        : null,
    strengths_json: JSON.stringify(it.strengths || []),
    raw_strength_summary: it.rawStrengthSummary || "",
    is_combination: Boolean(it.isCombination),
    is_verified: Boolean(it.isStrengthVerified),
    source_provenance: it.sourceProvenance || "CLINICAL_LIBRARY",
  }))
  const result = await invokeTauri<number>("save_catalogue_cache", {
    items: payload,
  })
  return result ?? 0
}

export async function seedCatalogueCache(): Promise<number> {
  if (!isTauriDesktop()) return 0
  try {
    const result = await invokeTauri<number>("seed_catalogue_cache")
    return result ?? 0
  } catch {
    return 0
  }
}

export function mapStockUnitToFormulation(unit?: string | null): string {
  const u = (unit || "").trim().toUpperCase()
  if (!u) return ""
  if (u.includes("TAB")) return "Tablet"
  if (u.includes("CAP")) return "Capsule"
  if (u.includes("SYP")) return "Syrup"
  if (u.includes("GEL") || u.includes("JELLY")) return "Gel"
  if (
    u.includes("INJ") ||
    u.includes("AMP") ||
    u.includes("VIAL") ||
    u.includes("VAIL") ||
    u.includes("IV")
  )
    return "Injection"
  if (u.includes("CREAM")) return "Cream"
  if (u.includes("LOTION")) return "Lotion"
  if (u.includes("EYE DROP") || u.includes("OPHTH")) return "Eye Drops"
  if (u.includes("EAR DROP") || u.includes("OTIC")) return "Ear Drops"
  if (u.includes("DROP")) return "Drops"
  if (u.includes("POW")) return "Powder"
  if (u.includes("MOUTHWASH") || u.includes("GARGLE")) return "Mouthwash"
  if (u.includes("SUPP")) return "Suppository"
  if (u.includes("SPRAY")) return "Spray"
  if (u.includes("SOLUTION")) return "Solution"
  if (u.includes("OINT") || u.includes("PASTE")) return "Ointment"
  if (u.includes("RESP") || u.includes("INHAL")) return "Inhaler"
  if (u.includes("SUSP")) return "Suspension"
  return unit || ""
}

export function searchBundledStockReport(
  query: string,
  limit = 20,
  formulation?: string,
): CatalogueItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const normForm = formulation ? formulation.trim().toLowerCase() : null

  const results: CatalogueItem[] = []
  for (const item of stockReportData as Array<{
    product_name: string
    unit: string
    company: string
    quantity: number
    value: number
  }>) {
    const prod = (item.product_name || "").toLowerCase()
    const comp = (item.company || "").toLowerCase()
    if (!prod.includes(q) && !comp.includes(q)) {
      continue
    }

    const mappedForm = mapStockUnitToFormulation(item.unit)
    if (normForm && mappedForm && mappedForm.toLowerCase() !== normForm) {
      // If specific formulation requested, keep matching if product/company explicitly matched
    }

    results.push({
      id: `stock_${item.product_name.replace(/\s+/g, "_")}`,
      sourceIdentifier: `stock_${item.product_name}`,
      type: "BRAND",
      name: `${item.product_name} (Stock: ${item.quantity} ${item.unit})`,
      brandName: item.product_name,
      genericName: item.company,
      productName: item.product_name,
      dosageForm: mappedForm || item.unit,
      strengths: [],
      rawStrengthSummary: item.unit,
      manufacturer: item.company,
      isCombination: false,
      isStrengthVerified: true,
      sourceProvenance: "LOCAL_INVENTORY",
      cachedAt: new Date().toISOString(),
    })

    if (results.length >= limit) break
  }
  return results
}

export async function searchCatalogue(
  query: string,
  token?: string,
  limit = 20,
  formulation?: string,
  releaseType?: string,
): Promise<CatalogueSearchResult> {
  const isDesktop = isTauriDesktop()

  // In desktop mode, SQLite cache is high-speed, local, encrypted, and offline-first
  if (isDesktop) {
    try {
      const localItems = await searchLocalCatalogueCache(
        query,
        limit,
        formulation,
      )
      if (localItems && localItems.length > 0) {
        return {
          items: localItems,
          total: localItems.length,
          page: 1,
          limit,
          totalPages: Math.ceil(localItems.length / limit) || 1,
          attribution:
            "Cliniqo Clinical Formulary & Stock — Local Offline Cache",
          isOfflineCache: true,
        }
      }
    } catch {
      // Local cache query failed, fallback to bundled stock dataset
    }
  }

  // Online search when valid token is provided (web mode or desktop cache miss)
  const backendUrl = getBackendUrl()
  const validToken =
    token && !token.startsWith("doc_") && token.length > 20 ? token : undefined
  if (validToken && typeof navigator !== "undefined" && navigator.onLine) {
    try {
      const url = new URL(`${backendUrl}/catalogue/search`)
      url.searchParams.set("q", query)
      url.searchParams.set("limit", String(limit))
      if (formulation) url.searchParams.set("formulation", formulation)
      if (releaseType) url.searchParams.set("releaseType", releaseType)

      const resp = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${validToken}`,
          "Content-Type": "application/json",
        },
      })
      if (resp.ok) {
        const data = await resp.json()
        if (data.items && data.items.length > 0) {
          if (isDesktop) {
            saveCatalogueCacheItems(data.items).catch(() => {})
          }
          return {
            ...data,
            isOfflineCache: false,
          }
        }
      }
    } catch {
      // Network failure, fallback to offline search
    }
  }

  // Fallback: search bundled pharmacy stock report (1,793 records)
  const stockItems = searchBundledStockReport(query, limit, formulation)
  return {
    items: stockItems,
    total: stockItems.length,
    page: 1,
    limit,
    totalPages: Math.ceil(stockItems.length / limit) || 1,
    attribution: "Cliniqo Pharmacy Stock Report (18-10-26)",
    isOfflineCache: stockItems.length > 0,
  }
}

export async function getCatalogueStrengths(
  medicineName: string,
  token?: string,
  formulation?: string,
): Promise<{
  strengths: string[]
  isSingleMatch: boolean
  isOfflineCache?: boolean
}> {
  const isDesktop = isTauriDesktop()

  if (isDesktop) {
    try {
      const localStrengths = await getLocalCatalogueStrengthsCache(
        medicineName,
        formulation,
      )
      return {
        strengths: localStrengths || [],
        isSingleMatch: (localStrengths?.length || 0) === 1,
        isOfflineCache: true,
      }
    } catch {
      return {
        strengths: [],
        isSingleMatch: false,
        isOfflineCache: true,
      }
    }
  }

  const backendUrl = getBackendUrl()
  const validToken =
    token && !token.startsWith("doc_") && token.length > 20 ? token : undefined
  if (validToken && typeof navigator !== "undefined" && navigator.onLine) {
    try {
      const url = new URL(`${backendUrl}/catalogue/strengths`)
      url.searchParams.set("name", medicineName)
      if (formulation) url.searchParams.set("formulation", formulation)

      const resp = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${validToken}`,
          "Content-Type": "application/json",
        },
      })
      if (resp.ok) {
        const data = await resp.json()
        return {
          ...data,
          isOfflineCache: false,
        }
      }
    } catch {
      // Fallback
    }
  }

  const localStrengths = await getLocalCatalogueStrengthsCache(
    medicineName,
    formulation,
  )
  return {
    strengths: localStrengths,
    isSingleMatch: localStrengths.length === 1,
    isOfflineCache: isDesktop && localStrengths.length > 0,
  }
}

export interface CatalogueCacheStats {
  totalItems: number
  brandCount: number
  genericCount: number
  verifiedCount: number
}

export interface CatalogueSyncStatus {
  status: "IDLE" | "SYNCING" | "COMPLETED" | "FAILED"
  downloadedCount: number
  totalCount: number
  lastCursor: string | null
  lastSyncedAt: string | null
  error: string | null
  isReady: boolean
}

export async function getCatalogueSyncStatus(): Promise<CatalogueSyncStatus | null> {
  if (!isTauriDesktop()) return null
  try {
    return await invokeTauri<CatalogueSyncStatus>("get_catalogue_sync_status")
  } catch {
    return null
  }
}

export async function startCatalogueSync(): Promise<CatalogueSyncStatus | null> {
  if (!isTauriDesktop()) return null
  try {
    const status = await getCatalogueSyncStatus()
    if (status && status.isReady && status.downloadedCount >= 104367) {
      return status
    }
    return await invokeTauri<CatalogueSyncStatus>("start_catalogue_sync")
  } catch {
    return null
  }
}

export async function getCatalogueCacheStats(): Promise<CatalogueCacheStats | null> {
  return invokeTauri<CatalogueCacheStats>("get_catalogue_cache_stats")
}

export async function syncCatalogueIncremental(
  token: string,
  onProgress?: (synced: number, total: number) => void,
): Promise<{ totalSynced: number }> {
  const backendUrl = getBackendUrl()
  let cursor: string | undefined = undefined
  let totalSynced = 0
  let isDone = false

  while (!isDone) {
    const url = new URL(`${backendUrl}/catalogue/feed`)
    url.searchParams.set("limit", "100")
    if (cursor) url.searchParams.set("cursor", cursor)

    const resp = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    })
    if (!resp.ok) break

    const data = await resp.json()
    if (!data.items || data.items.length === 0) break

    await saveCatalogueCacheItems(data.items)
    totalSynced += data.items.length
    if (onProgress) onProgress(totalSynced, data.total || 0)

    if (!data.nextCursor || data.items.length < 100) {
      isDone = true
    } else {
      cursor = data.nextCursor
    }
  }

  return { totalSynced }
}

export interface ClinicProfile {
  clinic_id: string
  name: string
  slug: string
  phone: string
  email: string
  street: string
  city: string
  state: string
  postal_code: string
  country: string
  location_link: string
  updated_at?: string | null
}

export async function getClinicProfile(
  clinicId: string,
): Promise<ClinicProfile | null> {
  if (!clinicId) return null
  if (isTauriDesktop()) {
    try {
      return await invokeTauri<ClinicProfile | null>("get_clinic_profile", {
        clinicId,
      })
    } catch (e) {
      console.warn("Failed to retrieve clinic profile from desktop SQLite:", e)
      return null
    }
  }

  try {
    if (typeof window !== "undefined" && window.localStorage) {
      const raw = window.localStorage.getItem(
        `cliniqo_clinic_profile_${clinicId}`,
      )
      if (raw) return JSON.parse(raw)
    }
  } catch {}
  return null
}

export async function saveClinicProfile(
  args: Omit<ClinicProfile, "updated_at">,
): Promise<ClinicProfile | null> {
  let saved: ClinicProfile | null = null
  if (isTauriDesktop()) {
    try {
      saved = await invokeTauri<ClinicProfile>("save_clinic_profile", { args })
    } catch (e) {
      console.warn("Failed to persist clinic profile to desktop SQLite:", e)
      return null
    }
  } else {
    saved = {
      ...args,
      updated_at: new Date().toISOString(),
    }
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        window.localStorage.setItem(
          `cliniqo_clinic_profile_${args.clinic_id}`,
          JSON.stringify(saved),
        )
      }
    } catch {}
  }

  if (saved && typeof window !== "undefined") {
    try {
      window.dispatchEvent(
        new CustomEvent("cliniqo:profile-updated", {
          detail: { type: "clinic", profile: saved },
        }),
      )
    } catch {}
  }

  return saved
}

export interface DoctorProfile {
  doctor_id: string
  full_name: string
  email: string
  phone: string
  qualification: string
  registration_number: string
  gender: string
  updated_at?: string | null
}

export async function getDoctorProfile(
  doctorId?: string,
): Promise<DoctorProfile | null> {
  if (isTauriDesktop()) {
    try {
      return await invokeTauri<DoctorProfile | null>("get_doctor_profile", {
        doctorId: doctorId || null,
      })
    } catch (e) {
      console.warn("Failed to retrieve doctor profile from desktop SQLite:", e)
      return null
    }
  }

  try {
    if (typeof window !== "undefined" && window.localStorage) {
      const raw = window.localStorage.getItem(
        `cliniqo_doctor_profile_${doctorId || "default"}`,
      )
      if (raw) return JSON.parse(raw)
    }
  } catch {}
  return null
}

export async function saveDoctorProfile(
  args: Omit<DoctorProfile, "updated_at">,
): Promise<DoctorProfile | null> {
  let saved: DoctorProfile | null = null
  if (isTauriDesktop()) {
    try {
      saved = await invokeTauri<DoctorProfile>("save_doctor_profile", { args })
    } catch (e) {
      console.warn("Failed to persist doctor profile to desktop SQLite:", e)
      return null
    }
  } else {
    saved = {
      ...args,
      updated_at: new Date().toISOString(),
    }
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        window.localStorage.setItem(
          `cliniqo_doctor_profile_${args.doctor_id || "default"}`,
          JSON.stringify(saved),
        )
      }
    } catch {}
  }

  if (saved && typeof window !== "undefined") {
    try {
      window.dispatchEvent(
        new CustomEvent("cliniqo:profile-updated", {
          detail: { type: "doctor", profile: saved },
        }),
      )
    } catch {}
  }

  return saved
}

// ==========================================
// CLINICAL LIBRARY & EXCEL IMPORT BRIDGE
// ==========================================

export interface ClinicalImportItemInput {
  name: string
  generic_name?: string
  brand_name?: string
  composition?: string
  strength: string
  formulation: string
  dosage_form?: string
  route?: string
  manufacturer?: string
  category?: string
  pack_size?: string
  mrp?: number
  storage_instructions?: string
  default_dosage?: string
  default_frequency?: string
  default_duration?: string
  default_instructions?: string
}

export interface ClinicalImportBatchInput {
  clinic_id: string
  doctor_id?: string
  file_name: string
  items: ClinicalImportItemInput[]
  total_rows: number
  invalid_rows: number
  allow_update?: boolean
}

export interface ClinicalImportSummary {
  batch_id: string
  file_name: string
  total_rows: number
  valid_rows: number
  invalid_rows: number
  imported_rows: number
  skipped_rows: number
  status: string
  created_at: string
}

export interface ClinicalImportBatchRecord {
  id: string
  clinic_id: string
  doctor_id?: string
  file_name: string
  total_rows: number
  valid_rows: number
  invalid_rows: number
  imported_rows: number
  skipped_rows: number
  status: string
  created_at: string
  rolled_back_at?: string
}

export interface ClinicalMedicineRecord {
  id: string
  server_id?: string
  clinic_id: string
  batch_id?: string
  name: string
  generic_name?: string
  brand_name?: string
  composition?: string
  strength: string
  formulation: string
  dosage_form?: string
  route?: string
  manufacturer?: string
  category?: string
  pack_size?: string
  mrp?: number
  storage_instructions?: string
  default_dosage?: string
  default_frequency?: string
  default_duration?: string
  default_instructions?: string
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface SaveClinicalMedicineArgs {
  id?: string
  clinic_id: string
  name: string
  generic_name?: string
  brand_name?: string
  composition?: string
  strength: string
  formulation: string
  dosage_form?: string
  route?: string
  manufacturer?: string
  category?: string
  pack_size?: string
  mrp?: number
  storage_instructions?: string
  default_dosage?: string
  default_frequency?: string
  default_duration?: string
  default_instructions?: string
}

export async function importClinicalLibrary(
  batch: ClinicalImportBatchInput,
): Promise<ClinicalImportSummary> {
  if (isTauriDesktop()) {
    const res = await invokeTauri<ClinicalImportSummary>(
      "import_clinical_library",
      {
        clinicId: batch.clinic_id,
        batch,
      },
    )
    if (res) return res
  }

  // Web fallback: localStorage simulation
  const batchId = `batch_${Date.now()}`
  const now = new Date().toISOString()
  const storageKey = `cliniqo_clinical_library_${batch.clinic_id}`
  const batchKey = `cliniqo_clinical_batches_${batch.clinic_id}`

  const existingRaw = localStorage.getItem(storageKey)
  const existing: ClinicalMedicineRecord[] = existingRaw
    ? JSON.parse(existingRaw)
    : []

  let importedRows = 0
  let skippedRows = 0

  for (const item of batch.items) {
    const isDup = existing.some(
      (e) =>
        e.is_active &&
        e.name.toLowerCase().trim() === item.name.toLowerCase().trim() &&
        e.formulation.toLowerCase().trim() ===
          item.formulation.toLowerCase().trim() &&
        e.strength.toLowerCase().trim() === item.strength.toLowerCase().trim(),
    )
    if (isDup && !batch.allow_update) {
      skippedRows++
    } else {
      importedRows++
      existing.push({
        id: `med_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        clinic_id: batch.clinic_id,
        batch_id: batchId,
        name: item.name,
        generic_name: item.generic_name,
        brand_name: item.brand_name,
        composition: item.composition,
        strength: item.strength,
        formulation: item.formulation,
        dosage_form: item.dosage_form,
        route: item.route,
        manufacturer: item.manufacturer,
        category: item.category,
        pack_size: item.pack_size,
        mrp: item.mrp,
        storage_instructions: item.storage_instructions,
        default_dosage: item.default_dosage,
        default_frequency: item.default_frequency,
        default_duration: item.default_duration,
        default_instructions: item.default_instructions,
        is_active: true,
        created_at: now,
        updated_at: now,
      })
    }
  }

  localStorage.setItem(storageKey, JSON.stringify(existing))

  const batchesRaw = localStorage.getItem(batchKey)
  const batches: ClinicalImportBatchRecord[] = batchesRaw
    ? JSON.parse(batchesRaw)
    : []
  const batchRecord: ClinicalImportBatchRecord = {
    id: batchId,
    clinic_id: batch.clinic_id,
    doctor_id: batch.doctor_id,
    file_name: batch.file_name,
    total_rows: batch.total_rows,
    valid_rows: batch.items.length,
    invalid_rows: batch.invalid_rows,
    imported_rows: importedRows,
    skipped_rows: skippedRows,
    status: "COMPLETED",
    created_at: now,
  }
  batches.unshift(batchRecord)
  localStorage.setItem(batchKey, JSON.stringify(batches))

  return {
    batch_id: batchId,
    file_name: batch.file_name,
    total_rows: batch.total_rows,
    valid_rows: batch.items.length,
    invalid_rows: batch.invalid_rows,
    imported_rows: importedRows,
    skipped_rows: skippedRows,
    status: "COMPLETED",
    created_at: now,
  }
}

export async function rollbackClinicalLibraryBatch(
  clinicId: string,
  batchId: string,
): Promise<number> {
  if (isTauriDesktop()) {
    const res = await invokeTauri<number>("rollback_clinical_library_batch", {
      clinicId,
      batchId,
    })
    if (res !== null && res !== undefined) return res
  }

  const storageKey = `cliniqo_clinical_library_${clinicId}`
  const batchKey = `cliniqo_clinical_batches_${clinicId}`

  const existingRaw = localStorage.getItem(storageKey)
  let count = 0
  if (existingRaw) {
    const items: ClinicalMedicineRecord[] = JSON.parse(existingRaw)
    for (const item of items) {
      if (item.batch_id === batchId && item.is_active) {
        item.is_active = false
        count++
      }
    }
    localStorage.setItem(storageKey, JSON.stringify(items))
  }

  const batchesRaw = localStorage.getItem(batchKey)
  if (batchesRaw) {
    const batches: ClinicalImportBatchRecord[] = JSON.parse(batchesRaw)
    const b = batches.find((x) => x.id === batchId)
    if (b) {
      b.status = "ROLLED_BACK"
      b.rolled_back_at = new Date().toISOString()
      localStorage.setItem(batchKey, JSON.stringify(batches))
    }
  }

  return count
}

export async function getClinicalLibraryItems(
  clinicId: string,
  query?: string,
  limit = 50,
  offset = 0,
): Promise<ClinicalMedicineRecord[]> {
  if (isTauriDesktop()) {
    const res = await invokeTauri<ClinicalMedicineRecord[]>(
      "get_clinical_library_items",
      {
        clinicId,
        query: query || null,
        limit,
        offset,
      },
    )
    if (res) return res
  }

  const storageKey = `cliniqo_clinical_library_${clinicId}`
  const raw = localStorage.getItem(storageKey)
  if (!raw) return []
  let items: ClinicalMedicineRecord[] = JSON.parse(raw)
  items = items.filter((i) => i.is_active)
  if (query && query.trim()) {
    const q = query.toLowerCase().trim()
    items = items.filter(
      (i) =>
        i.name.toLowerCase().includes(q) ||
        (i.generic_name && i.generic_name.toLowerCase().includes(q)) ||
        (i.brand_name && i.brand_name.toLowerCase().includes(q)) ||
        (i.composition && i.composition.toLowerCase().includes(q)),
    )
  }
  return items.slice(offset, offset + limit)
}

export async function getClinicalLibraryBatches(
  clinicId: string,
): Promise<ClinicalImportBatchRecord[]> {
  if (isTauriDesktop()) {
    const res = await invokeTauri<ClinicalImportBatchRecord[]>(
      "get_clinical_library_batches",
      {
        clinicId,
      },
    )
    if (res) return res
  }

  const batchKey = `cliniqo_clinical_batches_${clinicId}`
  const raw = localStorage.getItem(batchKey)
  if (!raw) return []
  return JSON.parse(raw)
}

export async function saveClinicalLibraryItem(
  item: SaveClinicalMedicineArgs,
): Promise<string> {
  if (isTauriDesktop()) {
    const res = await invokeTauri<string>("save_clinical_library_item", {
      clinicId: item.clinic_id,
      item,
    })
    if (res) return res
  }

  const storageKey = `cliniqo_clinical_library_${item.clinic_id}`
  const raw = localStorage.getItem(storageKey)
  const items: ClinicalMedicineRecord[] = raw ? JSON.parse(raw) : []
  const id = item.id || `med_${Date.now()}`
  const now = new Date().toISOString()

  const idx = items.findIndex((i) => i.id === id)
  const record: ClinicalMedicineRecord = {
    id,
    clinic_id: item.clinic_id,
    name: item.name,
    generic_name: item.generic_name,
    brand_name: item.brand_name,
    composition: item.composition,
    strength: item.strength,
    formulation: item.formulation,
    dosage_form: item.dosage_form,
    route: item.route,
    manufacturer: item.manufacturer,
    category: item.category,
    pack_size: item.pack_size,
    mrp: item.mrp,
    storage_instructions: item.storage_instructions,
    default_dosage: item.default_dosage,
    default_frequency: item.default_frequency,
    default_duration: item.default_duration,
    default_instructions: item.default_instructions,
    is_active: true,
    created_at: idx >= 0 ? items[idx].created_at : now,
    updated_at: now,
  }

  if (idx >= 0) {
    items[idx] = record
  } else {
    items.unshift(record)
  }
  localStorage.setItem(storageKey, JSON.stringify(items))
  return id
}

export async function archiveClinicalLibraryItem(
  clinicId: string,
  id: string,
): Promise<void> {
  if (isTauriDesktop()) {
    await invokeTauri<void>("archive_clinical_library_item", {
      clinicId,
      id,
    })
    return
  }

  const storageKey = `cliniqo_clinical_library_${clinicId}`
  const raw = localStorage.getItem(storageKey)
  if (!raw) return
  const items: ClinicalMedicineRecord[] = JSON.parse(raw)
  const item = items.find((i) => i.id === id)
  if (item) {
    item.is_active = false
    item.updated_at = new Date().toISOString()
    localStorage.setItem(storageKey, JSON.stringify(items))
  }
}

// ---------------------------------------------------------------------------
// Encrypted Backup & Restore Interfaces & Functions
// ---------------------------------------------------------------------------

export interface BackupManifest {
  magic: string
  version: number
  clinic_id: string
  created_at: string
  app_version: string
  schema_version: number
  patients_count: number
  consultations_count: number
  prescriptions_count: number
  invoices_count: number
  outbox_count: number
  db_sha256: string
}

export interface BackupExportResult {
  success: boolean
  backup_file_name: string
  backup_file_path: string | null
  backup_bytes_base64: string | null
  manifest: BackupManifest
  file_size_bytes: number
}

export interface BackupRestoreResult {
  success: boolean
  restored_at: string
  clinic_id: string
  manifest: BackupManifest
  patients_count: number
  consultations_count: number
  prescriptions_count: number
  invoices_count: number
}

export async function exportEncryptedBackup(
  clinicId: string,
  passphrase?: string,
  destinationPath?: string,
): Promise<BackupExportResult> {
  if (isTauriDesktop()) {
    const res = await invokeTauri<BackupExportResult>("export_encrypted_backup", {
      clinicId,
      passphrase: passphrase || null,
      destinationPath: destinationPath || null,
    })
    if (res) return res
    throw new Error("Encrypted backup export failed: desktop invocation returned no result")
  }

  // Browser / Demo fallback
  const mockManifest: BackupManifest = {
    magic: "CLINIQO_BACKUP",
    version: 1,
    clinic_id: clinicId,
    created_at: new Date().toISOString(),
    app_version: "1.0.3",
    schema_version: 12,
    patients_count: 5,
    consultations_count: 8,
    prescriptions_count: 8,
    invoices_count: 4,
    outbox_count: 0,
    db_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  }

  const dummyData = "CLINIQO_BACKUP_V1\0" + JSON.stringify(mockManifest)
  const base64Data = btoa(dummyData)

  return {
    success: true,
    backup_file_name: `cliniqo_backup_${clinicId}_${new Date().toISOString().replace(/[:.]/g, "-")}.clxbk`,
    backup_file_path: null,
    backup_bytes_base64: base64Data,
    manifest: mockManifest,
    file_size_bytes: dummyData.length,
  }
}

export async function restoreEncryptedBackup(options: {
  clinicId?: string
  backupBytesBase64?: string
  backupFilePath?: string
  passphrase?: string
}): Promise<BackupRestoreResult> {
  if (isTauriDesktop()) {
    const res = await invokeTauri<BackupRestoreResult>("restore_encrypted_backup", {
      clinicId: options.clinicId || null,
      backupBytesBase64: options.backupBytesBase64 || null,
      backupFilePath: options.backupFilePath || null,
      passphrase: options.passphrase || null,
    })
    if (res) return res
    throw new Error("Encrypted backup restore failed: desktop invocation returned no result")
  }

  // Browser / Demo validation
  if (!options.backupBytesBase64 && !options.backupFilePath) {
    throw new Error("No backup data or file provided")
  }

  return {
    success: true,
    restored_at: new Date().toISOString(),
    clinic_id: options.clinicId || "clinic_demo",
    manifest: {
      magic: "CLINIQO_BACKUP",
      version: 1,
      clinic_id: options.clinicId || "clinic_demo",
      created_at: new Date().toISOString(),
      app_version: "1.0.3",
      schema_version: 12,
      patients_count: 5,
      consultations_count: 8,
      prescriptions_count: 8,
      invoices_count: 4,
      outbox_count: 0,
      db_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    },
    patients_count: 5,
    consultations_count: 8,
    prescriptions_count: 8,
    invoices_count: 4,
  }
}

// ---------------------------------------------------------------------------
// Application Auto-Updater Interfaces & Functions
// ---------------------------------------------------------------------------

export interface UpdateCheckResult {
  available: boolean
  current_version: string
  target_version: string | null
  release_notes: string | null
  pub_date: string | null
  download_url: string | null
  signature: string | null
  endpoint: string
  checked_at: string
}

export interface UpdateInstallResult {
  success: boolean
  target_version: string
  installer_path: string
  status_message: string
}

export async function checkAppUpdate(endpoint?: string): Promise<UpdateCheckResult> {
  if (isTauriDesktop()) {
    const res = await invokeTauri<UpdateCheckResult>("check_app_update", {
      endpoint: endpoint || null,
    })
    if (res) return res
    throw new Error("App update check failed: desktop invocation returned no result")
  }

  return {
    available: false,
    current_version: "1.0.3",
    target_version: null,
    release_notes: null,
    pub_date: null,
    download_url: null,
    signature: null,
    endpoint: "https://github.com/dipeshpatekar/Cliniqo/releases/latest/download/latest.json",
    checked_at: new Date().toISOString(),
  }
}

export async function downloadAndLaunchUpdate(
  downloadUrl: string,
  targetVersion: string,
  signature?: string | null,
): Promise<UpdateInstallResult> {
  if (isTauriDesktop()) {
    const res = await invokeTauri<UpdateInstallResult>("download_and_launch_update", {
      downloadUrl,
      targetVersion,
      signature: signature ?? null,
    })
    if (res) return res
    throw new Error("Download and install failed: desktop invocation returned no result")
  }

  return {
    success: true,
    target_version: targetVersion,
    installer_path: "/tmp/Cliniqo-Setup.exe",
    status_message:
      "Demo mode: Update simulated. Existing local SQLite database and keys are preserved.",
  }
}
