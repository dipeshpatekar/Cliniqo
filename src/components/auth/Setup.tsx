import { useState, useEffect, type FormEvent } from "react"
import { Button, Field, Logo, SelectInput, TextInput } from "../common"
import type { Page } from "../../types"
import {
  isTauriDesktop,
  loginDesktop,
  loginDesktopSession,
  createClinic,
  refreshAuthTokens,
  type DesktopSessionContext,
  type CreateClinicInput,
  type CreateClinicResult,
} from "../../desktop/desktop-bridge"
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Building2,
  KeyRound,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  Upload,
  UserRound,
} from "lucide-react"

export interface SetupDoctorData {
  id?: string
  email?: string
  fullName?: string
  phone?: string
  accessToken?: string
  refreshToken?: string
}

export interface SetupProps {
  go: (page: Page) => void
  doctor?: SetupDoctorData | null
  onSetupComplete?: (session: DesktopSessionContext) => void
}

export function Setup({ go, doctor, onSetupComplete }: SetupProps) {
  const [step, setStep] = useState(1)
  const [error, setError] = useState(false)
  const [status, setStatus] = useState<"idle" | "saving" | "expired" | "error">(
    "idle",
  )
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [currentAccessToken, setCurrentAccessToken] = useState(
    doctor?.accessToken || "",
  )

  // Step 1: Doctor Profile State
  const [fullName, setFullName] = useState(doctor?.fullName || "")
  const [gender, setGender] = useState("Male")
  const [qualifications, setQualifications] = useState("")
  const [registrationNumber, setRegistrationNumber] = useState("")
  const [mobile, setMobile] = useState(doctor?.phone || "")
  const [email, setEmail] = useState(doctor?.email || "")

  // Step 2: Clinic Profile State
  const [clinicName, setClinicName] = useState("")
  const [clinicPhone, setClinicPhone] = useState(doctor?.phone || "")
  const [address, setAddress] = useState("")
  const [city, setCity] = useState("")
  const [state, setState] = useState("")
  const [postalCode, setPostalCode] = useState("")
  const [mapsLocation, setMapsLocation] = useState("")
  const [clinicEmail, setClinicEmail] = useState(doctor?.email || "")

  // Re-auth modal state for session expiry
  const [reauthPassword, setReauthPassword] = useState("")
  const [reauthLoading, setReauthLoading] = useState(false)
  const [reauthError, setReauthError] = useState<string | null>(null)

  useEffect(() => {
    if (doctor?.fullName && !fullName) setFullName(doctor.fullName)
    if (doctor?.email && !email) setEmail(doctor.email)
    if (doctor?.phone && !mobile) setMobile(doctor.phone)
    if (doctor?.accessToken && !currentAccessToken)
      setCurrentAccessToken(doctor.accessToken)
  }, [doctor])

  const next = async (event: FormEvent) => {
    event.preventDefault()
    const form = event.currentTarget as HTMLFormElement
    if (!form.checkValidity()) {
      setError(true)
      form.reportValidity()
      return
    }

    if (step < 2) {
      setStep(2)
      return
    }

    // Step 2 completion: Save clinic and complete onboarding
    await saveClinicSetup()
  }

  const saveClinicSetup = async (tokenOverride?: string) => {
    setStatus("saving")
    setErrorMessage(null)

    let token = tokenOverride || currentAccessToken || doctor?.accessToken || ""
    const clinicPayload: CreateClinicInput = {
      name: clinicName.trim(),
      phone: clinicPhone.trim(),
      email: clinicEmail.trim() || email.trim(),
      address: {
        street: address.trim(),
        city: city.trim(),
        state: state.trim() || "Maharashtra",
        postalCode: postalCode.trim(),
        country: "India",
      },
    }

    try {
      let clinicRes: CreateClinicResult | null = null

      if (token) {
        try {
          clinicRes = await createClinic(token, clinicPayload)
        } catch (err: any) {
          if (err?.status === 401 && doctor?.refreshToken) {
            try {
              const refreshed = await refreshAuthTokens(doctor.refreshToken)
              token = refreshed.accessToken
              setCurrentAccessToken(token)
              clinicRes = await createClinic(token, clinicPayload)
            } catch {
              setStatus("expired")
              setErrorMessage(
                "Your authentication session has expired. Re-authenticate below to save your clinic setup without losing your entered information.",
              )
              return
            }
          } else if (err?.status === 401) {
            setStatus("expired")
            setErrorMessage(
              "Your authentication session has expired. Re-authenticate below to save your clinic setup without losing your entered information.",
            )
            return
          } else {
            throw err
          }
        }
      }

      const clinicId =
        clinicRes?.clinic?._id || clinicRes?.clinic?.id || "clinic-1"
      const doctorId = doctor?.id || "doc-1"

      let session: DesktopSessionContext = {
        doctor_id: doctorId,
        clinic_id: clinicId,
        doctor_email: email || doctor?.email || "",
        doctor_name: fullName || doctor?.fullName || "Doctor",
        role: "OWNER",
        expires_at: Math.floor(Date.now() / 1000) + 3600 * 24,
      }

      if (isTauriDesktop() && token) {
        const tauriSession = await loginDesktopSession(
          token,
          clinicId,
          "OWNER",
          doctor?.refreshToken,
        )
        if (tauriSession) {
          session = tauriSession
        }
      }

      setStatus("idle")
      if (onSetupComplete) {
        onSetupComplete(session)
      } else {
        go("dashboard")
      }
    } catch (err: any) {
      setStatus("error")
      setErrorMessage(
        err?.message ||
          "Failed to save clinic details. Please verify your information and try again.",
      )
    }
  }

  const handleReauth = async (e: FormEvent) => {
    e.preventDefault()
    if (!reauthPassword) {
      setReauthError("Enter your password to continue")
      return
    }

    setReauthLoading(true)
    setReauthError(null)

    try {
      let newAccessToken = ""
      if (isTauriDesktop()) {
        const loginRes = await loginDesktop(email, reauthPassword)
        if (loginRes?.session) {
          setReauthLoading(false)
          setStatus("idle")
          if (onSetupComplete) {
            onSetupComplete(loginRes.session)
          } else {
            go("dashboard")
          }
          return
        }
      }

      // Web/API fallback login
      const res = await fetch("http://localhost:3000/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: reauthPassword }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data?.message || "Invalid password")
      }

      newAccessToken = data.accessToken
      setCurrentAccessToken(newAccessToken)
      setReauthLoading(false)
      setStatus("idle")

      // Retry saving clinic with fresh token
      await saveClinicSetup(newAccessToken)
    } catch (err: any) {
      setReauthLoading(false)
      setReauthError(
        err?.message || "Re-authentication failed. Please check your password.",
      )
    }
  }

  return (
    <main className="setup-page">
      <header className="setup-header">
        <Logo />
        <span>Step {step} of 2</span>
      </header>
      <div className="setup-wrap">
        <div className="setup-progress">
          <span className="complete" />
          <span className={step === 2 ? "complete" : ""} />
        </div>
        <div className="setup-title">
          <span className="eyebrow">Workspace setup</span>
          <h1>{step === 1 ? "Tell us about you" : "Set up your clinic"}</h1>
          <p>
            {step === 1
              ? "These details will appear on prescriptions and patient records."
              : "Add the information patients should see on your prescription."}
          </p>
        </div>

        {errorMessage && (
          <div
            className="auth-error"
            role="alert"
            style={{ marginBottom: "1.25rem" }}
          >
            <AlertCircle size={18} />
            <span>{errorMessage}</span>
          </div>
        )}

        {status === "expired" && (
          <div
            className="reauth-box"
            style={{
              padding: "1.25rem",
              background: "var(--color-bg-card, #ffffff)",
              border: "1px solid var(--color-border-warning, #f59e0b)",
              borderRadius: "0.75rem",
              marginBottom: "1.5rem",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                marginBottom: "0.75rem",
                color: "#b45309",
                fontWeight: 600,
              }}
            >
              <LockKeyhole size={18} />
              <span>Session Expired — Re-authenticate to Save</span>
            </div>
            <p
              style={{
                fontSize: "0.875rem",
                color: "var(--color-text-muted, #64748b)",
                marginBottom: "1rem",
              }}
            >
              Your entered clinic and doctor information is safely kept. Enter
              your password to restore your session and finish setup.
            </p>
            <form
              onSubmit={handleReauth}
              style={{
                display: "flex",
                gap: "0.75rem",
                alignItems: "flex-start",
                flexWrap: "wrap",
              }}
            >
              <div style={{ flex: "1 1 240px" }}>
                <TextInput
                  type="password"
                  placeholder="Enter your account password"
                  value={reauthPassword}
                  onChange={(e) => {
                    setReauthPassword(e.target.value)
                    setReauthError(null)
                  }}
                  autoFocus
                />
                {reauthError && (
                  <small
                    style={{
                      color: "#ef4444",
                      display: "block",
                      marginTop: "0.25rem",
                    }}
                  >
                    {reauthError}
                  </small>
                )}
              </div>
              <Button
                type="submit"
                loading={reauthLoading}
                disabled={reauthLoading}
              >
                {reauthLoading ? "Verifying…" : "Resume & Save Clinic"}
              </Button>
            </form>
          </div>
        )}

        <form className="setup-card" onSubmit={next}>
          {step === 1 ? (
            <>
              <div className="photo-upload">
                <span className="photo-placeholder">
                  <UserRound size={28} />
                </span>
                <div>
                  <strong>Profile photo</strong>
                  <p>PNG or JPG, up to 2 MB</p>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  icon={Upload}
                  onClick={() =>
                    window.alert(
                      "Profile photo picker opened in the production application.",
                    )
                  }
                >
                  Upload photo
                </Button>
              </div>
              <div className="form-grid two">
                <Field
                  label="Full name"
                  required
                  error={
                    error && !fullName.trim()
                      ? "Enter your full name"
                      : undefined
                  }
                >
                  <TextInput
                    required
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="Dr. Full name"
                  />
                </Field>
                <Field label="Gender" required>
                  <SelectInput
                    id="setup-gender-select"
                    required
                    value={gender}
                    onChange={(e) => setGender(e.target.value)}
                  >
                    <option>Female</option>
                    <option>Male</option>
                    <option>Non-binary</option>
                    <option>Prefer not to say</option>
                  </SelectInput>
                </Field>
                <Field label="Qualifications" required>
                  <TextInput
                    required
                    value={qualifications}
                    onChange={(e) => setQualifications(e.target.value)}
                    placeholder="e.g. MBBS, MD"
                  />
                </Field>
                <Field label="Medical registration number" required>
                  <TextInput
                    required
                    value={registrationNumber}
                    onChange={(e) => setRegistrationNumber(e.target.value)}
                    placeholder="Registration number"
                  />
                </Field>
                <Field label="Mobile number" required>
                  <TextInput
                    required
                    value={mobile}
                    onChange={(e) => setMobile(e.target.value)}
                    type="tel"
                  />
                </Field>
                <Field label="Professional email" required>
                  <TextInput
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    type="email"
                  />
                </Field>
              </div>
            </>
          ) : (
            <>
              <div className="photo-upload">
                <span className="clinic-logo-placeholder">
                  <Building2 size={24} />
                </span>
                <div>
                  <strong>
                    Clinic logo <em>Optional</em>
                  </strong>
                  <p>Used on printed prescriptions</p>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  icon={Upload}
                  onClick={() =>
                    window.alert(
                      "Clinic logo picker opened in the production application.",
                    )
                  }
                >
                  Upload logo
                </Button>
              </div>
              <div className="form-grid two">
                <Field label="Clinic or hospital name" required>
                  <TextInput
                    required
                    placeholder="e.g. City Health Clinic"
                    value={clinicName}
                    onChange={(e) => setClinicName(e.target.value)}
                  />
                </Field>
                <Field label="Clinic phone" required>
                  <TextInput
                    required
                    placeholder="+91 00000 00000"
                    value={clinicPhone}
                    onChange={(e) => setClinicPhone(e.target.value)}
                    type="tel"
                  />
                </Field>
                <Field label="Address" required className="full">
                  <TextInput
                    required
                    placeholder="e.g. 123 Healthcare Avenue, Suite 4"
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                  />
                </Field>
                <Field label="City" required>
                  <TextInput
                    required
                    placeholder="e.g. Mumbai"
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                  />
                </Field>
                <Field label="State" required>
                  <TextInput
                    required
                    placeholder="e.g. Maharashtra"
                    value={state}
                    onChange={(e) => setState(e.target.value)}
                  />
                </Field>
                <Field label="Postal code" required>
                  <TextInput
                    required
                    placeholder="e.g. 400001"
                    value={postalCode}
                    onChange={(e) => setPostalCode(e.target.value)}
                  />
                </Field>
                <Field label="Google Maps location" hint="Optional">
                  <TextInput
                    placeholder="Paste location link"
                    value={mapsLocation}
                    onChange={(e) => setMapsLocation(e.target.value)}
                  />
                </Field>
                <Field label="Clinic email" hint="Optional">
                  <TextInput
                    placeholder="care@clinic.com"
                    value={clinicEmail}
                    onChange={(e) => setClinicEmail(e.target.value)}
                    type="email"
                  />
                </Field>
              </div>
            </>
          )}
          <div className="form-actions split">
            {step === 1 ? (
              <Button
                type="button"
                variant="ghost"
                icon={ArrowLeft}
                onClick={() => go("register")}
              >
                Back
              </Button>
            ) : (
              <Button
                type="button"
                variant="ghost"
                icon={ArrowLeft}
                onClick={() => setStep(1)}
              >
                Back
              </Button>
            )}
            <Button
              type="submit"
              loading={status === "saving"}
              disabled={status === "saving"}
            >
              {status === "saving" ? (
                "Saving setup…"
              ) : step === 1 ? (
                <>
                  Continue <ArrowRight size={16} />
                </>
              ) : (
                <>
                  Save and continue <ArrowRight size={16} />
                </>
              )}
            </Button>
          </div>
        </form>
        <p className="secure-note">
          <ShieldCheck size={15} /> You can update these details any time in
          Settings.
        </p>
      </div>
    </main>
  )
}
export default Setup
