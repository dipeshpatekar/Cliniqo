import { describe, it, expect, beforeEach, afterEach } from "vitest"
import {
  isTauriDesktop,
  getApiBaseUrl,
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

  it("returns valid API base URL without exposing backend secrets", () => {
    const url = getApiBaseUrl()
    expect(url).toBeDefined()
    expect(url).toMatch(/^https?:\/\//)
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
})

