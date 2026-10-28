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

export const getBackendUrl = getApiBaseUrl

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
}

export interface CreateClinicResult {
  clinic: {
    _id?: string
    id?: string
    name: string
    slug: string
    phone: string
    email: string
  }
  membership: {
    _id?: string
    id?: string
    clinicId?: string
    doctorId?: string
    role: string
  }
}

export async function registerDoctor(
  input: RegisterDoctorInput,
): Promise<RegisterDoctorResult> {
  const url = `${getApiBaseUrl()}/auth/register`
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  })

  const data = await res.json().catch(() => ({}))

  if (!res.ok) {
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
  const url = `${getApiBaseUrl()}/clinics`
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  })

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
): Promise<{ accessToken: string refreshToken: string }> {
  const url = `${getApiBaseUrl()}/auth/refresh`
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ refreshToken }),
  })

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
): Promise<CatalogueItem[]> {
  const result = await invokeTauri<LocalCatalogueCacheRecord[]>(
    "search_catalogue_cache",
    { query, limit },
  )
  if (!result) return []
  return result.map((r) => {
    let parsedStrengths = []
    try {
      parsedStrengths = JSON.parse(r.strengths_json)
    } catch {
      // ignore
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
    active_ingredients_json: null,
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

export async function searchCatalogue(
  query: string,
  token?: string,
  limit = 20,
  formulation?: string,
): Promise<CatalogueSearchResult> {
  const backendUrl = getBackendUrl()
  if (token && typeof navigator !== "undefined" && navigator.onLine) {
    try {
      const url = new URL(`${backendUrl}/catalogue/search`)
      url.searchParams.set("q", query)
      url.searchParams.set("limit", String(limit))
      if (formulation) url.searchParams.set("formulation", formulation)

      const resp = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      })
      if (resp.ok) {
        const data = await resp.json()
        if (data.items && data.items.length > 0 && isTauriDesktop()) {
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

  const localItems = await searchLocalCatalogueCache(query, limit)
  return {
    items: localItems,
    total: localItems.length,
    page: 1,
    limit,
    totalPages: Math.ceil(localItems.length / limit) || 1,
    attribution: "CDCI / NRCeS India (CC BY 4.0) — Local Offline Cache",
    isOfflineCache: true,
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
  const backendUrl = getBackendUrl()
  if (token && typeof navigator !== "undefined" && navigator.onLine) {
    try {
      const url = new URL(`${backendUrl}/catalogue/strengths`)
      url.searchParams.set("name", medicineName)
      if (formulation) url.searchParams.set("formulation", formulation)

      const resp = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${token}`,
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
    isOfflineCache: true,
  }
}
