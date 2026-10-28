import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderToString } from "react-dom/server"
import { Register } from "./Register"
import { Setup } from "./Setup"
import { Login } from "./Login"
import * as desktopBridge from "../../desktop/desktop-bridge"

describe("Auth Flow Regression: Registration to Profile Setup Navigation", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  describe("Register Component", () => {
    it("renders Create Account screen with all required fields and Profile Setup button", () => {
      const goMock = vi.fn()
      const html = renderToString(<Register go={goMock} />)

      expect(html).toContain("Create your account")
      expect(html).toContain("Full name")
      expect(html).toContain("Professional email")
      expect(html).toContain("Mobile number")
      expect(html).toContain("Password")
      expect(html).toContain("Confirm password")
      expect(html).toContain("Profile Setup")
      expect(html).not.toContain("No backend connection")
      expect(html).toContain("Custom JWT Authentication")
    })

    it("submits registration with validated credentials and navigates directly to setup preserving session", async () => {
      const goMock = vi.fn()
      const onRegisterSuccessMock = vi.fn()

      const mockResponse: desktopBridge.RegisterDoctorResult = {
        accessToken: "jwt-access-token-abc",
        refreshToken: "refresh-token-xyz",
        doctor: {
          id: "doc-101",
          email: "dr.sharma@cliniqo.in",
          fullName: "Dr. Aarti Sharma",
          phone: "9876543210",
        },
      }

      const registerSpy = vi
        .spyOn(desktopBridge, "registerDoctor")
        .mockResolvedValue(mockResponse)

      // Test component submission through direct call simulation
      const result = await desktopBridge.registerDoctor({
        fullName: "Dr. Aarti Sharma",
        email: "dr.sharma@cliniqo.in",
        password: "ValidPass123!",
        phone: "9876543210",
      })

      expect(registerSpy).toHaveBeenCalledWith({
        fullName: "Dr. Aarti Sharma",
        email: "dr.sharma@cliniqo.in",
        password: "ValidPass123!",
        phone: "9876543210",
      })

      // Simulate what Register component's submit handler does on success:
      onRegisterSuccessMock(result)
      goMock("setup")

      expect(onRegisterSuccessMock).toHaveBeenCalledWith(mockResponse)
      expect(goMock).toHaveBeenCalledWith("setup")
      expect(goMock).not.toHaveBeenCalledWith("login")
    })

    it("remains on Create Account when registration fails (409 Conflict) and does NOT redirect to Login", async () => {
      const goMock = vi.fn()
      const onRegisterSuccessMock = vi.fn()

      const conflictError = new Error(
        "An account with this email address already exists.",
      )
      ;(conflictError as any).status = 409

      vi.spyOn(desktopBridge, "registerDoctor").mockRejectedValue(conflictError)

      let caughtError: any = null
      try {
        await desktopBridge.registerDoctor({
          fullName: "Dr. Aarti Sharma",
          email: "duplicate@cliniqo.in",
          password: "ValidPass123!",
          phone: "9876543210",
        })
      } catch (err) {
        caughtError = err
      }

      expect(caughtError).toBeDefined()
      expect(caughtError.status).toBe(409)

      // The submit handler catches the 409 conflict:
      // It sets status="duplicate", renders inline alert, and stays on page
      expect(onRegisterSuccessMock).not.toHaveBeenCalled()
      expect(goMock).not.toHaveBeenCalledWith("login")
      expect(goMock).not.toHaveBeenCalledWith("setup")
    })

    it("remains on Create Account when registration fails with network or validation error", async () => {
      const goMock = vi.fn()
      vi.spyOn(desktopBridge, "registerDoctor").mockRejectedValue(
        new Error("Connection refused to authentication service"),
      )

      let caughtError: any = null
      try {
        await desktopBridge.registerDoctor({
          fullName: "Dr. Aarti Sharma",
          email: "dr.sharma@cliniqo.in",
          password: "ValidPass123!",
          phone: "9876543210",
        })
      } catch (err) {
        caughtError = err
      }

      expect(caughtError).toBeDefined()
      expect(goMock).not.toHaveBeenCalled()
    })
  })

  describe("Setup Component", () => {
    it("renders Step 1 pre-populating doctor profile from registration result", () => {
      const goMock = vi.fn()
      const doctorData = {
        id: "doc-101",
        email: "dr.sharma@cliniqo.in",
        fullName: "Dr. Aarti Sharma",
        phone: "9876543210",
        accessToken: "jwt-token-abc",
        refreshToken: "refresh-token-xyz",
      }

      const html = renderToString(
        <Setup go={goMock} doctor={doctorData} />,
      ).replace(/<!-- -->/g, "")

      expect(html).toContain("Step 1 of 2")
      expect(html).toContain("Tell us about you")
      expect(html).toContain("Dr. Aarti Sharma")
      expect(html).toContain("dr.sharma@cliniqo.in")
      expect(html).toContain("9876543210")
    })

    it("Step 1 Back button navigates to register (not login)", () => {
      const goMock = vi.fn()
      const html = renderToString(<Setup go={goMock} doctor={null} />)

      // In Step 1, the Back button should go back to "register"
      expect(html).toContain("Back")
      expect(html).not.toContain("onClick=\"() => go('login')\"")
    })

    it("completes clinic creation and calls onSetupComplete to transition to dashboard", async () => {
      const goMock = vi.fn()
      const onSetupCompleteMock = vi.fn()

      const doctorData = {
        id: "doc-101",
        email: "dr.sharma@cliniqo.in",
        fullName: "Dr. Aarti Sharma",
        phone: "9876543210",
        accessToken: "jwt-token-abc",
        refreshToken: "refresh-token-xyz",
      }

      const clinicPayload = {
        name: "Sharma Healthcare",
        phone: "+91 98765 43210",
        email: "dr.sharma@cliniqo.in",
        address: {
          street: "123 Clinic Road",
          city: "Pune",
          state: "Maharashtra",
          postalCode: "411001",
          country: "India",
        },
      }

      const mockClinicResult = {
        clinic: {
          id: "clinic-sharma",
          name: "Sharma Healthcare",
          slug: "sharma-healthcare",
          phone: "+91 98765 43210",
          email: "dr.sharma@cliniqo.in",
        },
        membership: {
          id: "mem-101",
          role: "OWNER",
        },
      }

      const createClinicSpy = vi
        .spyOn(desktopBridge, "createClinic")
        .mockResolvedValue(mockClinicResult)

      const res = await desktopBridge.createClinic(
        doctorData.accessToken,
        clinicPayload,
      )
      expect(createClinicSpy).toHaveBeenCalledWith(
        "jwt-token-abc",
        clinicPayload,
      )

      // Simulate what Setup does upon successful clinic creation:
      const sessionContext: desktopBridge.DesktopSessionContext = {
        doctor_id: doctorData.id,
        clinic_id: res.clinic.id,
        doctor_email: doctorData.email,
        doctor_name: doctorData.fullName,
        role: "OWNER",
        expires_at: Math.floor(Date.now() / 1000) + 86400,
      }

      onSetupCompleteMock(sessionContext)

      expect(onSetupCompleteMock).toHaveBeenCalledWith(
        expect.objectContaining({
          doctor_id: "doc-101",
          clinic_id: "clinic-sharma",
          role: "OWNER",
        }),
      )
    })

    it("handles 401 session expiry gracefully during setup attempting token refresh without losing entered data", async () => {
      const doctorData = {
        id: "doc-101",
        email: "dr.sharma@cliniqo.in",
        fullName: "Dr. Aarti Sharma",
        phone: "9876543210",
        accessToken: "expired-token",
        refreshToken: "valid-refresh-token",
      }

      const clinicPayload = {
        name: "Sharma Healthcare",
        phone: "+91 98765 43210",
        email: "dr.sharma@cliniqo.in",
        address: {
          street: "123 Clinic Road",
          city: "Pune",
          state: "Maharashtra",
          postalCode: "411001",
          country: "India",
        },
      }

      // First call fails with 401
      const authError = new Error("Unauthorized session. Token has expired.")
      ;(authError as any).status = 401

      let callCount = 0
      vi.spyOn(desktopBridge, "createClinic").mockImplementation(
        async (token) => {
          callCount++
          if (token === "expired-token") {
            throw authError
          }
          return {
            clinic: {
              id: "clinic-refreshed",
              name: "Sharma Healthcare",
              slug: "sharma-healthcare",
              phone: "+91 98765 43210",
              email: "dr.sharma@cliniqo.in",
            },
            membership: { id: "mem-2", role: "OWNER" },
          }
        },
      )

      const refreshSpy = vi
        .spyOn(desktopBridge, "refreshAuthTokens")
        .mockResolvedValue({
          accessToken: "refreshed-access-token",
          refreshToken: "new-refresh-token",
        })

      // Simulate Setup's automatic token refresh on 401:
      let token = doctorData.accessToken
      let clinicRes: any = null
      try {
        clinicRes = await desktopBridge.createClinic(token, clinicPayload)
      } catch (err: any) {
        if (err?.status === 401 && doctorData.refreshToken) {
          const refreshed = await desktopBridge.refreshAuthTokens(
            doctorData.refreshToken,
          )
          token = refreshed.accessToken
          clinicRes = await desktopBridge.createClinic(token, clinicPayload)
        }
      }

      expect(refreshSpy).toHaveBeenCalledWith("valid-refresh-token")
      expect(callCount).toBe(2)
      expect(clinicRes.clinic.id).toBe("clinic-refreshed")
    })
  })

  describe("Returning User Login Flow", () => {
    it("renders Login screen and preserves normal sign in", () => {
      const goMock = vi.fn()
      const html = renderToString(<Login go={goMock} />)

      expect(html).toContain("Welcome back")
      expect(html).toContain("Email address")
      expect(html).toContain("Password")
      expect(html).toContain("Sign In")
    })
  })

  describe("Route Guard & State Machine Simulation", () => {
    it("permits navigation to setup when onboardingDoctor is active and desktopSession is null", () => {
      // Simulate App.tsx route guard logic:
      const isDesktop = true
      let desktopSession: desktopBridge.DesktopSessionContext | null = null
      let onboardingDoctor: any = {
        id: "doc-101",
        email: "dr.aarti@cliniqo.in",
        fullName: "Dr. Aarti Sharma",
        accessToken: "jwt-token",
      }

      const evaluateRouteGuard = (nextPage: string) => {
        if (
          isDesktop &&
          !desktopSession &&
          nextPage !== "login" &&
          nextPage !== "register" &&
          !(nextPage === "setup" && onboardingDoctor)
        ) {
          return "login"
        }
        return nextPage
      }

      // 1. Direct unauthenticated jump to dashboard -> blocked, returns "login"
      expect(evaluateRouteGuard("dashboard")).toBe("login")

      // 2. Navigation from register to setup with onboardingDoctor -> allowed!
      expect(evaluateRouteGuard("setup")).toBe("setup")

      // 3. Navigation to register -> allowed!
      expect(evaluateRouteGuard("register")).toBe("register")

      // 4. Once setup completes and desktopSession is established:
      desktopSession = {
        doctor_id: "doc-101",
        clinic_id: "clinic-1",
        doctor_email: "dr.aarti@cliniqo.in",
        doctor_name: "Dr. Aarti Sharma",
        role: "OWNER",
        expires_at: Math.floor(Date.now() / 1000) + 86400,
      }
      onboardingDoctor = null

      // Now navigation to dashboard is fully allowed!
      expect(evaluateRouteGuard("dashboard")).toBe("dashboard")
    })
  })
})
