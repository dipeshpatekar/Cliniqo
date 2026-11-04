/**
 * Cliniqo Desktop Bridge
 * Provides typed Tauri 2 IPC bindings when running inside the Tauri Windows desktop shell,
 * with graceful fallback for standard web browser environments and cryptographically verified sessions.
 */
import type { CatalogueItem, CatalogueSearchResult } from "../types"

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
 * Production and development backend API URLs.
 * In production desktop and web builds, never points at localhost.
 */
export const PRODUCTION_API_URL = "https://cliniqo-api.onrender.com"
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
          body: JSON.stringify({ email: input.email, password: input.password }),
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
  name: string
  quantity: number
  unit_price_paise: number
  line_total_paise: number
}

export interface SaveInvoiceArgs {
  id?: string | null
  clinic_id: string
  patient_id: string
  consultation_id?: string | null
  invoice_number: string
  subtotal_paise: number
  discount_paise: number
  tax_rate_percent: number
  tax_paise: number
  total_paise: number
  items: LocalInvoiceItem[]
  notes?: string | null
  payment_notes?: string | null
}

export interface LocalInvoiceRecord {
  id: string
  server_id: string | null
  clinic_id: string
  patient_id: string
  consultation_id: string | null
  invoice_number: string
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
  return invokeTauri<string>("save_local_invoice", { args })
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
    source_provenance: it.sourceProvenance || "CDCI_NRCES_INDIA",
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
    const localItems = await searchLocalCatalogueCache(
      query,
      limit,
      formulation,
    )
    return {
      items: localItems,
      total: localItems.length,
      page: 1,
      limit,
      totalPages: Math.ceil(localItems.length / limit) || 1,
      attribution: "CDCI / NRCeS India (CC BY 4.0) — Local Offline Cache",
      isOfflineCache: localItems.length > 0,
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
        if (data.items && data.items.length > 0 && isDesktop) {
          saveCatalogueCacheItems(data.items).catch(() => {})
        }
        return {
          ...data,
          isOfflineCache: false,
        }
      }
    } catch {
      // Network failure, fallback to offline SQLite cache
    }
  }

  const localItems = await searchLocalCatalogueCache(query, limit, formulation)
  return {
    items: localItems,
    total: localItems.length,
    page: 1,
    limit,
    totalPages: Math.ceil(localItems.length / limit) || 1,
    attribution: "CDCI / NRCeS India (CC BY 4.0) — Local Offline Cache",
    isOfflineCache: isDesktop && localItems.length > 0,
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
  if (isTauriDesktop()) {
    try {
      return await invokeTauri<ClinicProfile>("save_clinic_profile", { args })
    } catch (e) {
      console.warn("Failed to persist clinic profile to desktop SQLite:", e)
      return null
    }
  }

  const saved: ClinicProfile = {
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
  if (isTauriDesktop()) {
    try {
      return await invokeTauri<DoctorProfile>("save_doctor_profile", { args })
    } catch (e) {
      console.warn("Failed to persist doctor profile to desktop SQLite:", e)
      return null
    }
  }

  const saved: DoctorProfile = {
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
  return saved
}
