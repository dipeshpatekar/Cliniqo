import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  isTauriDesktop,
  getApiBaseUrl,
  getTrustedApiUrl,
  PRODUCTION_API_URL,
  DEFAULT_DEV_API_URL,
  getDesktopInfo,
  getLocalPatients,
  saveLocalPatient,
  deleteLocalPatient,
  getSyncOutboxSummary,
  loginDesktopSession,
  logoutDesktopSession,
  getDesktopSession,
  getSyncState,
  refreshDesktopSession,
  hasPersistedRefreshToken,
  loginDesktop,
  getSyncStatus,
  switchActiveClinic,
  getSyncConflicts,
  resolveSyncConflict,
  registerDoctor,
} from "./desktop-bridge"

describe("Desktop Bridge (Tauri 2 Frontend Integration)", () => {
  const win = typeof window !== "undefined" ? window as any : globalThis as any
  const originalTauri = win.__TAURI_INTERNALS__

  beforeEach(() => {
    delete win.__TAURI_INTERNALS__
    ;(globalThis as any).window = win
  })

  afterEach(() => {
    if (originalTauri !== undefined) {
      win.__TAURI_INTERNALS__ = originalTauri
    } else {
      delete win.__TAURI_INTERNALS__
    }
  })

  it("detects standard web browser mode when Tauri internals are absent", () => {
    expect(isTauriDesktop()).toBe(false)
  })

  it("detects desktop mode when __TAURI_INTERNALS__ is present on window", () => {
    win.__TAURI_INTERNALS__ = {}
    expect(isTauriDesktop()).toBe(true)
  })

  it("enforces explicit production and dev API constants without credentials", () => {
    expect(PRODUCTION_API_URL).toBe("https://cliniqo-backend-68x3.onrender.com")
    expect(DEFAULT_DEV_API_URL).toBe("http://localhost:3000")
    expect(PRODUCTION_API_URL).not.toContain("api.cliniqo.app")
    expect(PRODUCTION_API_URL).not.toContain("mongodb")
    expect(PRODUCTION_API_URL).not.toContain("password")
  })

  it("returns valid API base URL without exposing backend secrets or old api domain", () => {
    const url = getApiBaseUrl()
    expect(url).toBeDefined()
    expect(url).toMatch(/^https?:\/\//)
    expect(url).not.toContain("api.cliniqo.app")
    expect(url).not.toContain("mongodb")
    expect(url).not.toContain("password")
  })

  it("safely returns null/empty array in web browser mode without throwing errors", async () => {
    const info = await getDesktopInfo()
    expect(info).toBeNull()

    const session = await getDesktopSession()
    expect(session).toBeNull()

    const loginRes = await loginDesktopSession(
      "dummy_token",
      "clinic_1",
      "DOCTOR",
    )
    expect(loginRes).toBeNull()

    await expect(logoutDesktopSession()).resolves.toBeUndefined()

    const patients = await getLocalPatients("clinic_test_1")
    expect(patients).toEqual([])

    const patientId = await saveLocalPatient({
      clinic_id: "clinic_test_1",
      patient_code: "P-00101",
      name: "Rohan Sharma",
      phone: "9876543210",
      gender: "MALE",
      age: 40,
      allergies: [],
      conditions: [],
    })
    expect(patientId).toBeNull()

    const deleteRes = await deleteLocalPatient("clinic_test_1", "P-00101")
    expect(deleteRes).toBe(false)

    const summary = await getSyncOutboxSummary("clinic_test_1")
    expect(summary).toBeNull()

    const syncState = await getSyncState("clinic_test_1")
    expect(syncState).toBeNull()

    const valid64HexToken = "a".repeat(64)
    const loginWithRt = await loginDesktopSession(
      "token",
      "clinic_1",
      "DOCTOR",
      valid64HexToken,
    )
    expect(loginWithRt).toBeNull()
  })

  it("handles offline logout without error and does not require tokens from renderer", async () => {
    // Logout takes no token from renderer; native layer handles credential cleanup and server notification
    await expect(logoutDesktopSession()).resolves.toBeUndefined()
  })

  it("handles refresh session safely in browser mode without exposing or accepting tokens", async () => {
    const res = await refreshDesktopSession("clinic_1", "DOCTOR")
    expect(res).toBeNull()
  })

  it("queries persisted refresh token safely in web browser mode", async () => {
    const hasToken = await hasPersistedRefreshToken()
    expect(hasToken).toBe(false)
  })

  it("verifies DesktopSessionContext type boundary strictly forbids raw token exposure", async () => {
    const session: import("./desktop-bridge").DesktopSessionContext = {
      doctor_id: "doc_1",
      clinic_id: "clinic_1",
      doctor_email: "doc@test.com",
      doctor_name: "Dr. Safe",
      role: "DOCTOR",
      expires_at: 1893456000,
    }
    expect((session as any).refreshToken).toBeUndefined()
    expect((session as any).accessToken).toBeUndefined()
  })

  it("handles loginDesktop, getSyncStatus, and switchActiveClinic safely in browser mode", async () => {
    const loginRes = await loginDesktop("doc@test.com", "SecretPass123!")
    expect(loginRes).toBeNull()

    const syncStatus = await getSyncStatus()
    expect(syncStatus).toBeNull()

    const switchRes = await switchActiveClinic("clinic_2", "ADMIN")
    expect(switchRes).toBeNull()
  })

  it("verifies DesktopLoginResult type boundary strictly forbids raw token exposure", async () => {
    const loginResult: import("./desktop-bridge").DesktopLoginResult = {
      session: {
        doctor_id: "doc_1",
        clinic_id: "clinic_1",
        doctor_email: "doc@test.com",
        doctor_name: "Dr. Safe",
        role: "DOCTOR",
        expires_at: 1893456000,
      },
      clinics: [
        {
          id: "clinic_1",
          name: "Main Clinic",
          slug: "main-clinic",
          role: "DOCTOR",
          status: "ACTIVE",
        },
      ],
      active_clinic_id: "clinic_1",
    }
    expect((loginResult as any).refreshToken).toBeUndefined()
    expect((loginResult as any).accessToken).toBeUndefined()
    expect(loginResult.clinics[0].id).toBe("clinic_1")
    expect(loginResult.session.role).toBe("DOCTOR")
  })

  it("safely handles getSyncConflicts and resolveSyncConflict in web browser mode", async () => {
    const conflicts = await getSyncConflicts("clinic_test_1")
    expect(conflicts).toEqual([])

    const resolved = await resolveSyncConflict(
      "clinic_test_1",
      "conflict_1",
      "USE_SERVER",
    )
    expect(resolved).toBeNull()

    const resolvedManual = await resolveSyncConflict(
      "clinic_test_1",
      "conflict_2",
      "MERGE_MANUAL",
      JSON.stringify({ name: "Merged Patient" }),
    )
    expect(resolvedManual).toBeNull()

    const resolvedPreserve = await resolveSyncConflict(
      "clinic_test_1",
      "conflict_3",
      "PRESERVE_BOTH",
    )
    expect(resolvedPreserve).toBeNull()
  })

  it("verifies SyncConflictRecord type safety and forbidden token exposure", () => {
    const record: import("./desktop-bridge").SyncConflictRecord = {
      id: "cf_001",
      outbox_id: "ob_001",
      entity_type: "PATIENT",
      entity_id: "pt_001",
      server_version: 2,
      client_version: 1,
      server_payload: JSON.stringify({
        name: "Server Name",
        allergies: ["Penicillin"],
      }),
      client_payload: JSON.stringify({
        name: "Local Name",
        allergies: ["Aspirin"],
      }),
      conflict_reason: "DIVERGENT_CLINICAL_DATA",
      resolution_payload: null,
      status: "OPEN",
      resolved_at: null,
      resolution_strategy: null,
      created_at: "2026-10-28T00:00:00Z",
    }
    expect(record.entity_type).toBe("PATIENT")
    expect(record.status).toBe("OPEN")
    expect((record as any).accessToken).toBeUndefined()
    expect((record as any).refreshToken).toBeUndefined()
  })

  it("safely handles billing operations in browser mode without errors", async () => {
    const {
      saveLocalInvoice,
      getLocalInvoices,
      getLocalInvoiceById,
      finalizeLocalInvoice,
    } = await import("./desktop-bridge")

    const savedId = await saveLocalInvoice({
      clinic_id: "clinic_1",
      patient_id: "patient_1",
      invoice_number: "INV-2026-0001",
      subtotal_paise: 10000,
      discount_paise: 1000,
      tax_rate_percent: 5,
      tax_paise: 450,
      total_paise: 9450,
      items: [
        {
          name: "Consultation",
          quantity: 1,
          unit_price_paise: 10000,
          line_total_paise: 10000,
        },
      ],
    })
    expect(savedId).toBeNull()

    const invoices = await getLocalInvoices("clinic_1", "patient_1")
    expect(invoices).toEqual([])

    const invoice = await getLocalInvoiceById("clinic_1", "inv_1")
    expect(invoice).toBeNull()

    const finalized = await finalizeLocalInvoice("clinic_1", "inv_1")
    expect(finalized).toBeNull()
  })

  it("safely handles formulary operations in browser mode without errors", async () => {
    const {
      saveLocalFormularyItem,
      getLocalFormulary,
      deleteLocalFormularyItem,
    } = await import("./desktop-bridge")

    const savedId = await saveLocalFormularyItem({
      clinic_id: "clinic_1",
      name: "Paracetamol",
      formulation: "TABLET",
      strength: "500mg",
      default_dosage: "1 tablet",
      default_route: "Oral",
      default_frequency: "TDS",
      default_duration: "5 days",
    })
    expect(savedId).toBeNull()

    const formulary = await getLocalFormulary("clinic_1")
    expect(formulary).toEqual([])

    const deleted = await deleteLocalFormularyItem("clinic_1", "med_1")
    expect(deleted).toBe(false)
  })

  it("verifies LocalInvoiceRecord and LocalFormularyItemRecord type safety", () => {
    const invoice: import("./desktop-bridge").LocalInvoiceRecord = {
      id: "inv_1",
      server_id: null,
      clinic_id: "clinic_1",
      patient_id: "pat_1",
      consultation_id: "con_1",
      invoice_number: "INV-2026-0001",
      status: "DRAFT",
      payment_status: "UNPAID",
      subtotal_paise: 50000,
      discount_paise: 5000,
      tax_rate_percent: 18,
      tax_paise: 8100,
      total_paise: 53100,
      items: [
        {
          name: "Consultation Fee",
          quantity: 1,
          unit_price_paise: 50000,
          line_total_paise: 50000,
        },
      ],
      notes: "Routine checkup",
      payment_notes: null,
      sync_status: "PENDING",
      server_version: 0,
      local_version: 1,
      created_at: "2026-10-28T00:00:00Z",
      updated_at: "2026-10-28T00:00:00Z",
    }
    expect(invoice.total_paise).toBe(53100)
    expect(invoice.status).toBe("DRAFT")
    expect((invoice as any).accessToken).toBeUndefined()

    const formularyItem: import("./desktop-bridge").LocalFormularyItemRecord = {
      id: "med_1",
      server_id: null,
      clinic_id: "clinic_1",
      name: "Amoxicillin",
      formulation: "CAPSULE",
      strength: "500mg",
      active_ingredient: "Amoxicillin Trihydrate",
      default_dosage: "1 capsule",
      default_route: "Oral",
      default_frequency: "TDS",
      default_duration: "7 days",
      default_instructions: "Take after meals",
      is_active: true,
      sync_status: "PENDING",
      updated_at: "2026-10-28T00:00:00Z",
    }
    expect(formularyItem.formulation).toBe("CAPSULE")
    expect((formularyItem as any).accessToken).toBeUndefined()
  })

  describe("API Client functions (registerDoctor, createClinic, refreshAuthTokens)", () => {
    const originalFetch = globalThis.fetch

    afterEach(() => {
      globalThis.fetch = originalFetch
    })

    it("registerDoctor posts to /auth/register and returns tokens and doctor details", async () => {
      const mockResult = {
        accessToken: "access-token-123",
        refreshToken: "refresh-token-456",
        doctor: {
          id: "doc-1",
          email: "dr.new@clinic.com",
          fullName: "Dr. New Doctor",
          phone: "9876543210",
        },
      }

      globalThis.fetch = (vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResult,
      }) as any)

      const { registerDoctor } = await import("./desktop-bridge")
      const result = await registerDoctor({
        fullName: "Dr. New Doctor",
        email: "dr.new@clinic.com",
        password: "SecurePassword123!",
        phone: "9876543210",
      })

      expect(result).toEqual(mockResult)
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/auth/register"),
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fullName: "Dr. New Doctor",
            email: "dr.new@clinic.com",
            password: "SecurePassword123!",
            phone: "9876543210",
          }),
        }),
      )
    })

    it("registerDoctor throws Conflict error when status is 409", async () => {
      globalThis.fetch = (vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({
          message: "An account with this email address already exists.",
        }),
      }) as any)

      const { registerDoctor } = await import("./desktop-bridge")
      await expect(
        registerDoctor({
          fullName: "Dr. Exists",
          email: "existing@clinic.com",
          password: "SecurePassword123!",
        }),
      ).rejects.toThrow("An account with this email address already exists.")
    })

    it("createClinic posts to /clinics with Bearer token", async () => {
      const mockClinicRes = {
        clinic: {
          id: "clinic-1",
          name: "Apex Healthcare",
          slug: "apex-healthcare",
          phone: "+91 22 1234 5678",
          email: "care@apex.in",
        },
        membership: {
          id: "mem-1",
          role: "OWNER",
        },
      }

      globalThis.fetch = (vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockClinicRes,
      }) as any)

      const { createClinic } = await import("./desktop-bridge")
      const result = await createClinic("token-xyz", {
        name: "Apex Healthcare",
        phone: "+91 22 1234 5678",
        email: "care@apex.in",
        address: {
          street: "123 Main St",
          city: "Mumbai",
          state: "Maharashtra",
          postalCode: "400001",
          country: "India",
        },
      })

      expect(result).toEqual(mockClinicRes)
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/clinics"),
        expect.objectContaining({
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer token-xyz",
          },
        }),
      )
    })

    it("refreshAuthTokens posts to /auth/refresh and returns new tokens", async () => {
      const mockTokens = {
        accessToken: "new-access-token",
        refreshToken: "new-refresh-token",
      }

      globalThis.fetch = (vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockTokens,
      }) as any)

      const { refreshAuthTokens } = await import("./desktop-bridge")
      const result = await refreshAuthTokens("old-refresh-token")

      expect(result).toEqual(mockTokens)
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/auth/refresh"),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ refreshToken: "old-refresh-token" }),
        }),
      )
    })

    it("formats TypeError: Failed to fetch into actionable diagnostic message with target URL", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"))

      const { registerDoctor, getApiBaseUrl } = await import("./desktop-bridge")
      const targetUrl = getApiBaseUrl()

      let caughtError: any = null
      try {
        await registerDoctor({
          fullName: "Dr. Network Error",
          email: "network.error@clinic.com",
          password: "SecurePassword123!",
          phone: "9876543210",
        })
      } catch (err) {
        caughtError = err
      }

      expect(caughtError).toBeDefined()
      expect(caughtError.isNetworkError).toBe(true)
      expect(caughtError.message).toContain("Unable to connect to the Cliniqo authentication server at")
      expect(caughtError.message).toContain(targetUrl)
      expect(caughtError.message).not.toBe("Failed to fetch")
    })

    it("delegates registerDoctor to native register_desktop IPC when in Tauri desktop mode", async () => {
      win.__TAURI_INTERNALS__ = {}
      const mockDesktopDoctor = {
        accessToken: "desktop-access-token",
        refreshToken: "desktop-refresh-token",
        doctor: {
          id: "doc-desktop-1",
          email: "desktop@clinic.com",
          fullName: "Dr. Desktop",
          phone: "9876543210",
        },
      }

      // Mock @tauri-apps/api/core dynamically
      vi.doMock("@tauri-apps/api/core", () => ({
        invoke: vi.fn().mockImplementation((cmd: string, args: any) => {
          if (cmd === "register_desktop") {
            return Promise.resolve(mockDesktopDoctor)
          }
          if (cmd === "get_trusted_api_url") {
            return Promise.resolve("https://cliniqo-backend-68x3.onrender.com")
          }
          return Promise.resolve(null)
        }),
      }))

      const { registerDoctor, getTrustedApiUrl } = await import("./desktop-bridge")
      const desktopResult = await registerDoctor({
        fullName: "Dr. Desktop",
        email: "desktop@clinic.com",
        password: "SecurePassword123!",
        phone: "9876543210",
      })

      expect(desktopResult).toEqual(mockDesktopDoctor)

      const trustedUrl = await getTrustedApiUrl()
      expect(trustedUrl).toBe("https://cliniqo-backend-68x3.onrender.com")

      vi.doUnmock("@tauri-apps/api/core")
    })

    it("normalizes Tauri IPC string rejections into Error objects with isNetworkError flag", async () => {
      win.__TAURI_INTERNALS__ = {}
      const mockDnsError =
        "Authentication server unreachable (https://cliniqo-backend-68x3.onrender.com): dns error: failed to lookup address information: No such host is known."

      vi.doMock("@tauri-apps/api/core", () => ({
        invoke: vi.fn().mockImplementation((cmd: string) => {
          if (cmd === "register_desktop") {
            return Promise.reject(mockDnsError)
          }
          return Promise.resolve(null)
        }),
      }))

      const { registerDoctor } = await import("./desktop-bridge")
      let caught: any = null
      try {
        await registerDoctor({
          fullName: "Dr. DNS Error",
          email: "dns@clinic.com",
          password: "SecurePassword123!",
          phone: "9876543210",
        })
      } catch (err) {
        caught = err
      }

      expect(caught).toBeInstanceOf(Error)
      expect(caught.message).toBe(mockDnsError)
      expect(caught.isNetworkError).toBe(true)

      vi.doUnmock("@tauri-apps/api/core")
    })

    it("delegates createClinic to native create_clinic_desktop IPC when in Tauri desktop mode", async () => {
      win.__TAURI_INTERNALS__ = {}
      const mockClinicPayload = {
        name: "Metro Polyclinic",
        phone: "9876543210",
        email: "metro@clinic.com",
        address: {
          street: "123 Main St",
          city: "Pune",
          state: "Maharashtra",
          postalCode: "411001",
          country: "India",
        },
      }
      const mockResult = {
        clinic: {
          id: "clinic-native-1",
          name: "Metro Polyclinic",
          slug: "metro-polyclinic",
        },
        membership: {
          id: "mem-1",
          role: "OWNER",
        },
      }

      vi.doMock("@tauri-apps/api/core", () => ({
        invoke: vi.fn().mockImplementation((cmd: string, args: any) => {
          if (cmd === "create_clinic_desktop") {
            expect(args.input).toEqual(mockClinicPayload)
            return Promise.resolve(mockResult)
          }
          return Promise.resolve(null)
        }),
      }))

      const { createClinic } = await import("./desktop-bridge")
      const result = await createClinic("test-token", mockClinicPayload)
      expect(result).toEqual(mockResult)

      vi.doUnmock("@tauri-apps/api/core")
    })
  })
})
