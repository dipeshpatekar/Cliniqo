import { useState, useRef, useEffect, type FormEvent } from "react"
import { cn } from "../../utils/cn"
import { Button, IconButton, Logo } from "../common"
import {
  isTauriDesktop,
  loginDesktop,
  type DesktopSessionContext,
} from "../../desktop/desktop-bridge"
import type { Page } from "../../types"
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Check,
  Eye,
  EyeOff,
  FileText,
  KeyRound,
  LockKeyhole,
  Mail,
  RefreshCw,
  ShieldCheck,
  WifiOff,
} from "lucide-react"

export function Login({
  go,
  onLoginSuccess,
}: {
  go: (page: Page) => void
  onLoginSuccess?: (session: DesktopSessionContext) => void
}) {
  const [view, setView] =
    useState<"login" | "forgot" | "otp" | "reset" | "success">("login")
  const [email, setEmail] = useState("nikhil@nishtihospital.in")
  const [password, setPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [showNewPassword, setShowNewPassword] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [otp, setOtp] = useState(["", "", "", "", "", ""])
  const [authState, setAuthState] =
    useState<"idle" | "loading" | "sending" | "verifying" | "invalid" | "expired" | "network" | "limit">(
      "idle",
    )
  const [countdown, setCountdown] = useState(30)
  const [resendCount, setResendCount] = useState(0)
  const otpRefs = useRef<Array<HTMLInputElement | null>>([])
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  const [emailName = "", emailDomain = ""] = email.split("@")
  const maskedEmail =
    emailName && emailDomain
      ? `${emailName.slice(0, 2)}${"•".repeat(Math.max(3, emailName.length - 2))}@${emailDomain}`
      : email

  useEffect(() => {
    if (view !== "otp" || countdown <= 0) return
    const timer = window.setInterval(
      () => setCountdown((value) => Math.max(0, value - 1)),
      1000,
    )
    return () => window.clearInterval(timer)
  }, [view, countdown])

  const signIn = async (event: FormEvent) => {
    event.preventDefault()
    const nextErrors: Record<string, string> = {}
    if (!emailPattern.test(email))
      nextErrors.email = "Enter a valid email address"
    if (!password) nextErrors.password = "Enter your password"
    else if (password.length < 8)
      nextErrors.password = "Password must be at least 8 characters"
    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors)
      return
    }

    if (isTauriDesktop()) {
      try {
        setAuthState("loading")
        const loginRes = await loginDesktop(email, password)

        if (!loginRes) {
          setAuthState("idle")
          setErrors({
            form: "Cryptographic session verification or clinic resolution failed.",
          })
          return
        }

        setAuthState("idle")
        if (onLoginSuccess) {
          onLoginSuccess(loginRes.session)
        } else {
          go("dashboard")
        }
        return
      } catch (err: any) {
        setAuthState("idle")
        setErrors({
          form:
            err?.message ||
            "Invalid email or password. Please verify your credentials.",
        })
        return
      }
    }

    if (password === "wrongpass") {
      setErrors({ form: "The email or password you entered is incorrect." })
      return
    }
    setErrors({})
    setAuthState("loading")
    window.setTimeout(() => go("dashboard"), 850)
  }

  const requestReset = (event: FormEvent) => {
    event.preventDefault()
    if (!emailPattern.test(email)) {
      setErrors({ email: "Enter the email address linked to your account" })
      return
    }
    setErrors({})
    setAuthState("sending")
    window.setTimeout(() => {
      setView("otp")
      setAuthState("idle")
      setCountdown(30)
      window.setTimeout(() => otpRefs.current[0]?.focus(), 80)
    }, 800)
  }

  const updateOtpDigit = (index: number, value: string) => {
    const digit = value.replace(/\D/g, "").slice(-1)
    setOtp((current) =>
      current.map((item, itemIndex) => (itemIndex === index ? digit : item)),
    )
    setAuthState("idle")
    if (digit && index < 5) otpRefs.current[index + 1]?.focus()
  }

  const verifyOtp = (event: FormEvent) => {
    event.preventDefault()
    const code = otp.join("")
    if (code.length !== 6) {
      setAuthState("invalid")
      return
    }
    if (countdown === 0 || code === "111111") {
      setAuthState("expired")
      return
    }
    if (code === "222222") {
      setAuthState("network")
      return
    }
    if (code === "333333") {
      setAuthState("limit")
      return
    }
    if (code !== "123456") {
      setAuthState("invalid")
      return
    }
    setAuthState("verifying")
    window.setTimeout(() => {
      setView("reset")
      setAuthState("idle")
    }, 700)
  }

  const resendOtp = () => {
    if (countdown > 0 || authState === "sending") return
    if (resendCount >= 2) {
      setAuthState("limit")
      return
    }
    setAuthState("sending")
    setOtp(["", "", "", "", "", ""])
    window.setTimeout(() => {
      setResendCount((count) => count + 1)
      setCountdown(30)
      setAuthState("idle")
      otpRefs.current[0]?.focus()
    }, 700)
  }

  const backToEmail = () => {
    setView("forgot")
    setOtp(["", "", "", "", "", ""])
    setAuthState("idle")
    setCountdown(30)
  }

  const resetPassword = (event: FormEvent) => {
    event.preventDefault()
    const nextErrors: Record<string, string> = {}
    if (newPassword.length < 8)
      nextErrors.newPassword = "Use at least 8 characters"
    else if (!/[A-Z]/.test(newPassword) || !/\d/.test(newPassword))
      nextErrors.newPassword = "Include an uppercase letter and a number"
    if (!confirmPassword)
      nextErrors.confirmPassword = "Confirm your new password"
    else if (newPassword !== confirmPassword)
      nextErrors.confirmPassword = "Passwords do not match"
    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors)
      return
    }
    setErrors({})
    setAuthState("loading")
    window.setTimeout(() => {
      setView("success")
      setAuthState("idle")
    }, 850)
  }

  const returnToSignIn = () => {
    setView("login")
    setPassword("")
    setNewPassword("")
    setConfirmPassword("")
    setErrors({})
    setAuthState("idle")
  }

  const otpMessage = {
    invalid: "That code is not valid. Check all six digits and try again.",
    expired: "This code has expired. Request a new code to continue.",
    network:
      "We couldn’t verify the code. Check your connection and try again.",
    limit: "Resend limit reached. Please wait before requesting another code.",
  }[(authState as "invalid" | "expired" | "network" | "limit")]

  return (
    <main className="auth-page">
      <section className="auth-brand-panel">
        <Logo large />
        <div className="auth-message">
          <span className="eyebrow">Designed for independent practice</span>
          <h1>
            Clinical care,
            <br />
            beautifully organized.
          </h1>
          <p>
            One calm, secure workspace for patient records, consultations,
            prescriptions, and everyday clinic operations.
          </p>
          <div className="auth-feature-grid">
            <span>
              <ShieldCheck size={18} />
              <strong>Private by design</strong>
              <small>Protected clinical workspace</small>
            </span>
            <span>
              <WifiOff size={18} />
              <strong>Offline-ready</strong>
              <small>Continue through interruptions</small>
            </span>
            <span>
              <FileText size={18} />
              <strong>Revision-safe</strong>
              <small>Preserve finalized records</small>
            </span>
          </div>
        </div>
        <div className="trust-row">
          <span>
            <ShieldCheck size={16} /> Secure clinic workspace
          </span>
          <span>
            <LockKeyhole size={16} /> Doctor-only access
          </span>
        </div>
      </section>
      <section className="auth-form-panel">
        <div className="login-card">
          <div className="auth-card-logo">
            <Logo />
          </div>
          {view === "login" && (
            <>
              <span className="eyebrow">Doctor-only access</span>
              <h2>Welcome back</h2>
              <p>
                Sign in with your registered clinic email to continue to your
                secure workspace.
              </p>
              {errors.form && (
                <div className="auth-error" role="alert">
                  <AlertCircle size={16} />
                  <span>{errors.form}</span>
                </div>
              )}
              <form className="auth-form" onSubmit={signIn} noValidate>
                <label className="auth-field">
                  <span>Email address</span>
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
                        setErrors({})
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
                  <span className="auth-label-row">
                    <span>Password</span>
                    <button
                      type="button"
                      onClick={() => {
                        setView("forgot")
                        setErrors({})
                      }}
                    >
                      Forgot password?
                    </button>
                  </span>
                  <div
                    className={cn(
                      "auth-input-wrap",
                      errors.password && "invalid",
                    )}
                  >
                    <LockKeyhole size={17} />
                    <input
                      type={showPassword ? "text" : "password"}
                      autoComplete="current-password"
                      value={password}
                      onChange={(event) => {
                        setPassword(event.target.value)
                        setErrors({})
                      }}
                      placeholder="Enter your password"
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
                </label>
                <Button
                  type="submit"
                  className="auth-submit"
                  disabled={authState === "loading"}
                  loading={authState === "loading"}
                >
                  {authState === "loading" ? (
                    "Signing in…"
                  ) : (
                    <>
                      Sign In <ArrowRight size={17} />
                    </>
                  )}
                </Button>
              </form>
              <div className="auth-switch">
                <span>New to Cliniqo?</span>
                <button type="button" onClick={() => go("register")}>
                  Create account
                </button>
              </div>
              <p className="privacy-note">
                <ShieldCheck size={14} /> Your session is protected with secure,
                doctor-only authentication.
              </p>
            </>
          )}
          {view === "forgot" && (
            <>
              <button
                className="auth-back"
                type="button"
                onClick={returnToSignIn}
              >
                <ArrowLeft size={15} /> Back to sign in
              </button>
              <span className="eyebrow">Account recovery</span>
              <h2>Forgot your password?</h2>
              <p>
                Enter your registered email and we’ll send a 6-digit
                verification code.
              </p>
              <form className="auth-form" onSubmit={requestReset} noValidate>
                <label className="auth-field">
                  <span>Email address</span>
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
                        setErrors({})
                      }}
                      placeholder="doctor@clinic.com"
                      aria-invalid={Boolean(errors.email)}
                    />
                  </div>
                  {errors.email && (
                    <small className="auth-field-error">{errors.email}</small>
                  )}
                </label>
                <Button
                  type="submit"
                  className="auth-submit"
                  disabled={authState === "sending"}
                  loading={authState === "sending"}
                >
                  {authState === "sending" ? (
                    "Sending code…"
                  ) : (
                    <>
                      Send verification code <ArrowRight size={17} />
                    </>
                  )}
                </Button>
              </form>
              <p className="privacy-note">
                <Mail size={14} /> Password reset instructions will be sent to
                registered clinics.
              </p>
            </>
          )}
          {view === "otp" && (
            <>
              <button className="auth-back" type="button" onClick={backToEmail}>
                <ArrowLeft size={15} /> Change email
              </button>
              <span className="eyebrow">Email verification</span>
              <h2>Check your email</h2>
              <p>
                Enter the 6-digit code sent to <strong>{maskedEmail}</strong>.
              </p>
              {otpMessage && (
                <div className="auth-error" role="alert">
                  <AlertCircle size={16} />
                  <span>{otpMessage}</span>
                </div>
              )}
              <form className="auth-form otp-form" onSubmit={verifyOtp}>
                <div
                  className="otp-group"
                  onPaste={(event) => {
                    const digits = event.clipboardData
                      .getData("text")
                      .replace(/\D/g, "")
                      .slice(0, 6)
                      .split("")
                    if (digits.length) {
                      event.preventDefault()
                      setOtp(
                        Array.from(
                          { length: 6 },
                          (_, index) => digits[index] || "",
                        ),
                      )
                      setAuthState("idle")
                      otpRefs.current[Math.min(digits.length, 6) - 1]?.focus()
                    }
                  }}
                >
                  {otp.map((digit, index) => (
                    <input
                      key={index}
                      ref={(element) => {
                        otpRefs.current[index] = element
                      }}
                      value={digit}
                      onChange={(event) =>
                        updateOtpDigit(index, event.target.value)
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Backspace" && !digit && index > 0)
                          otpRefs.current[index - 1]?.focus()
                      }}
                      inputMode="numeric"
                      autoComplete={index === 0 ? "one-time-code" : "off"}
                      maxLength={1}
                      aria-label={`Verification code digit ${index + 1}`}
                      className={cn(
                        ["invalid", "expired", "network", "limit"].includes(
                          authState,
                        ) && "invalid",
                      )}
                    />
                  ))}
                </div>
                <div className="otp-actions">
                  <span>
                    {countdown > 0
                      ? `Resend available in 00:${String(countdown).padStart(2, "0")}`
                      : "Didn’t receive the code?"}
                  </span>
                  <button
                    type="button"
                    onClick={resendOtp}
                    disabled={countdown > 0 || authState === "sending"}
                  >
                    {authState === "sending" ? "Sending…" : "Resend code"}
                  </button>
                </div>
                <Button
                  type="submit"
                  className="auth-submit"
                  disabled={
                    authState === "verifying" || authState === "sending"
                  }
                  loading={authState === "verifying"}
                >
                  {authState === "verifying" ? "Verifying…" : "Verify code"}
                </Button>
              </form>
              <div className="prototype-codes">
                <strong>Prototype states</strong>
                <span>
                  123456 success · 000000 invalid · 111111 expired · 222222
                  network · 333333 resend limit
                </span>
              </div>
            </>
          )}
          {view === "reset" && (
            <>
              <span className="eyebrow">Create new password</span>
              <h2>Reset your password</h2>
              <p>
                Choose a strong password you haven’t used for this account
                before.
              </p>
              <form className="auth-form" onSubmit={resetPassword} noValidate>
                <label className="auth-field">
                  <span>New password</span>
                  <div
                    className={cn(
                      "auth-input-wrap",
                      errors.newPassword && "invalid",
                    )}
                  >
                    <KeyRound size={17} />
                    <input
                      type={showNewPassword ? "text" : "password"}
                      autoComplete="new-password"
                      value={newPassword}
                      onChange={(event) => {
                        setNewPassword(event.target.value)
                        setErrors({})
                      }}
                      placeholder="At least 8 characters"
                      aria-invalid={Boolean(errors.newPassword)}
                    />
                    <IconButton
                      type="button"
                      label={
                        showNewPassword ? "Hide password" : "Show password"
                      }
                      onClick={() => setShowNewPassword((visible) => !visible)}
                    >
                      {showNewPassword ? (
                        <EyeOff size={17} />
                      ) : (
                        <Eye size={17} />
                      )}
                    </IconButton>
                  </div>
                  {errors.newPassword ? (
                    <small className="auth-field-error">
                      {errors.newPassword}
                    </small>
                  ) : (
                    <small className="auth-field-help">
                      Use 8+ characters with an uppercase letter and a number.
                    </small>
                  )}
                </label>
                <label className="auth-field">
                  <span>Confirm new password</span>
                  <div
                    className={cn(
                      "auth-input-wrap",
                      errors.confirmPassword && "invalid",
                    )}
                  >
                    <LockKeyhole size={17} />
                    <input
                      type={showNewPassword ? "text" : "password"}
                      autoComplete="new-password"
                      value={confirmPassword}
                      onChange={(event) => {
                        setConfirmPassword(event.target.value)
                        setErrors({})
                      }}
                      placeholder="Re-enter your new password"
                      aria-invalid={Boolean(errors.confirmPassword)}
                    />
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
                  disabled={authState === "loading"}
                  loading={authState === "loading"}
                >
                  {authState === "loading"
                    ? "Updating password…"
                    : "Reset password"}
                </Button>
              </form>
            </>
          )}
          {view === "success" && (
            <div className="auth-success" role="status">
              <span>
                <Check size={26} />
              </span>
              <h2>Password reset</h2>
              <p>
                Your password has been updated successfully.
                <br />
                You can now sign in with your new password.
              </p>
              <Button className="auth-success-button" onClick={returnToSignIn}>
                Back to Sign In <ArrowRight size={16} />
              </Button>
            </div>
          )}
        </div>
        <p className="auth-footer">
          Secure doctor access · Terms of Use · Privacy Policy
        </p>
      </section>
    </main>
  )
}
