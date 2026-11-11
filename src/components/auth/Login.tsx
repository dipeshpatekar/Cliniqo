import { useState, useRef, useEffect, type FormEvent } from "react"
import { cn } from "../../utils/cn"
import { Button, Logo } from "../common"
import {
  isTauriDesktop,
  loginDesktop,
  requestPasswordResetOtp,
  verifyPasswordResetOtp,
  resetPasswordWithToken,
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
  KeyRound,
  LockKeyhole,
  Mail,
  ShieldCheck,
} from "lucide-react"

function sanitizeAuthErrorMessage(rawMessage: string): string {
  if (!rawMessage) {
    return "Invalid email or password. Please verify your credentials."
  }
  const lower = rawMessage.toLowerCase()
  if (
    lower.includes("render.com") ||
    lower.includes("http://") ||
    lower.includes("https://") ||
    lower.includes("unreachable") ||
    lower.includes("connection closed") ||
    lower.includes("failed to fetch") ||
    lower.includes("networkerror") ||
    lower.includes("dns") ||
    lower.includes("reqwest") ||
    lower.includes("timeout") ||
    lower.includes("socket")
  ) {
    return "Unable to connect to the authentication server. Please check your internet connection and try again."
  }
  return rawMessage
}

export interface LoginProps {
  go: (page: Page) => void
  onLoginSuccess?: (session: DesktopSessionContext) => void
  initialView?: "login" | "forgot" | "otp" | "reset" | "success"
  initialEmail?: string
}

export function Login({
  go,
  onLoginSuccess,
  initialView = "login",
  initialEmail = "",
}: LoginProps) {
  const [view, setView] =
    useState<"login" | "forgot" | "otp" | "reset" | "success">(initialView)
  const [email, setEmail] = useState(initialEmail)
  const [password, setPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [resetToken, setResetToken] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [showNewPassword, setShowNewPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
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
        console.error("[Login Auth Error]", err)
        setAuthState("idle")
        const raw = typeof err === "string" ? err : err?.message || ""
        setErrors({
          form: sanitizeAuthErrorMessage(raw),
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

  const requestReset = async (event: FormEvent) => {
    event.preventDefault()
    if (!emailPattern.test(email)) {
      setErrors({ email: "Enter the email address linked to your account" })
      return
    }
    setErrors({})
    setAuthState("sending")

    try {
      await requestPasswordResetOtp(email)
      setView("otp")
      setAuthState("idle")
      setCountdown(30)
      window.setTimeout(() => otpRefs.current[0]?.focus(), 80)
    } catch (err: any) {
      setAuthState("idle")
      if (err?.status === 429) {
        setErrors({
          email:
            err?.message ||
            "Resend limit reached. Please wait before requesting another code.",
        })
      } else {
        setErrors({
          email: sanitizeAuthErrorMessage(
            err?.message ||
              "Unable to connect to the authentication server. Please check your internet connection.",
          ),
        })
      }
    }
  }

  const updateOtpDigit = (index: number, value: string) => {
    const digit = value.replace(/\D/g, "").slice(-1)
    setOtp((current) =>
      current.map((item, itemIndex) => (itemIndex === index ? digit : item)),
    )
    setAuthState("idle")
    if (digit && index < 5) otpRefs.current[index + 1]?.focus()
  }

  const verifyOtp = async (event: FormEvent) => {
    event.preventDefault()
    const code = otp.join("")
    if (code.length !== 6) {
      setAuthState("invalid")
      return
    }

    setAuthState("verifying")
    try {
      const res = await verifyPasswordResetOtp(email, code)
      if (!res?.resetToken) {
        throw new Error(
          "Invalid verification response from authentication server.",
        )
      }
      setResetToken(res.resetToken)
      setView("reset")
      setAuthState("idle")
    } catch (err: any) {
      const msg = String(err?.message || "").toLowerCase()
      if (msg.includes("expired")) {
        setAuthState("expired")
      } else if (msg.includes("limit") || err?.status === 429) {
        setAuthState("limit")
      } else if (
        err?.isNetworkError ||
        err?.name === "TypeError" ||
        msg.includes("failed to fetch") ||
        msg.includes("network") ||
        msg.includes("connect") ||
        msg.includes("unable to connect")
      ) {
        setAuthState("network")
      } else {
        setAuthState("invalid")
      }
    }
  }

  const resendOtp = async () => {
    if (countdown > 0 || authState === "sending") return
    if (resendCount >= 2) {
      setAuthState("limit")
      return
    }
    setAuthState("sending")
    setOtp(["", "", "", "", "", ""])

    try {
      await requestPasswordResetOtp(email)
      setResendCount((count) => count + 1)
      setCountdown(30)
      setAuthState("idle")
      otpRefs.current[0]?.focus()
    } catch (err: any) {
      if (err?.status === 429) {
        setAuthState("limit")
      } else {
        setAuthState("network")
      }
    }
  }

  const backToEmail = () => {
    setView("forgot")
    setOtp(["", "", "", "", "", ""])
    setAuthState("idle")
    setCountdown(30)
  }

  const resetPassword = async (event: FormEvent) => {
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

    if (!resetToken) {
      setAuthState("idle")
      setErrors({
        confirmPassword:
          "No verified password reset session found. Please request a new verification code.",
      })
      return
    }

    try {
      await resetPasswordWithToken(resetToken, newPassword)
      setView("success")
      setAuthState("idle")
    } catch (err: any) {
      setAuthState("idle")
      setErrors({
        confirmPassword: sanitizeAuthErrorMessage(
          err?.message || "Failed to reset password.",
        ),
      })
    }
  }

  const returnToSignIn = () => {
    setView("login")
    setPassword("")
    setNewPassword("")
    setConfirmPassword("")
    setResetToken("")
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
    <main className="login-screen-root">
      <div className="login-split-card">
        {/* Left promotional panel with brand headline and description */}
        <aside className="login-promo-panel" aria-label="Cliniqo overview">
          <div className="login-promo-content">
            <h1 className="login-promo-heading">
              Manage your clinic with Cliniqo
            </h1>
            <p className="login-promo-description">
              A simple and powerful clinic management system for modern doctors.
            </p>
          </div>
        </aside>

        {/* Right authentication form panel */}
        <section className="login-form-panel">
          {view === "login" && (
            <>
              <div className="login-logo-lockup">
                <Logo />
              </div>
              <h2 className="login-heading">
                Welcome Back
                <span className="sr-only">Welcome back</span>
              </h2>
              <p className="login-subheading">Please login to your account</p>

              {errors.form && (
                <div className="login-alert-error" role="alert">
                  <AlertCircle size={16} />
                  <span>{errors.form}</span>
                </div>
              )}

              <form className="login-form" onSubmit={signIn} noValidate>
                <div className="login-field-group">
                  <label htmlFor="login-email" className="login-field-label">
                    <span className="sr-only">Email address</span>
                    <span aria-hidden="true">Email</span>
                  </label>
                  <div
                    className={cn(
                      "login-input-wrap",
                      errors.email && "invalid",
                    )}
                  >
                    <Mail size={18} className="login-input-icon" />
                    <input
                      id="login-email"
                      type="email"
                      autoComplete="email"
                      value={email}
                      onChange={(event) => {
                        setEmail(event.target.value)
                        setErrors({})
                      }}
                      placeholder="Enter your email"
                      aria-invalid={Boolean(errors.email)}
                    />
                  </div>
                  {errors.email && (
                    <small className="login-field-error">{errors.email}</small>
                  )}
                </div>

                <div className="login-field-group">
                  <label htmlFor="login-password" className="login-field-label">
                    Password
                  </label>
                  <div
                    className={cn(
                      "login-input-wrap",
                      errors.password && "invalid",
                    )}
                  >
                    <LockKeyhole size={18} className="login-input-icon" />
                    <input
                      id="login-password"
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
                    <button
                      type="button"
                      className="login-password-toggle"
                      onClick={() => setShowPassword((visible) => !visible)}
                      aria-label={
                        showPassword ? "Hide password" : "Show password"
                      }
                    >
                      {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
                  <div className="login-forgot-wrapper">
                    <button
                      type="button"
                      className="login-forgot-link"
                      onClick={() => {
                        setView("forgot")
                        setErrors({})
                      }}
                    >
                      Forgot Password?
                    </button>
                  </div>
                  {errors.password && (
                    <small className="login-field-error">
                      {errors.password}
                    </small>
                  )}
                </div>

                <Button
                  type="submit"
                  className="login-submit-btn"
                  disabled={authState === "loading"}
                  loading={authState === "loading"}
                >
                  {authState === "loading" ? (
                    "Logging in…"
                  ) : (
                    <>
                      Login
                      <span className="sr-only"> Sign In</span>
                    </>
                  )}
                </Button>
              </form>

              <div className="login-switch-footer">
                <span>Don't have an account?</span>
                <button
                  type="button"
                  className="login-switch-action"
                  onClick={() => go("register")}
                >
                  Create Account
                </button>
              </div>

              <p className="login-security-badge">
                <ShieldCheck size={14} /> Doctor-only secure workspace
              </p>
            </>
          )}

          {view === "forgot" && (
            <>
              <button
                className="login-back-btn"
                type="button"
                onClick={returnToSignIn}
              >
                <ArrowLeft size={15} /> Back to Login
              </button>
              <div className="login-logo-lockup">
                <Logo />
              </div>
              <h2 className="login-heading">Forgot Password?</h2>
              <p className="login-subheading">
                Enter your email address and we will send you a verification
                code.
              </p>
              <form className="login-form" onSubmit={requestReset} noValidate>
                <div className="login-field-group">
                  <label htmlFor="forgot-email" className="login-field-label">
                    Email address
                  </label>
                  <div
                    className={cn(
                      "login-input-wrap",
                      errors.email && "invalid",
                    )}
                  >
                    <Mail size={18} className="login-input-icon" />
                    <input
                      id="forgot-email"
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
                    <small className="login-field-error">{errors.email}</small>
                  )}
                </div>
                <Button
                  type="submit"
                  className="login-submit-btn"
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
              <p className="login-security-badge">
                <Mail size={14} /> Password reset instructions will be sent to
                registered clinics.
              </p>
            </>
          )}

          {view === "otp" && (
            <>
              <button
                className="login-back-btn"
                type="button"
                onClick={backToEmail}
              >
                <ArrowLeft size={15} /> Change email
              </button>
              <span className="login-eyebrow">Email verification</span>
              <h2 className="login-heading">Check your email</h2>
              <p className="login-subheading">
                Enter the 6-digit code sent to <strong>{maskedEmail}</strong>.
              </p>
              {otpMessage && (
                <div className="login-alert-error" role="alert">
                  <AlertCircle size={16} />
                  <span>{otpMessage}</span>
                </div>
              )}
              <form className="login-form" onSubmit={verifyOtp}>
                <div
                  className="login-otp-group"
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
                        if (event.key === "Backspace") {
                          if (!digit && index > 0) {
                            event.preventDefault()
                            const prevIndex = index - 1
                            setOtp((current) =>
                              current.map((item, itemIndex) =>
                                itemIndex === prevIndex ? "" : item,
                              ),
                            )
                            otpRefs.current[prevIndex]?.focus()
                          }
                        }
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
                <div className="login-otp-actions">
                  <span>
                    {countdown > 0
                      ? `Resend available in 00:${String(countdown).padStart(2, "0")}`
                      : "Didn't receive the code?"}
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
                  className="login-submit-btn"
                  disabled={
                    authState === "verifying" ||
                    authState === "sending" ||
                    otp.join("").length !== 6
                  }
                  loading={authState === "verifying"}
                >
                  {authState === "verifying" ? "Verifying…" : "Verify code"}
                </Button>
              </form>
            </>
          )}

          {view === "reset" && (
            <>
              <button
                className="login-back-btn"
                type="button"
                onClick={returnToSignIn}
              >
                <ArrowLeft size={15} /> Cancel
              </button>
              <div className="login-logo-lockup">
                <Logo />
              </div>
              <h2 className="login-heading">Reset your password</h2>
              <p className="login-subheading">
                Create a new secure password for your account.
              </p>
              <form className="login-form" onSubmit={resetPassword} noValidate>
                <div className="login-field-group">
                  <label
                    htmlFor="reset-new-password"
                    className="login-field-label"
                  >
                    New password
                  </label>
                  <div
                    className={cn(
                      "login-input-wrap",
                      errors.newPassword && "invalid",
                    )}
                  >
                    <KeyRound size={18} className="login-input-icon" />
                    <input
                      id="reset-new-password"
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
                    <button
                      type="button"
                      className="login-password-toggle"
                      onClick={() => setShowNewPassword((visible) => !visible)}
                      aria-label={
                        showNewPassword ? "Hide password" : "Show password"
                      }
                    >
                      {showNewPassword ? (
                        <EyeOff size={18} />
                      ) : (
                        <Eye size={18} />
                      )}
                    </button>
                  </div>
                  {errors.newPassword ? (
                    <small className="login-field-error">
                      {errors.newPassword}
                    </small>
                  ) : (
                    <small className="login-field-help">
                      Use 8+ characters with an uppercase letter and a number.
                    </small>
                  )}
                </div>

                <div className="login-field-group">
                  <label
                    htmlFor="reset-confirm-password"
                    className="login-field-label"
                  >
                    Confirm new password
                  </label>
                  <div
                    className={cn(
                      "login-input-wrap",
                      errors.confirmPassword && "invalid",
                    )}
                  >
                    <LockKeyhole size={18} className="login-input-icon" />
                    <input
                      id="reset-confirm-password"
                      type={showConfirmPassword ? "text" : "password"}
                      autoComplete="new-password"
                      value={confirmPassword}
                      onChange={(event) => {
                        setConfirmPassword(event.target.value)
                        setErrors({})
                      }}
                      placeholder="Re-enter your new password"
                      aria-invalid={Boolean(errors.confirmPassword)}
                    />
                    <button
                      type="button"
                      className="login-password-toggle"
                      onClick={() =>
                        setShowConfirmPassword((visible) => !visible)
                      }
                      aria-label={
                        showConfirmPassword ? "Hide password" : "Show password"
                      }
                    >
                      {showConfirmPassword ? (
                        <EyeOff size={18} />
                      ) : (
                        <Eye size={18} />
                      )}
                    </button>
                  </div>
                  {errors.confirmPassword && (
                    <small className="login-field-error">
                      {errors.confirmPassword}
                    </small>
                  )}
                </div>

                <Button
                  type="submit"
                  className="login-submit-btn"
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
            <div className="login-success-card" role="status">
              <span className="login-success-icon">
                <Check size={28} />
              </span>
              <h2 className="login-heading">Password reset</h2>
              <p className="login-subheading">
                Your password has been updated successfully.
                <br />
                You can now sign in with your new password.
              </p>
              <Button className="login-submit-btn" onClick={returnToSignIn}>
                Back to Login <ArrowRight size={16} />
              </Button>
            </div>
          )}
        </section>
      </div>
    </main>
  )
}

export default Login
