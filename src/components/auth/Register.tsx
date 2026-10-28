import { useState, type FormEvent } from "react"
import { cn } from "../../utils/cn"
import { Button, IconButton, Logo } from "../common"
import type { Page } from "../../types"
import {
  AlertCircle,
  ArrowRight,
  Check,
  Eye,
  EyeOff,
  FileText,
  KeyRound,
  LockKeyhole,
  Mail,
  Phone,
  RefreshCw,
  ShieldCheck,
  UserRound,
} from "lucide-react"

export function Register({ go }: { go: (page: Page) => void }) {
  const [fullName, setFullName] = useState("")
  const [email, setEmail] = useState("")
  const [mobile, setMobile] = useState("")
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [status, setStatus] =
    useState<"idle" | "loading" | "success" | "duplicate" | "failure">("idle")
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  const passwordChecks = [
    password.length >= 8,
    /[A-Z]/.test(password) && /[a-z]/.test(password),
    /\d/.test(password),
  ]
  const passwordScore = passwordChecks.filter(Boolean).length
  const passwordStrength =
    passwordScore <= 1 ? "Weak" : passwordScore === 2 ? "Good" : "Strong"

  const clearFieldError = (field: string) => {
    setErrors((current) => {
      if (!current[field]) return current
      const next = { ...current }
      delete next[field]
      return next
    })
    if (status === "duplicate" || status === "failure") setStatus("idle")
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const nextErrors: Record<string, string> = {}
    if (!fullName.trim()) nextErrors.fullName = "Enter your full name"
    else if (fullName.trim().length < 3)
      nextErrors.fullName = "Full name must be at least 3 characters"
    if (!emailPattern.test(email))
      nextErrors.email = "Enter a valid professional email"
    if (mobile.length !== 10)
      nextErrors.mobile = "Enter a valid 10-digit mobile number"
    if (!passwordChecks.every(Boolean))
      nextErrors.password =
        "Use 8+ characters with uppercase, lowercase, and a number"
    if (!confirmPassword) nextErrors.confirmPassword = "Confirm your password"
    else if (confirmPassword !== password)
      nextErrors.confirmPassword = "Passwords do not match"
    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors)
      return
    }

    setErrors({})
    setStatus("loading")
    window.setTimeout(() => {
      const normalizedEmail = email.trim().toLowerCase()
      if (
        normalizedEmail === "nikhil@nishtihospital.in" ||
        normalizedEmail === "duplicate@cliniqo.demo"
      )
        setStatus("duplicate")
      else if (normalizedEmail === "error@demo.test") setStatus("failure")
      else setStatus("success")
    }, 900)
  }

  return (
    <main className="auth-page">
      <section className="auth-brand-panel">
        <Logo large />
        <div className="auth-message">
          <span className="eyebrow">Start your doctor workspace</span>
          <h1>
            Your clinic,
            <br />
            set up with care.
          </h1>
          <p>
            Create the doctor profile used for your workspace, then add the
            clinic details shown on patient documents.
          </p>
          <div className="auth-feature-grid">
            <span>
              <ShieldCheck size={18} />
              <strong>Doctor-first</strong>
              <small>Built around clinical workflows</small>
            </span>
            <span>
              <LockKeyhole size={18} />
              <strong>Private workspace</strong>
              <small>Clinic access stays separated</small>
            </span>
            <span>
              <FileText size={18} />
              <strong>Ready to configure</strong>
              <small>Continue into profile setup</small>
            </span>
          </div>
        </div>
        <div className="trust-row">
          <span>
            <ShieldCheck size={16} /> Secure account interface
          </span>
          <span>
            <LockKeyhole size={16} /> Frontend demo only
          </span>
        </div>
      </section>
      <section className="auth-form-panel register-panel">
        <div className="login-card register-card">
          <div className="auth-card-logo">
            <Logo />
          </div>
          {status === "success" ? (
            <div className="auth-success register-success" role="status">
              <span>
                <Check size={26} />
              </span>
              <h2>Registration UI complete</h2>
              <p>
                Your details passed the local demo validation. No account was
                created and no email or SMS verification occurred.
              </p>
              <Button
                className="auth-success-button"
                onClick={() => go("setup")}
              >
                Continue to profile setup <ArrowRight size={16} />
              </Button>
              <button
                className="auth-text-link"
                type="button"
                onClick={() => go("login")}
              >
                Return to Sign In
              </button>
            </div>
          ) : (
            <>
              <span className="eyebrow">Register new user</span>
              <h2>Create your account</h2>
              <p>
                Enter your professional details to continue to doctor and clinic
                setup.
              </p>
              {(status === "duplicate" || status === "failure") && (
                <div className="auth-error" role="alert">
                  <AlertCircle size={16} />
                  <span>
                    {status === "duplicate"
                      ? "An account already exists for this email. Sign in or use a different address."
                      : "The demo registration request could not be completed. Review your details and try again."}
                  </span>
                </div>
              )}
              <form
                className="auth-form register-form"
                onSubmit={submit}
                noValidate
              >
                <label className="auth-field">
                  <span>Full name</span>
                  <div
                    className={cn(
                      "auth-input-wrap",
                      errors.fullName && "invalid",
                    )}
                  >
                    <UserRound size={17} />
                    <input
                      autoComplete="name"
                      value={fullName}
                      onChange={(event) => {
                        setFullName(event.target.value)
                        clearFieldError("fullName")
                      }}
                      placeholder="Dr. Full name"
                      aria-invalid={Boolean(errors.fullName)}
                    />
                  </div>
                  {errors.fullName && (
                    <small className="auth-field-error">
                      {errors.fullName}
                    </small>
                  )}
                </label>
                <label className="auth-field">
                  <span>Professional email</span>
                  <div
                    className={cn("auth-input-wrap", errors.email && "invalid")}
                  >
                    <Mail size={17} />
                    <input
                      type="email"
                      autoComplete="email"
                      value={email}
                      onChange={(event) => {
                        setEmail(event.target.value)
                        clearFieldError("email")
                      }}
                      placeholder="doctor@clinic.com"
                      aria-invalid={Boolean(errors.email)}
                    />
                  </div>
                  {errors.email && (
                    <small className="auth-field-error">{errors.email}</small>
                  )}
                </label>
                <label className="auth-field">
                  <span>Mobile number</span>
                  <div
                    className={cn(
                      "auth-input-wrap",
                      errors.mobile && "invalid",
                    )}
                  >
                    <Phone size={17} />
                    <input
                      type="tel"
                      inputMode="numeric"
                      autoComplete="tel-national"
                      value={mobile}
                      onChange={(event) => {
                        setMobile(
                          event.target.value.replace(/\D/g, "").slice(0, 10),
                        )
                        clearFieldError("mobile")
                      }}
                      placeholder="10-digit mobile number"
                      aria-invalid={Boolean(errors.mobile)}
                    />
                  </div>
                  {errors.mobile && (
                    <small className="auth-field-error">{errors.mobile}</small>
                  )}
                </label>
                <label className="auth-field">
                  <span>Password</span>
                  <div
                    className={cn(
                      "auth-input-wrap",
                      errors.password && "invalid",
                    )}
                  >
                    <KeyRound size={17} />
                    <input
                      type={showPassword ? "text" : "password"}
                      autoComplete="new-password"
                      value={password}
                      onChange={(event) => {
                        setPassword(event.target.value)
                        clearFieldError("password")
                      }}
                      placeholder="Create a strong password"
                      aria-invalid={Boolean(errors.password)}
                    />
                    <IconButton
                      type="button"
                      label={showPassword ? "Hide password" : "Show password"}
                      onClick={() => setShowPassword((visible) => !visible)}
                    >
                      {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                    </IconButton>
                  </div>
                  {errors.password && (
                    <small className="auth-field-error">
                      {errors.password}
                    </small>
                  )}
                  {password && (
                    <div
                      className={cn(
                        "password-strength",
                        `strength-${passwordStrength.toLowerCase()}`,
                      )}
                    >
                      <span>
                        <i />
                        <i />
                        <i />
                      </span>
                      <small>
                        {passwordStrength} · 8+ characters, upper/lowercase, and
                        a number
                      </small>
                    </div>
                  )}
                </label>
                <label className="auth-field">
                  <span>Confirm password</span>
                  <div
                    className={cn(
                      "auth-input-wrap",
                      errors.confirmPassword && "invalid",
                    )}
                  >
                    <LockKeyhole size={17} />
                    <input
                      type={showConfirmPassword ? "text" : "password"}
                      autoComplete="new-password"
                      value={confirmPassword}
                      onChange={(event) => {
                        setConfirmPassword(event.target.value)
                        clearFieldError("confirmPassword")
                      }}
                      placeholder="Re-enter your password"
                      aria-invalid={Boolean(errors.confirmPassword)}
                    />
                    <IconButton
                      type="button"
                      label={
                        showConfirmPassword ? "Hide password" : "Show password"
                      }
                      onClick={() =>
                        setShowConfirmPassword((visible) => !visible)
                      }
                    >
                      {showConfirmPassword ? (
                        <EyeOff size={17} />
                      ) : (
                        <Eye size={17} />
                      )}
                    </IconButton>
                  </div>
                  {errors.confirmPassword && (
                    <small className="auth-field-error">
                      {errors.confirmPassword}
                    </small>
                  )}
                </label>
                <Button
                  type="submit"
                  className="auth-submit"
                  disabled={status === "loading"}
                  loading={status === "loading"}
                >
                  {status === "loading" ? (
                    "Validating details…"
                  ) : (
                    <>
                      Create account <ArrowRight size={17} />
                    </>
                  )}
                </Button>
              </form>
              <div className="auth-switch">
                <span>Already have an account?</span>
                <button type="button" onClick={() => go("login")}>
                  Sign In
                </button>
              </div>
              <div className="prototype-codes register-demo-note">
                <strong>Frontend demo states</strong>
                <span>
                  Existing account email → duplicate · error@demo.test → failure
                  · other valid details → success UI.
                </span>
              </div>
            </>
          )}
        </div>
        <p className="auth-footer">
          Frontend registration demo · No backend connection
        </p>
      </section>
    </main>
  )
}
