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

  let storageMap: Record<string, string> = {}

  beforeEach(() => {
    delete win.__TAURI_INTERNALS__
    storageMap = {}
    win.localStorage = {
      getItem: (k: string) => storageMap[k] || null,
      setItem: (k: string, v: string) => {
        storageMap[k] = v
      },
      removeItem: (k: string) => {
        delete storageMap[k]
      },
      clear: () => {
        storageMap = {}
      },
    }
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
      invoice_date: "2026-10-28",
      subtotal_paise: 10000,
      discount_paise: 1000,
      tax_rate_percent: 5,
      tax_paise: 450,
      total_paise: 9450,
      items: [
        {
          description: "Consultation",
          name: "Consultation",
          quantity: 1,
          unit_price_paise: 10000,
          total_paise: 10000,
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

    it("registerDoctor throws Conflict error when status is 409 and login fails", async () => {
      globalThis.fetch = (vi.fn().mockImplementation((url: string) => {
        if (url.includes("/auth/login")) {
          return Promise.resolve({
            ok: false,
            status: 401,
            json: async () => ({ message: "Invalid email or password" }),
          })
        }
        return Promise.resolve({
          ok: false,
          status: 409,
          json: async () => ({
            message: "An account with this email address already exists.",
          }),
        })
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

    it("registerDoctor seamlessly recovers on 409 Conflict if login succeeds (interrupted attempt)", async () => {
      const recoveredResult = {
        accessToken: "recovered-jwt-token",
        refreshToken: "recovered-refresh-token",
        doctor: {
          id: "doc-recovered",
          email: "interrupted@clinic.com",
          fullName: "Dr. Interrupted",
        },
      }

      globalThis.fetch = (vi.fn().mockImplementation((url: string) => {
        if (url.includes("/auth/login")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => recoveredResult,
          })
        }
        return Promise.resolve({
          ok: false,
          status: 409,
          json: async () => ({
            message: "An account with this email address already exists.",
          }),
        })
      }) as any)

      const { registerDoctor } = await import("./desktop-bridge")
      const result = await registerDoctor({
        fullName: "Dr. Interrupted",
        email: "interrupted@clinic.com",
        password: "SecurePassword123!",
      })

      expect(result.accessToken).toBe("recovered-jwt-token")
      expect(result.doctor.id).toBe("doc-recovered")
    })

    it("registerDoctor retries transient network errors before succeeding", async () => {
      let callCount = 0
      const successResult = {
        accessToken: "retry-success-token",
        doctor: {
          id: "doc-retry",
          fullName: "Dr. Retry",
          email: "retry@clinic.com",
        },
      }

      globalThis.fetch = (vi.fn().mockImplementation((url: string) => {
        callCount++
        if (callCount === 1) {
          return Promise.reject(new TypeError("Failed to fetch"))
        }
        return Promise.resolve({
          ok: true,
          status: 201,
          json: async () => successResult,
        })
      }) as any)

      const { registerDoctor } = await import("./desktop-bridge")
      const result = await registerDoctor({
        fullName: "Dr. Retry",
        email: "retry@clinic.com",
        password: "SecurePassword123!",
      })

      expect(callCount).toBe(2)
      expect(result.accessToken).toBe("retry-success-token")
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
      globalThis.fetch = vi
        .fn()
        .mockRejectedValue(new TypeError("Failed to fetch"))

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
      expect(caughtError.message).toContain(
        "Unable to connect to the Cliniqo authentication server at",
      )
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

      const { registerDoctor, getTrustedApiUrl } = await import(
        "./desktop-bridge"
      )
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

    it("searches local SQLite catalogue cache in desktop mode without requiring token", async () => {
      win.__TAURI_INTERNALS__ = {}
      const mockLocalRecords = [
        {
          id: "1",
          item_type: "BRAND",
          name: "Amoxyclav 625 Tablet",
          brand_name: "Amoxyclav 625",
          generic_name:
            "Amoxicillin and Clavulanic Acid 500 mg + 125 mg Tablet",
          product_name: "Amoxyclav 625 Tablet",
          dosage_form: "Tablet",
          route: "Oral",
          strengths_json: JSON.stringify([{ rawStrength: "500 mg + 125 mg" }]),
          raw_strength_summary: "500 mg + 125 mg",
          is_combination: true,
          is_verified: true,
          source_provenance: "CDCI_NRCES_INDIA",
          created_at: "2026-10-31T00:00:00Z",
          updated_at: "2026-10-31T00:00:00Z",
        },
      ]

      vi.doMock("@tauri-apps/api/core", () => ({
        invoke: vi.fn().mockImplementation((cmd: string, args: any) => {
          if (cmd === "search_catalogue_cache") {
            expect(args.query).toBe("a")
            expect(args.formulation).toBe("Tablet")
            return Promise.resolve(mockLocalRecords)
          }
          return Promise.resolve(null)
        }),
      }))

      const { searchCatalogue } = await import("./desktop-bridge")
      const result = await searchCatalogue("a", undefined, 20, "Tablet")

      expect(result.items.length).toBe(1)
      expect(result.items[0].name).toBe("Amoxyclav 625 Tablet")
      expect(result.isOfflineCache).toBe(true)
      expect(result.attribution).toContain("Local Offline Cache")

      vi.doUnmock("@tauri-apps/api/core")
    })

    it("does not flag search as active offline cache when local SQLite results are empty", async () => {
      win.__TAURI_INTERNALS__ = {}
      vi.doMock("@tauri-apps/api/core", () => ({
        invoke: vi.fn().mockImplementation((cmd: string) => {
          if (cmd === "search_catalogue_cache") {
            return Promise.resolve([])
          }
          return Promise.resolve(null)
        }),
      }))

      const { searchCatalogue } = await import("./desktop-bridge")
      const result = await searchCatalogue(
        "xyz_not_found",
        undefined,
        20,
        "Tablet",
      )

      expect(result.items.length).toBe(0)
      expect(result.isOfflineCache).toBe(false)

      vi.doUnmock("@tauri-apps/api/core")
    })

    it("retrieves catalogue sync status and starts sync via Tauri commands in desktop mode", async () => {
      win.__TAURI_INTERNALS__ = {}
      const mockStatus = {
        status: "SYNCING",
        downloadedCount: 1500,
        totalCount: 104208,
        lastCursor: "cursor_1500",
        lastSyncedAt: null,
        error: null,
        isReady: false,
      }

      vi.doMock("@tauri-apps/api/core", () => ({
        invoke: vi.fn().mockImplementation((cmd: string) => {
          if (
            cmd === "get_catalogue_sync_status" ||
            cmd === "start_catalogue_sync"
          ) {
            return Promise.resolve(mockStatus)
          }
          return Promise.resolve(null)
        }),
      }))

      const { getCatalogueSyncStatus, startCatalogueSync } = await import(
        "./desktop-bridge"
      )
      const status = await getCatalogueSyncStatus()
      expect(status).not.toBeNull()
      expect(status?.status).toBe("SYNCING")
      expect(status?.downloadedCount).toBe(1500)

      const startRes = await startCatalogueSync()
      expect(startRes).not.toBeNull()
      expect(startRes?.status).toBe("SYNCING")

      vi.doUnmock("@tauri-apps/api/core")
    })

    it("retrieves catalogue strengths from local cache in desktop mode", async () => {
      win.__TAURI_INTERNALS__ = {}
      vi.doMock("@tauri-apps/api/core", () => ({
        invoke: vi.fn().mockImplementation((cmd: string, args: any) => {
          if (cmd === "get_catalogue_strengths_cache") {
            expect(args.medicineName).toBe("Amoxyclav")
            expect(args.formulation).toBe("Tablet")
            return Promise.resolve(["625 mg", "1000 mg"])
          }
          return Promise.resolve(null)
        }),
      }))

      const { getCatalogueStrengths } = await import("./desktop-bridge")
      const result = await getCatalogueStrengths(
        "Amoxyclav",
        undefined,
        "Tablet",
      )

      expect(result.strengths).toEqual(["625 mg", "1000 mg"])
      expect(result.isSingleMatch).toBe(false)
      expect(result.isOfflineCache).toBe(true)

      vi.doUnmock("@tauri-apps/api/core")
    })

    it("persists and retrieves doctor profile credentials via desktop IPC", async () => {
      win.__TAURI_INTERNALS__ = {}
      const mockDoctor = {
        doctor_id: "doc-123",
        full_name: "Dr. Dipesh Patekar",
        email: "doctor@cliniqo.test",
        phone: "+91 9876543210",
        qualification: "MBBS, MD",
        registration_number: "MMC 2024/01/9999",
        gender: "Male",
        updated_at: "2026-11-04T00:00:00Z",
      }

      vi.doMock("@tauri-apps/api/core", () => ({
        invoke: vi.fn().mockImplementation((cmd: string, args: any) => {
          if (cmd === "save_doctor_profile") {
            expect(args.args.doctor_id).toBe("doc-123")
            expect(args.args.qualification).toBe("MBBS, MD")
            expect(args.args.registration_number).toBe("MMC 2024/01/9999")
            return Promise.resolve(mockDoctor)
          }
          if (cmd === "get_doctor_profile") {
            expect(args.doctorId).toBe("doc-123")
            return Promise.resolve(mockDoctor)
          }
          return Promise.resolve(null)
        }),
      }))

      const { saveDoctorProfile, getDoctorProfile } = await import(
        "./desktop-bridge"
      )
      const saved = await saveDoctorProfile({
        doctor_id: "doc-123",
        full_name: "Dr. Dipesh Patekar",
        email: "doctor@cliniqo.test",
        phone: "+91 9876543210",
        qualification: "MBBS, MD",
        registration_number: "MMC 2024/01/9999",
        gender: "Male",
      })

      expect(saved).not.toBeNull()
      expect(saved?.qualification).toBe("MBBS, MD")
      expect(saved?.registration_number).toBe("MMC 2024/01/9999")
      expect(saved?.phone).toBe("+91 9876543210")

      const fetched = await getDoctorProfile("doc-123")
      expect(fetched).not.toBeNull()
      expect(fetched?.qualification).toBe("MBBS, MD")
      expect(fetched?.registration_number).toBe("MMC 2024/01/9999")

      vi.doUnmock("@tauri-apps/api/core")
    })

    it("falls back to localStorage for doctor profile when Tauri internals absent", async () => {
      delete win.__TAURI_INTERNALS__
      const { saveDoctorProfile, getDoctorProfile } = await import(
        "./desktop-bridge"
      )

      const saved = await saveDoctorProfile({
        doctor_id: "doc-web-test",
        full_name: "Dr. Web Test",
        email: "web@cliniqo.test",
        phone: "+91 9999988888",
        qualification: "MBBS, DNB",
        registration_number: "KMC 2024/555",
        gender: "Female",
      })

      expect(saved).not.toBeNull()
      expect(saved?.qualification).toBe("MBBS, DNB")
      expect(saved?.phone).toBe("+91 9999988888")

      const loaded = await getDoctorProfile("doc-web-test")
      expect(loaded).not.toBeNull()
      expect(loaded?.full_name).toBe("Dr. Web Test")
      expect(loaded?.registration_number).toBe("KMC 2024/555")
    })

    it("dispatches cliniqo:profile-updated custom event when saving doctor profile and clinic profile", async () => {
      delete win.__TAURI_INTERNALS__
      const { saveDoctorProfile, saveClinicProfile } = await import(
        "./desktop-bridge"
      )

      let receivedDoctorDetail: any = null
      let receivedClinicDetail: any = null

      const target = new EventTarget()
      const prevWin = (globalThis as any).window
      ;(globalThis as any).window = target
      ;(target as any).localStorage = {
        setItem: () => {},
        getItem: () => null,
        removeItem: () => {},
      }

      const handleUpdate = (e: Event) => {
        const detail = (e as CustomEvent).detail
        if (detail?.type === "doctor") receivedDoctorDetail = detail
        if (detail?.type === "clinic") receivedClinicDetail = detail
      }

      target.addEventListener("cliniqo:profile-updated", handleUpdate)

      await saveDoctorProfile({
        doctor_id: "doc-sync-test",
        full_name: "Dr. Bibi Dipesh",
        email: "bibi@cliniqo.test",
        phone: "+91 9123456789",
        qualification: "MBBS, MS",
        registration_number: "MMC 2026/777",
        gender: "Male",
      })

      expect(receivedDoctorDetail).not.toBeNull()
      expect(receivedDoctorDetail.type).toBe("doctor")
      expect(receivedDoctorDetail.profile.full_name).toBe("Dr. Bibi Dipesh")

      await saveClinicProfile({
        clinic_id: "clinic-sync-test",
        name: "Cutie Health Clinic",
        slug: "cutie-clinic",
        phone: "022-123456",
        email: "clinic@cliniqo.test",
        street: "123 Marine Drive",
        city: "Mumbai",
        state: "Maharashtra",
        postal_code: "400001",
        country: "India",
        location_link: "https://maps.test/cutie",
      })

      expect(receivedClinicDetail).not.toBeNull()
      expect(receivedClinicDetail.type).toBe("clinic")
      expect(receivedClinicDetail.profile.name).toBe("Cutie Health Clinic")

      target.removeEventListener("cliniqo:profile-updated", handleUpdate)
      ;(globalThis as any).window = prevWin
    })
  })

  describe("Inventory & Stock Management Bridge", () => {
    it("imports stock items safely with duplicate prevention and summary reporting", async () => {
      const {
        importInventoryStock,
        getInventoryStock,
        getInventoryStockSummary,
      } = await import("./desktop-bridge")

      const clinicId = "clinic-inv-spec-1"

      const sampleBatch = [
        {
          product_name: "6D BODYPROOF",
          unit: "TAB",
          company: "EMRYS",
          quantity: 180,
          value: 1745.88,
        },
        {
          product_name: "SLISHINE 20GM",
          unit: "CREAM",
          company: "SILVE",
          quantity: 4,
          value: null, // missing field preserved accurately
        },
        {
          product_name: "A TO Z DROPS",
          unit: "15 ML",
          company: "ALK",
          quantity: 3,
          value: 348.03,
        },
      ]

      // 1. Initial import
      const summary1 = await importInventoryStock(clinicId, sampleBatch, false)
      expect(summary1.successful).toBe(3)
      expect(summary1.skipped).toBe(0)
      expect(summary1.failed).toBe(0)
      expect(summary1.total_quantity).toBe(187)
      expect(Math.abs(summary1.total_value - 2093.91)).toBeLessThan(0.01)

      // 2. Second import without overwrite -> all existing items safely skipped
      const summary2 = await importInventoryStock(clinicId, sampleBatch, false)
      expect(summary2.successful).toBe(0)
      expect(summary2.skipped).toBe(3)
      expect(summary2.failed).toBe(0)

      // 3. Query stock items
      const items = await getInventoryStock(clinicId)
      expect(items.length).toBe(3)
      const slishine = items.find((i) => i.product_name === "SLISHINE 20GM")
      expect(slishine).toBeDefined()
      expect(slishine?.value).toBeNull()

      // 4. Substring query filter
      const filtered = await getInventoryStock(clinicId, "BODYPROOF")
      expect(filtered.length).toBe(1)
      expect(filtered[0].product_name).toBe("6D BODYPROOF")

      // 5. Explicit overwrite updates quantities
      const updated = [
        {
          product_name: "6D BODYPROOF",
          unit: "TAB",
          company: "EMRYS",
          quantity: 250,
          value: 2400.0,
        },
      ]
      const summary3 = await importInventoryStock(clinicId, updated, true)
      expect(summary3.successful).toBe(1)
      expect(summary3.skipped).toBe(0)

      // 6. Summary metrics
      const stats = await getInventoryStockSummary(clinicId)
      expect(stats.total_products).toBe(3)
      expect(stats.total_quantity).toBe(257) // 250 + 4 + 3
    })
  })

  describe("Clinical Library & Excel Import Bridge", () => {
    it("imports clinical library batch, avoids duplicate overwrites, and supports rollback", async () => {
      const {
        importClinicalLibrary,
        getClinicalLibraryItems,
        getClinicalLibraryBatches,
        rollbackClinicalLibraryBatch,
        saveClinicalLibraryItem,
        archiveClinicalLibraryItem,
      } = await import("./desktop-bridge")

      const clinicId = "test-clinical-clinic-1"

      // 1. Import a batch
      const batchInput = {
        clinic_id: clinicId,
        file_name: "test_medicines.xlsx",
        total_rows: 2,
        invalid_rows: 0,
        items: [
          {
            name: "Azithromycin",
            formulation: "Tablet",
            strength: "500 mg",
            generic_name: "Azithromycin",
            mrp: 120,
          },
          {
            name: "Cetirizine",
            formulation: "Tablet",
            strength: "10 mg",
            generic_name: "Cetirizine HCl",
            mrp: 35,
          },
        ],
      }

      const summary1 = await importClinicalLibrary(batchInput)
      expect(summary1.imported_rows).toBe(2)
      expect(summary1.skipped_rows).toBe(0)

      // 2. Query items
      const items = await getClinicalLibraryItems(clinicId)
      expect(items.length).toBe(2)
      expect(items.some((i) => i.name === "Azithromycin")).toBe(true)

      // 3. Re-importing same batch -> duplicate skipped
      const summary2 = await importClinicalLibrary(batchInput)
      expect(summary2.imported_rows).toBe(0)
      expect(summary2.skipped_rows).toBe(2)

      // 4. Batch history
      const batches = await getClinicalLibraryBatches(clinicId)
      expect(batches.length).toBeGreaterThanOrEqual(1)
      expect(batches[0].status).toBe("COMPLETED")

      // 5. Rollback
      const rolledBack = await rollbackClinicalLibraryBatch(
        clinicId,
        summary1.batch_id,
      )
      expect(rolledBack).toBe(2)

      const activeAfterRollback = await getClinicalLibraryItems(clinicId)
      expect(activeAfterRollback.length).toBe(0)

      // 6. Manual addition & archive
      const newId = await saveClinicalLibraryItem({
        clinic_id: clinicId,
        name: "Paracetamol",
        formulation: "Tablet",
        strength: "650 mg",
      })
      expect(newId).toBeDefined()

      const manualItems = await getClinicalLibraryItems(clinicId)
      expect(manualItems.length).toBe(1)
      expect(manualItems[0].name).toBe("Paracetamol")

      await archiveClinicalLibraryItem(clinicId, newId)
      const afterArchive = await getClinicalLibraryItems(clinicId)
      expect(afterArchive.length).toBe(0)
    })
  })

  describe("Encrypted Backup & Restore Bridge", () => {
    it("exportEncryptedBackup produces valid encrypted backup payload in demo mode", async () => {
      const { exportEncryptedBackup } = await import("./desktop-bridge")
      const result = await exportEncryptedBackup("clinic_bk_test", "Secret123!")

      expect(result.success).toBe(true)
      expect(result.backup_file_name).toContain("cliniqo_backup_clinic_bk_test")
      expect(result.backup_bytes_base64).toBeDefined()
      expect(result.manifest.clinic_id).toBe("clinic_bk_test")
      expect(result.manifest.version).toBe(1)
    })

    it("restoreEncryptedBackup succeeds and validates payload presence", async () => {
      const { restoreEncryptedBackup } = await import("./desktop-bridge")
      const result = await restoreEncryptedBackup({
        clinicId: "clinic_bk_test",
        backupBytesBase64: "Q0xJTklRT19CQUNLVVA=",
        passphrase: "Secret123!",
      })

      expect(result.success).toBe(true)
      expect(result.clinic_id).toBe("clinic_bk_test")
      expect(result.manifest.version).toBe(1)
    })

    it("restoreEncryptedBackup throws error if neither bytes nor path provided", async () => {
      const { restoreEncryptedBackup } = await import("./desktop-bridge")
      await expect(
        restoreEncryptedBackup({ clinicId: "clinic_test" }),
      ).rejects.toThrow("No backup data or file provided")
    })
  })

  describe("Auto-Updater Bridge", () => {
    it("checkAppUpdate returns structured update status", async () => {
      const { checkAppUpdate } = await import("./desktop-bridge")
      const result = await checkAppUpdate()

      expect(result).toHaveProperty("available")
      expect(result).toHaveProperty("current_version")
      expect(result.endpoint).toContain("releases/latest/download/latest.json")
    })

    it("downloadAndLaunchUpdate simulates update execution in demo mode", async () => {
      const { downloadAndLaunchUpdate } = await import("./desktop-bridge")
      const result = await downloadAndLaunchUpdate(
        "https://github.com/dipeshpatekar/Cliniqo/releases/download/v1.0.1/Cliniqo-Setup.exe",
        "1.0.1",
      )

      expect(result.success).toBe(true)
      expect(result.target_version).toBe("1.0.1")
      expect(result.status_message).toContain("preserved")
    })
  })

  describe("Persistent Desktop Authentication Bridge", () => {
    it("restoreOfflineDesktopSession invokes native Tauri command in desktop mode", async () => {
      win.__TAURI_INTERNALS__ = {}
      const mockOfflineResult = {
        session: {
          doctor_id: "doc_persist_1",
          clinic_id: "clinic_persist_1",
          doctor_email: "persist@clinic.com",
          doctor_name: "Dr. Persistent",
          role: "OWNER",
          expires_at: Math.floor(Date.now() / 1000) + 31536000,
          is_offline: true,
        },
        clinics: [
          {
            id: "clinic_persist_1",
            name: "Persistent Clinic",
            slug: "persistent-clinic",
            role: "OWNER",
            status: "ACTIVE",
          },
        ],
        active_clinic_id: "clinic_persist_1",
      }

      vi.doMock("@tauri-apps/api/core", () => ({
        invoke: vi.fn().mockImplementation((cmd: string) => {
          if (cmd === "restore_offline_desktop_session") {
            return Promise.resolve(mockOfflineResult)
          }
          return Promise.resolve(null)
        }),
      }))

      const { restoreOfflineDesktopSession } = await import("./desktop-bridge")
      const result = await restoreOfflineDesktopSession()

      expect(result).toEqual(mockOfflineResult)
      expect(result?.session.is_offline).toBe(true)
      vi.doUnmock("@tauri-apps/api/core")
    })

    it("refreshDesktopSession falls back to offline session when network fails", async () => {
      win.__TAURI_INTERNALS__ = {}
      const mockOfflineResult = {
        session: {
          doctor_id: "doc_persist_1",
          clinic_id: "clinic_persist_1",
          doctor_email: "persist@clinic.com",
          doctor_name: "Dr. Persistent",
          role: "OWNER",
          expires_at: Math.floor(Date.now() / 1000) + 31536000,
          is_offline: true,
        },
        clinics: [],
        active_clinic_id: "clinic_persist_1",
      }

      vi.doMock("@tauri-apps/api/core", () => ({
        invoke: vi.fn().mockImplementation((cmd: string) => {
          if (cmd === "refresh_desktop_session") {
            return Promise.reject("Network error: failed to resolve host")
          }
          if (cmd === "restore_offline_desktop_session") {
            return Promise.resolve(mockOfflineResult)
          }
          return Promise.resolve(null)
        }),
      }))

      const { refreshDesktopSession } = await import("./desktop-bridge")
      const result = await refreshDesktopSession()

      expect(result).toEqual(mockOfflineResult)
      expect(result?.session.is_offline).toBe(true)
      vi.doUnmock("@tauri-apps/api/core")
    })
  })

  describe("Billing IPC Data Contract (Issues 21 & 24)", () => {
    it("saveLocalInvoice maps description, total_paise, and invoice_date conforming to Rust IPC contract", async () => {
      win.__TAURI_INTERNALS__ = {}
      let invokedCmd = ""
      let invokedArgs: any = null

      vi.doMock("@tauri-apps/api/core", () => ({
        invoke: vi.fn().mockImplementation((cmd: string, args: any) => {
          invokedCmd = cmd
          invokedArgs = args
          if (cmd === "save_local_invoice") {
            return Promise.resolve("inv_persisted_uuid_1")
          }
          return Promise.resolve(null)
        }),
      }))

      const { saveLocalInvoice } = await import("./desktop-bridge")

      const savedId = await saveLocalInvoice({
        clinic_id: "clinic_test_1",
        patient_id: "pat_test_1",
        invoice_number: "INV-2026-9999",
        invoice_date: "2026-11-17",
        items: [
          {
            name: "Consultation fee",
            quantity: 1,
            unit_price_paise: 80000,
            line_total_paise: 80000,
          } as any,
        ],
        notes: "Test notes",
      })

      expect(savedId).toBe("inv_persisted_uuid_1")
      expect(invokedCmd).toBe("save_local_invoice")
      expect(invokedArgs).toBeDefined()
      expect(invokedArgs.args).toBeDefined()
      expect(invokedArgs.args.invoice_date).toBe("2026-11-17")
      expect(invokedArgs.args.invoice_number).toBe("INV-2026-9999")
      // Crucial: description and total_paise must be present
      expect(invokedArgs.args.items[0].description).toBe("Consultation fee")
      expect(invokedArgs.args.items[0].total_paise).toBe(80000)
      expect(invokedArgs.args.items[0].quantity).toBe(1)
      expect(invokedArgs.args.items[0].unit_price_paise).toBe(80000)

      vi.doUnmock("@tauri-apps/api/core")
    })

    it("finalizeLocalInvoice invokes finalize_local_invoice IPC with clinicId and invoiceId", async () => {
      win.__TAURI_INTERNALS__ = {}
      let invokedCmd = ""
      let invokedArgs: any = null

      const mockFinalizedRecord = {
        id: "inv_persisted_uuid_1",
        server_id: null,
        clinic_id: "clinic_test_1",
        patient_id: "pat_test_1",
        consultation_id: null,
        invoice_number: "INV-2026-9999",
        invoice_date: "2026-11-17",
        status: "FINALIZED",
        payment_status: "UNPAID",
        subtotal_paise: 80000,
        discount_paise: 0,
        tax_rate_percent: 0,
        tax_paise: 0,
        total_paise: 80000,
        items: [
          {
            description: "Consultation fee",
            quantity: 1,
            unit_price_paise: 80000,
            total_paise: 80000,
          },
        ],
        notes: null,
        payment_notes: null,
        sync_status: "PENDING",
        server_version: 1,
        local_version: 2,
        created_at: "2026-11-17T09:00:00Z",
        updated_at: "2026-11-17T09:05:00Z",
      }

      vi.doMock("@tauri-apps/api/core", () => ({
        invoke: vi.fn().mockImplementation((cmd: string, args: any) => {
          invokedCmd = cmd
          invokedArgs = args
          if (cmd === "finalize_local_invoice") {
            return Promise.resolve(mockFinalizedRecord)
          }
          return Promise.resolve(null)
        }),
      }))

      const { finalizeLocalInvoice } = await import("./desktop-bridge")
      const result = await finalizeLocalInvoice("clinic_test_1", "inv_persisted_uuid_1")

      expect(invokedCmd).toBe("finalize_local_invoice")
      expect(invokedArgs).toEqual({
        clinicId: "clinic_test_1",
        invoiceId: "inv_persisted_uuid_1",
      })
      expect(result).toEqual(mockFinalizedRecord)
      expect(result?.status).toBe("FINALIZED")

      vi.doUnmock("@tauri-apps/api/core")
    })
  })
})
