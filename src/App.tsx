import { useEffect, useMemo, useRef, useState, type ComponentType, type FormEvent, type ReactNode } from "react";
import {
  isTauriDesktop,
  getDesktopSession,
  loginDesktop,
  refreshDesktopSession,
  hasPersistedRefreshToken,
  loginDesktopSession,
  logoutDesktopSession,
  getSyncStatus,
  getApiBaseUrl,
  saveLocalPatient,
  deleteLocalPatient,
  getLocalPatients,
  saveLocalConsultation,
  saveLocalPrescription,
  type DesktopSessionContext,
  type DesktopLoginResult,
  type SyncStatusInfo,
  type LocalPatientRecord,
} from "./desktop/desktop-bridge";
import {
  Activity,
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Building2,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleUserRound,
  ClipboardList,
  Cloud,
  Download,
  Edit3,
  Eye,
  EyeOff,
  ExternalLink,
  FileText,
  HeartPulse,
  Image as ImageIcon,
  IndianRupee,
  KeyRound,
  LayoutDashboard,
  LockKeyhole,
  LogOut,
  Mail,
  Menu,
  MessageCircle,
  Moon,
  MoreHorizontal,
  Paperclip,
  PencilLine,
  Phone,
  Pill,
  Plus,
  Printer,
  RefreshCw,
  ReceiptIndianRupee,
  RotateCcw,
  Search,
  Settings,
  ShieldCheck,
  Stethoscope,
  Sun,
  Trash2,
  Upload,
  UserRound,
  UserRoundPlus,
  Users,
  WifiOff,
  X,
} from "lucide-react";

type Page =
  | "login"
  | "register"
  | "setup"
  | "dashboard"
  | "patients"
  | "patient-form"
  | "patient-profile"
  | "consultation"
  | "preview"
  | "bill-form"
  | "bill-preview"
  | "settings";

type Patient = {
  id: string;
  name: string;
  initials: string;
  age: number;
  gender: string;
  phone: string;
  lastVisit: string;
  allergies: string[];
  conditions: string[];
  dateOfBirth?: string;
  alternatePhone?: string;
  address?: string;
};

type Medicine = {
  id: number;
  name: string;
  formulation: string;
  strength: string;
  dose: string;
  route: string;
  frequency: string;
  duration: string;
  food: string;
  directions: string;
};

type Vitals = {
  systolic: string;
  diastolic: string;
  heartRate: string;
  spo2: string;
  temperature: string;
  height: string;
  weight: string;
};

type ConsultationData = {
  date: string;
  time: string;
  chiefComplaint: string;
  symptomDuration: string;
  diagnosis: string;
  medicines: Medicine[];
  followUpDate: string;
  followUpInstructions: string;
};

type BillItem = {
  id: number;
  description: string;
  quantity: number;
  rate: number;
};

type BillData = {
  invoiceNumber: string;
  date: string;
  paymentStatus: "Unpaid" | "Paid";
  discount: number;
  items: BillItem[];
};

type BillLayoutPreferences = {
  showBanner: boolean;
  showClinicLogo: boolean;
  showClinicEmail: boolean;
  showSignature: boolean;
  showPaymentNote: boolean;
};

const initialPatients: Patient[] = [
  { id: "PC-1048", name: "Ananya Iyer", initials: "AI", age: 34, gender: "Female", phone: "+91 98765 43210", lastVisit: "Today, 10:30 AM", allergies: ["Penicillin"], conditions: ["Seasonal allergic rhinitis"] },
  { id: "PC-1047", name: "Vikram Mehta", initials: "VM", age: 52, gender: "Male", phone: "+91 98204 11882", lastVisit: "24 Jun 2025", allergies: [], conditions: ["Hypertension"] },
  { id: "PC-1046", name: "Sana Kapoor", initials: "SK", age: 28, gender: "Female", phone: "+91 99876 22109", lastVisit: "22 Jun 2025", allergies: ["Sulfonamides"], conditions: [] },
  { id: "PC-1045", name: "Rohan Shah", initials: "RS", age: 41, gender: "Male", phone: "+91 98921 88276", lastVisit: "18 Jun 2025", allergies: [], conditions: ["Type 2 diabetes"] },
  { id: "PC-1044", name: "Meera Nair", initials: "MN", age: 66, gender: "Female", phone: "+91 97694 33721", lastVisit: "15 Jun 2025", allergies: [], conditions: ["Osteoarthritis"] },
];

function mapLocalRecordToPatient(rec: LocalPatientRecord): Patient {
  const name = rec.name || "Unnamed Patient";
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase() || "PT";
  return {
    id: rec.id,
    name,
    initials,
    age: rec.age ?? 0,
    gender: rec.gender || "Other",
    phone: rec.phone || "",
    lastVisit: "No visits yet",
    allergies: Array.isArray(rec.allergies) ? rec.allergies : [],
    conditions: Array.isArray(rec.conditions) ? rec.conditions : [],
    dateOfBirth: rec.date_of_birth || undefined,
  };
}

const emptyMedicine = (id: number): Medicine => ({
  id,
  name: "",
  formulation: "",
  strength: "",
  dose: "",
  route: "",
  frequency: "",
  duration: "",
  food: "",
  directions: "",
});

const createEmptyConsultationData = (): ConsultationData => ({
  date: "2025-07-01",
  time: "11:20",
  chiefComplaint: "",
  symptomDuration: "",
  diagnosis: "",
  medicines: [],
  followUpDate: "",
  followUpInstructions: "",
});

const getDoseConfig = (formulation: string) => {
  switch (formulation) {
    case "Tablet":
      return { unit: "tablet(s)", step: "0.5", placeholder: "0" };
    case "Capsule":
      return { unit: "capsule(s)", step: "1", placeholder: "0" };
    case "Syrup":
    case "Suspension":
    case "Injection":
      return { unit: "mL", step: "0.5", placeholder: "0" };
    case "Cream":
    case "Ointment":
      return { unit: "application(s)", step: "1", placeholder: "0" };
    case "Drops":
      return { unit: "drop(s)", step: "1", placeholder: "0" };
    case "Inhaler":
      return { unit: "puff(s)", step: "1", placeholder: "0" };
    default:
      return { unit: "unit(s)", step: "0.5", placeholder: "0" };
  }
};

const formatMedicineDose = (dose: string, formulation: string) => {
  if (!dose) return "";
  return /[a-zA-Z]/.test(dose) ? dose : `${dose} ${getDoseConfig(formulation).unit}`;
};

const oralFormulations = new Set(["Tablet", "Capsule", "Syrup", "Suspension"]);
const topicalFormulations = new Set(["Cream", "Ointment"]);

const medicineOptions = [
  "Amlodipine",
  "Amoxicillin",
  "Azithromycin",
  "Cetirizine",
  "Ibuprofen",
  "Levocetirizine",
  "Metformin",
  "Pantoprazole",
  "Paracetamol",
];
const complaintOptions = ["Fever", "Cough", "Headache", "Abdominal pain", "Breathing difficulty", "Body ache", "Follow-up / review"];
const symptomDurationOptions = ["Less than 24 hours", "1–3 days", "4–7 days", "1–2 weeks", "2–4 weeks", "More than 1 month"];
const diagnosisOptions = ["Upper respiratory tract infection", "Viral fever", "Hypertension", "Type 2 diabetes mellitus", "Allergic rhinitis", "Gastritis", "Migraine"];

type ClinicalLibraryCategory = "Medicines" | "Formulations" | "Strengths" | "Doses" | "Durations";
type ClinicalMedicineDefinition = {
  name: string;
  formulation: string;
  strength: string;
};
type ClinicalLibrary = Record<ClinicalLibraryCategory, string[]> & {
  MedicineDefinitions: ClinicalMedicineDefinition[];
};
const clinicalLibraryCategories: ClinicalLibraryCategory[] = ["Medicines", "Formulations", "Strengths", "Doses", "Durations"];

const defaultClinicalLibrary: ClinicalLibrary = {
  Medicines: medicineOptions,
  Formulations: ["Tablet", "Capsule", "Syrup", "Suspension", "Injection", "Cream", "Ointment", "Drops", "Inhaler"],
  Strengths: ["2.5 mg", "5 mg", "10 mg", "20 mg", "40 mg", "100 mg", "250 mg", "500 mg", "650 mg", "1 g"],
  Doses: ["½ tablet", "1 tablet", "2 tablets", "1 capsule", "5 mL", "10 mL", "1 puff", "2 puffs"],
  Durations: ["1 day", "3 days", "5 days", "7 days", "10 days", "14 days", "30 days", "Until review"],
  MedicineDefinitions: [],
};

const loadClinicalLibrary = () => {
  try {
    const saved = JSON.parse(window.localStorage.getItem("cliniqo-clinical-library") || "{}") as Partial<ClinicalLibrary>;
    return { ...defaultClinicalLibrary, ...saved };
  } catch {
    return defaultClinicalLibrary;
  }
};

const cn = (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(" ");

function Button({
  children,
  variant = "primary",
  size = "md",
  icon: Icon,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  icon?: ComponentType<{ size?: number; strokeWidth?: number }>;
}) {
  return (
    <button
      className={cn("btn", `btn-${variant}`, size === "sm" && "btn-sm", className)}
      {...props}
    >
      {Icon && <Icon size={size === "sm" ? 15 : 17} strokeWidth={2} />}
      {children}
    </button>
  );
}

function IconButton({ label, children, className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return <button className={cn("icon-btn", className)} aria-label={label} title={label} {...props}>{children}</button>;
}

function Field({
  label,
  required,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  error?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("field", className)}>
      <span className="field-label">{label}{required && <span className="required"> *</span>}</span>
      {children}
      {(error || hint) && <span className={cn("field-hint", error && "error-text")}>{error || hint}</span>}
    </label>
  );
}

function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className="input" {...props} />;
}

function SelectInput(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className="input select-input" {...props} />;
}

function SearchableOptionSelect({ id, value, options, onChange, placeholder, ariaLabel, emptyMessage }: { id: string; value: string; options: string[]; onChange: (value: string) => void; placeholder: string; ariaLabel: string; emptyMessage: string }) {
  const [open, setOpen] = useState(false);
  const listId = `searchable-options-${id}`;
  const filteredOptions = [...new Set(options)].filter((option) => option.toLowerCase().includes(value.toLowerCase()));
  const selectOption = (option: string) => {
    onChange(option);
    setOpen(false);
  };

  return (
    <div className="medicine-combobox">
      <div className="medicine-search-input">
        <Search size={15} />
        <input
          value={value}
          role="combobox"
          aria-label={ariaLabel}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          autoComplete="off"
          placeholder={placeholder}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onChange={(event) => {
            onChange(event.target.value);
            setOpen(true);
          }}
        />
        <ChevronDown size={15} />
      </div>
      {open && (
        <div className="medicine-options" id={listId} role="listbox">
          {filteredOptions.length > 0 ? filteredOptions.map((option) => (
            <button key={option} type="button" role="option" aria-selected={value === option} onMouseDown={(event) => event.preventDefault()} onClick={() => selectOption(option)}>
              <span>{option}</span>
              {value === option && <Check size={15} />}
            </button>
          )) : <div className="medicine-no-results">{emptyMessage}</div>}
        </div>
      )}
    </div>
  );
}

function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className="input textarea" {...props} />;
}

function StatusPill({ tone = "neutral", children }: { tone?: "success" | "warning" | "danger" | "info" | "neutral"; children: ReactNode }) {
  return <span className={cn("status-pill", `status-${tone}`)}>{children}</span>;
}

function Modal({ title, description, onClose, children, width = "medium" }: { title: string; description?: string; onClose: () => void; children: ReactNode; width?: "small" | "medium" }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={cn("modal", width === "small" && "modal-small")} role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div className="modal-head">
          <div>
            <h2 id="modal-title">{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <IconButton label="Close dialog" onClick={onClose}><X size={19} /></IconButton>
        </div>
        {children}
      </section>
    </div>
  );
}

function Logo({ large = false }: { large?: boolean }) {
  return (
    <div className={cn("logo-lockup", large && "logo-large")}>
      <span className="logo-mark"><HeartPulse size={large ? 24 : 20} strokeWidth={2.25} /></span>
      <span><strong>Cliniqo</strong><small>Doctor workspace</small></span>
    </div>
  );
}

function Login({
  go,
  onLoginSuccess,
}: {
  go: (page: Page) => void;
  onLoginSuccess?: (session: DesktopSessionContext) => void;
}) {
  const [view, setView] = useState<"login" | "forgot" | "otp" | "reset" | "success">("login");
  const [email, setEmail] = useState("nikhil@nishtihospital.in");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [otp, setOtp] = useState(["", "", "", "", "", ""]);
  const [authState, setAuthState] = useState<"idle" | "loading" | "sending" | "verifying" | "invalid" | "expired" | "network" | "limit">("idle");
  const [countdown, setCountdown] = useState(30);
  const [resendCount, setResendCount] = useState(0);
  const otpRefs = useRef<Array<HTMLInputElement | null>>([]);
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const [emailName = "", emailDomain = ""] = email.split("@");
  const maskedEmail = emailName && emailDomain
    ? `${emailName.slice(0, 2)}${"•".repeat(Math.max(3, emailName.length - 2))}@${emailDomain}`
    : email;

  useEffect(() => {
    if (view !== "otp" || countdown <= 0) return;
    const timer = window.setInterval(() => setCountdown((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [view, countdown]);

  const signIn = async (event: FormEvent) => {
    event.preventDefault();
    const nextErrors: Record<string, string> = {};
    if (!emailPattern.test(email)) nextErrors.email = "Enter a valid email address";
    if (!password) nextErrors.password = "Enter your password";
    else if (password.length < 8) nextErrors.password = "Password must be at least 8 characters";
    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors);
      return;
    }

    if (isTauriDesktop()) {
      try {
        setAuthState("loading");
        const loginRes = await loginDesktop(email, password);

        if (!loginRes) {
          setAuthState("idle");
          setErrors({ form: "Cryptographic session verification or clinic resolution failed." });
          return;
        }

        setAuthState("idle");
        if (onLoginSuccess) {
          onLoginSuccess(loginRes.session);
        } else {
          go("dashboard");
        }
        return;
      } catch (err: any) {
        setAuthState("idle");
        setErrors({ form: err?.message || "Invalid email or password." });
        return;
      }
    }

    if (password === "wrongpass") {
      setErrors({ form: "The email or password you entered is incorrect." });
      return;
    }
    setErrors({});
    setAuthState("loading");
    window.setTimeout(() => go("dashboard"), 850);
  };

  const requestReset = (event: FormEvent) => {
    event.preventDefault();
    if (!emailPattern.test(email)) {
      setErrors({ email: "Enter the email address linked to your account" });
      return;
    }
    setErrors({});
    setAuthState("sending");
    window.setTimeout(() => {
      setView("otp");
      setAuthState("idle");
      setCountdown(30);
      window.setTimeout(() => otpRefs.current[0]?.focus(), 80);
    }, 800);
  };

  const updateOtpDigit = (index: number, value: string) => {
    const digit = value.replace(/\D/g, "").slice(-1);
    setOtp((current) => current.map((item, itemIndex) => itemIndex === index ? digit : item));
    setAuthState("idle");
    if (digit && index < 5) otpRefs.current[index + 1]?.focus();
  };

  const verifyOtp = (event: FormEvent) => {
    event.preventDefault();
    const code = otp.join("");
    if (code.length !== 6) {
      setAuthState("invalid");
      return;
    }
    if (countdown === 0 || code === "111111") {
      setAuthState("expired");
      return;
    }
    if (code === "222222") {
      setAuthState("network");
      return;
    }
    if (code === "333333") {
      setAuthState("limit");
      return;
    }
    if (code !== "123456") {
      setAuthState("invalid");
      return;
    }
    setAuthState("verifying");
    window.setTimeout(() => {
      setView("reset");
      setAuthState("idle");
    }, 700);
  };

  const resendOtp = () => {
    if (countdown > 0 || authState === "sending") return;
    if (resendCount >= 2) {
      setAuthState("limit");
      return;
    }
    setAuthState("sending");
    setOtp(["", "", "", "", "", ""]);
    window.setTimeout(() => {
      setResendCount((count) => count + 1);
      setCountdown(30);
      setAuthState("idle");
      otpRefs.current[0]?.focus();
    }, 700);
  };

  const backToEmail = () => {
    setView("forgot");
    setOtp(["", "", "", "", "", ""]);
    setAuthState("idle");
    setCountdown(30);
  };

  const resetPassword = (event: FormEvent) => {
    event.preventDefault();
    const nextErrors: Record<string, string> = {};
    if (newPassword.length < 8) nextErrors.newPassword = "Use at least 8 characters";
    else if (!/[A-Z]/.test(newPassword) || !/\d/.test(newPassword)) nextErrors.newPassword = "Include an uppercase letter and a number";
    if (!confirmPassword) nextErrors.confirmPassword = "Confirm your new password";
    else if (newPassword !== confirmPassword) nextErrors.confirmPassword = "Passwords do not match";
    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors);
      return;
    }
    setErrors({});
    setAuthState("loading");
    window.setTimeout(() => {
      setView("success");
      setAuthState("idle");
    }, 850);
  };

  const returnToSignIn = () => {
    setView("login");
    setPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setErrors({});
    setAuthState("idle");
  };

  const otpMessage = {
    invalid: "That code is not valid. Check all six digits and try again.",
    expired: "This code has expired. Request a new code to continue.",
    network: "We couldn’t verify the code. Check your connection and try again.",
    limit: "Resend limit reached. Please wait before requesting another code.",
  }[authState as "invalid" | "expired" | "network" | "limit"];

  return (
    <main className="auth-page">
      <section className="auth-brand-panel">
        <Logo large />
        <div className="auth-message">
          <span className="eyebrow">Designed for independent practice</span>
          <h1>Clinical care,<br />beautifully organized.</h1>
          <p>One calm, secure workspace for patient records, consultations, prescriptions, and everyday clinic operations.</p>
          <div className="auth-feature-grid">
            <span><ShieldCheck size={18} /><strong>Private by design</strong><small>Protected clinical workspace</small></span>
            <span><WifiOff size={18} /><strong>Offline-ready</strong><small>Continue through interruptions</small></span>
            <span><FileText size={18} /><strong>Revision-safe</strong><small>Preserve finalized records</small></span>
          </div>
        </div>
        <div className="trust-row">
          <span><ShieldCheck size={16} /> Secure clinic workspace</span>
          <span><LockKeyhole size={16} /> Doctor-only access</span>
        </div>
      </section>
      <section className="auth-form-panel">
        <div className="login-card">
          <div className="auth-card-logo"><Logo /></div>
          {view === "login" && (
            <>
              <span className="eyebrow">Doctor-only access</span>
              <h2>Welcome back</h2>
              <p>Sign in with your registered clinic email to continue to your secure workspace.</p>
              {errors.form && <div className="auth-error" role="alert"><AlertCircle size={16} /><span>{errors.form}</span></div>}
              <form className="auth-form" onSubmit={signIn} noValidate>
                <label className="auth-field">
                  <span>Email address</span>
                  <div className={cn("auth-input-wrap", errors.email && "invalid")}>
                    <Mail size={17} />
                    <input type="email" autoComplete="email" value={email} onChange={(event) => { setEmail(event.target.value); setErrors({}); }} placeholder="doctor@clinic.com" aria-invalid={Boolean(errors.email)} />
                  </div>
                  {errors.email && <small className="auth-field-error">{errors.email}</small>}
                </label>
                <label className="auth-field">
                  <span className="auth-label-row"><span>Password</span><button type="button" onClick={() => { setView("forgot"); setErrors({}); }}>Forgot password?</button></span>
                  <div className={cn("auth-input-wrap", errors.password && "invalid")}>
                    <LockKeyhole size={17} />
                    <input type="password" autoComplete="current-password" value={password} onChange={(event) => { setPassword(event.target.value); setErrors({}); }} placeholder="Enter your password" aria-invalid={Boolean(errors.password)} />
                  </div>
                  {errors.password && <small className="auth-field-error">{errors.password}</small>}
                </label>
                <Button type="submit" className="auth-submit" disabled={authState === "loading"}>{authState === "loading" ? <><RefreshCw className="spin" size={17} /> Signing in…</> : <>Sign In <ArrowRight size={17} /></>}</Button>
              </form>
              <div className="auth-switch"><span>New to Cliniqo?</span><button type="button" onClick={() => go("register")}>Create account</button></div>
              <p className="privacy-note"><ShieldCheck size={14} /> Your session is protected with secure, doctor-only authentication.</p>
            </>
          )}
          {view === "forgot" && (
            <>
              <button className="auth-back" type="button" onClick={returnToSignIn}><ArrowLeft size={15} /> Back to sign in</button>
              <span className="eyebrow">Account recovery</span>
              <h2>Forgot your password?</h2>
              <p>Enter your registered email and we’ll send a 6-digit verification code.</p>
              <form className="auth-form" onSubmit={requestReset} noValidate>
                <label className="auth-field">
                  <span>Email address</span>
                  <div className={cn("auth-input-wrap", errors.email && "invalid")}>
                    <Mail size={17} />
                    <input type="email" autoComplete="email" value={email} onChange={(event) => { setEmail(event.target.value); setErrors({}); }} placeholder="doctor@clinic.com" aria-invalid={Boolean(errors.email)} />
                  </div>
                  {errors.email && <small className="auth-field-error">{errors.email}</small>}
                </label>
                <Button type="submit" className="auth-submit" disabled={authState === "sending"}>{authState === "sending" ? <><RefreshCw className="spin" size={17} /> Sending code…</> : <>Send verification code <ArrowRight size={17} /></>}</Button>
              </form>
              <p className="privacy-note"><Mail size={14} /> For this prototype, no email is actually sent.</p>
            </>
          )}
          {view === "otp" && (
            <>
              <button className="auth-back" type="button" onClick={backToEmail}><ArrowLeft size={15} /> Change email</button>
              <span className="eyebrow">Email verification</span>
              <h2>Check your email</h2>
              <p>Enter the 6-digit code sent to <strong>{maskedEmail}</strong>.</p>
              {otpMessage && <div className="auth-error" role="alert"><AlertCircle size={16} /><span>{otpMessage}</span></div>}
              <form className="auth-form otp-form" onSubmit={verifyOtp}>
                <div className="otp-group" onPaste={(event) => { const digits = event.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6).split(""); if (digits.length) { event.preventDefault(); setOtp(Array.from({ length: 6 }, (_, index) => digits[index] || "")); setAuthState("idle"); otpRefs.current[Math.min(digits.length, 6) - 1]?.focus(); } }}>
                  {otp.map((digit, index) => <input key={index} ref={(element) => { otpRefs.current[index] = element; }} value={digit} onChange={(event) => updateOtpDigit(index, event.target.value)} onKeyDown={(event) => { if (event.key === "Backspace" && !digit && index > 0) otpRefs.current[index - 1]?.focus(); }} inputMode="numeric" autoComplete={index === 0 ? "one-time-code" : "off"} maxLength={1} aria-label={`Verification code digit ${index + 1}`} className={cn(["invalid", "expired", "network", "limit"].includes(authState) && "invalid")} />)}
                </div>
                <div className="otp-actions">
                  <span>{countdown > 0 ? `Resend available in 00:${String(countdown).padStart(2, "0")}` : "Didn’t receive the code?"}</span>
                  <button type="button" onClick={resendOtp} disabled={countdown > 0 || authState === "sending"}>{authState === "sending" ? "Sending…" : "Resend code"}</button>
                </div>
                <Button type="submit" className="auth-submit" disabled={authState === "verifying" || authState === "sending"}>{authState === "verifying" ? <><RefreshCw className="spin" size={17} /> Verifying…</> : "Verify code"}</Button>
              </form>
              <div className="prototype-codes"><strong>Prototype states</strong><span>123456 success · 000000 invalid · 111111 expired · 222222 network · 333333 resend limit</span></div>
            </>
          )}
          {view === "reset" && (
            <>
              <span className="eyebrow">Create new password</span>
              <h2>Reset your password</h2>
              <p>Choose a strong password you haven’t used for this account before.</p>
              <form className="auth-form" onSubmit={resetPassword} noValidate>
                <label className="auth-field">
                  <span>New password</span>
                  <div className={cn("auth-input-wrap", errors.newPassword && "invalid")}>
                    <KeyRound size={17} />
                    <input type={showNewPassword ? "text" : "password"} autoComplete="new-password" value={newPassword} onChange={(event) => { setNewPassword(event.target.value); setErrors({}); }} placeholder="At least 8 characters" aria-invalid={Boolean(errors.newPassword)} />
                    <IconButton type="button" label={showNewPassword ? "Hide password" : "Show password"} onClick={() => setShowNewPassword((visible) => !visible)}>{showNewPassword ? <EyeOff size={17} /> : <Eye size={17} />}</IconButton>
                  </div>
                  {errors.newPassword ? <small className="auth-field-error">{errors.newPassword}</small> : <small className="auth-field-help">Use 8+ characters with an uppercase letter and a number.</small>}
                </label>
                <label className="auth-field">
                  <span>Confirm new password</span>
                  <div className={cn("auth-input-wrap", errors.confirmPassword && "invalid")}>
                    <LockKeyhole size={17} />
                    <input type={showNewPassword ? "text" : "password"} autoComplete="new-password" value={confirmPassword} onChange={(event) => { setConfirmPassword(event.target.value); setErrors({}); }} placeholder="Re-enter your new password" aria-invalid={Boolean(errors.confirmPassword)} />
                  </div>
                  {errors.confirmPassword && <small className="auth-field-error">{errors.confirmPassword}</small>}
                </label>
                <Button type="submit" className="auth-submit" disabled={authState === "loading"}>{authState === "loading" ? <><RefreshCw className="spin" size={17} /> Updating password…</> : "Reset password"}</Button>
              </form>
            </>
          )}
          {view === "success" && <div className="auth-success" role="status"><span><Check size={26} /></span><h2>Password reset</h2><p>Your password has been updated successfully.<br />You can now sign in with your new password.</p><Button className="auth-success-button" onClick={returnToSignIn}>Back to Sign In <ArrowRight size={16} /></Button></div>}
        </div>
        <p className="auth-footer">Secure doctor access · Terms of Use · Privacy Policy</p>
      </section>
    </main>
  );
}

function Register({ go }: { go: (page: Page) => void }) {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [mobile, setMobile] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "duplicate" | "failure">("idle");
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const passwordChecks = [
    password.length >= 8,
    /[A-Z]/.test(password) && /[a-z]/.test(password),
    /\d/.test(password),
  ];
  const passwordScore = passwordChecks.filter(Boolean).length;
  const passwordStrength = passwordScore <= 1 ? "Weak" : passwordScore === 2 ? "Good" : "Strong";

  const clearFieldError = (field: string) => {
    setErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
    if (status === "duplicate" || status === "failure") setStatus("idle");
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const nextErrors: Record<string, string> = {};
    if (!fullName.trim()) nextErrors.fullName = "Enter your full name";
    else if (fullName.trim().length < 3) nextErrors.fullName = "Full name must be at least 3 characters";
    if (!emailPattern.test(email)) nextErrors.email = "Enter a valid professional email";
    if (mobile.length !== 10) nextErrors.mobile = "Enter a valid 10-digit mobile number";
    if (!passwordChecks.every(Boolean)) nextErrors.password = "Use 8+ characters with uppercase, lowercase, and a number";
    if (!confirmPassword) nextErrors.confirmPassword = "Confirm your password";
    else if (confirmPassword !== password) nextErrors.confirmPassword = "Passwords do not match";
    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors);
      return;
    }

    setErrors({});
    setStatus("loading");
    window.setTimeout(() => {
      const normalizedEmail = email.trim().toLowerCase();
      if (normalizedEmail === "nikhil@nishtihospital.in" || normalizedEmail === "duplicate@cliniqo.demo") setStatus("duplicate");
      else if (normalizedEmail === "error@demo.test") setStatus("failure");
      else setStatus("success");
    }, 900);
  };

  return (
    <main className="auth-page">
      <section className="auth-brand-panel">
        <Logo large />
        <div className="auth-message">
          <span className="eyebrow">Start your doctor workspace</span>
          <h1>Your clinic,<br />set up with care.</h1>
          <p>Create the doctor profile used for your workspace, then add the clinic details shown on patient documents.</p>
          <div className="auth-feature-grid">
            <span><ShieldCheck size={18} /><strong>Doctor-first</strong><small>Built around clinical workflows</small></span>
            <span><LockKeyhole size={18} /><strong>Private workspace</strong><small>Clinic access stays separated</small></span>
            <span><FileText size={18} /><strong>Ready to configure</strong><small>Continue into profile setup</small></span>
          </div>
        </div>
        <div className="trust-row">
          <span><ShieldCheck size={16} /> Secure account interface</span>
          <span><LockKeyhole size={16} /> Frontend demo only</span>
        </div>
      </section>
      <section className="auth-form-panel register-panel">
        <div className="login-card register-card">
          <div className="auth-card-logo"><Logo /></div>
          {status === "success" ? (
            <div className="auth-success register-success" role="status">
              <span><Check size={26} /></span>
              <h2>Registration UI complete</h2>
              <p>Your details passed the local demo validation. No account was created and no email or SMS verification occurred.</p>
              <Button className="auth-success-button" onClick={() => go("setup")}>Continue to profile setup <ArrowRight size={16} /></Button>
              <button className="auth-text-link" type="button" onClick={() => go("login")}>Return to Sign In</button>
            </div>
          ) : (
            <>
              <span className="eyebrow">Register new user</span>
              <h2>Create your account</h2>
              <p>Enter your professional details to continue to doctor and clinic setup.</p>
              {(status === "duplicate" || status === "failure") && <div className="auth-error" role="alert"><AlertCircle size={16} /><span>{status === "duplicate" ? "An account already exists for this email. Sign in or use a different address." : "The demo registration request could not be completed. Review your details and try again."}</span></div>}
              <form className="auth-form register-form" onSubmit={submit} noValidate>
                <label className="auth-field">
                  <span>Full name</span>
                  <div className={cn("auth-input-wrap", errors.fullName && "invalid")}><UserRound size={17} /><input autoComplete="name" value={fullName} onChange={(event) => { setFullName(event.target.value); clearFieldError("fullName"); }} placeholder="Dr. Full name" aria-invalid={Boolean(errors.fullName)} /></div>
                  {errors.fullName && <small className="auth-field-error">{errors.fullName}</small>}
                </label>
                <label className="auth-field">
                  <span>Professional email</span>
                  <div className={cn("auth-input-wrap", errors.email && "invalid")}><Mail size={17} /><input type="email" autoComplete="email" value={email} onChange={(event) => { setEmail(event.target.value); clearFieldError("email"); }} placeholder="doctor@clinic.com" aria-invalid={Boolean(errors.email)} /></div>
                  {errors.email && <small className="auth-field-error">{errors.email}</small>}
                </label>
                <label className="auth-field">
                  <span>Mobile number</span>
                  <div className={cn("auth-input-wrap", errors.mobile && "invalid")}><Phone size={17} /><input type="tel" inputMode="numeric" autoComplete="tel-national" value={mobile} onChange={(event) => { setMobile(event.target.value.replace(/\D/g, "").slice(0, 10)); clearFieldError("mobile"); }} placeholder="10-digit mobile number" aria-invalid={Boolean(errors.mobile)} /></div>
                  {errors.mobile && <small className="auth-field-error">{errors.mobile}</small>}
                </label>
                <label className="auth-field">
                  <span>Password</span>
                  <div className={cn("auth-input-wrap", errors.password && "invalid")}><KeyRound size={17} /><input type={showPassword ? "text" : "password"} autoComplete="new-password" value={password} onChange={(event) => { setPassword(event.target.value); clearFieldError("password"); }} placeholder="Create a strong password" aria-invalid={Boolean(errors.password)} /><IconButton type="button" label={showPassword ? "Hide password" : "Show password"} onClick={() => setShowPassword((visible) => !visible)}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</IconButton></div>
                  {errors.password && <small className="auth-field-error">{errors.password}</small>}
                  {password && <div className={cn("password-strength", `strength-${passwordStrength.toLowerCase()}`)}><span><i /><i /><i /></span><small>{passwordStrength} · 8+ characters, upper/lowercase, and a number</small></div>}
                </label>
                <label className="auth-field">
                  <span>Confirm password</span>
                  <div className={cn("auth-input-wrap", errors.confirmPassword && "invalid")}><LockKeyhole size={17} /><input type={showConfirmPassword ? "text" : "password"} autoComplete="new-password" value={confirmPassword} onChange={(event) => { setConfirmPassword(event.target.value); clearFieldError("confirmPassword"); }} placeholder="Re-enter your password" aria-invalid={Boolean(errors.confirmPassword)} /><IconButton type="button" label={showConfirmPassword ? "Hide password" : "Show password"} onClick={() => setShowConfirmPassword((visible) => !visible)}>{showConfirmPassword ? <EyeOff size={17} /> : <Eye size={17} />}</IconButton></div>
                  {errors.confirmPassword && <small className="auth-field-error">{errors.confirmPassword}</small>}
                </label>
                <Button type="submit" className="auth-submit" disabled={status === "loading"}>{status === "loading" ? <><RefreshCw className="spin" size={17} /> Validating details…</> : <>Create account <ArrowRight size={17} /></>}</Button>
              </form>
              <div className="auth-switch"><span>Already have an account?</span><button type="button" onClick={() => go("login")}>Sign In</button></div>
              <div className="prototype-codes register-demo-note"><strong>Frontend demo states</strong><span>Existing account email → duplicate · error@demo.test → failure · other valid details → success UI. No account or verification is created.</span></div>
            </>
          )}
        </div>
        <p className="auth-footer">Frontend registration demo · No backend connection</p>
      </section>
    </main>
  );
}

function Setup({ go }: { go: (page: Page) => void }) {
  const [step, setStep] = useState(1);
  const [error, setError] = useState(false);
  const next = (event: FormEvent) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    if (!form.checkValidity()) {
      setError(true);
      form.reportValidity();
      return;
    }
    if (step < 2) setStep(2);
    else go("dashboard");
  };

  return (
    <main className="setup-page">
      <header className="setup-header">
        <Logo />
        <span>Step {step} of 2</span>
      </header>
      <div className="setup-wrap">
        <div className="setup-progress"><span className="complete" /><span className={step === 2 ? "complete" : ""} /></div>
        <div className="setup-title">
          <span className="eyebrow">Workspace setup</span>
          <h1>{step === 1 ? "Tell us about you" : "Set up your clinic"}</h1>
          <p>{step === 1 ? "These details will appear on prescriptions and patient records." : "Add the information patients should see on your prescription."}</p>
        </div>
        <form className="setup-card" onSubmit={next}>
          {step === 1 ? (
            <>
              <div className="photo-upload">
                <span className="photo-placeholder"><UserRound size={28} /></span>
                <div><strong>Profile photo</strong><p>PNG or JPG, up to 2 MB</p></div>
                <Button type="button" variant="secondary" size="sm" icon={Upload} onClick={() => window.alert("Profile photo picker opened in the production application.")}>Upload photo</Button>
              </div>
              <div className="form-grid two">
                <Field label="Full name" required error={error ? "Enter your full name" : undefined}><TextInput required defaultValue="Dr. Nikhil Kanade" placeholder="Dr. Full name" /></Field>
                <Field label="Gender" required><SelectInput id="setup-gender-select" required defaultValue="Male"><option>Female</option><option>Male</option><option>Non-binary</option><option>Prefer not to say</option></SelectInput></Field>
                <Field label="Qualifications" required><TextInput required defaultValue="MBBS, MD (Internal Medicine)" placeholder="e.g. MBBS, MD" /></Field>
                <Field label="Medical registration number" required><TextInput required defaultValue="MMC 2011/04/1842" placeholder="Registration number" /></Field>
                <Field label="Mobile number" required><TextInput required defaultValue="+91 98200 76421" type="tel" /></Field>
                <Field label="Professional email" required><TextInput required defaultValue="nikhil@nishtihospital.in" type="email" /></Field>
              </div>
            </>
          ) : (
            <>
              <div className="photo-upload">
                <span className="clinic-logo-placeholder"><Building2 size={24} /></span>
                <div><strong>Clinic logo <em>Optional</em></strong><p>Used on printed prescriptions</p></div>
                <Button type="button" variant="secondary" size="sm" icon={Upload} onClick={() => window.alert("Clinic logo picker opened in the production application.")}>Upload logo</Button>
              </div>
              <div className="form-grid two">
                <Field label="Clinic or hospital name" required><TextInput required defaultValue="Nishti Hospital" /></Field>
                <Field label="Clinic phone" required><TextInput required defaultValue="+91 22 4123 8765" type="tel" /></Field>
                <Field label="Address" required className="full"><TextInput required defaultValue="14, Sea View Road, Bandra West" /></Field>
                <Field label="City" required><TextInput required defaultValue="Mumbai" /></Field>
                <Field label="Postal code" required><TextInput required defaultValue="400050" /></Field>
                <Field label="Google Maps location" hint="Optional"><TextInput placeholder="Paste location link" /></Field>
                <Field label="Clinic email" hint="Optional"><TextInput defaultValue="care@harbourclinic.in" type="email" /></Field>
              </div>
            </>
          )}
          <div className="form-actions split">
            {step === 1 ? <Button type="button" variant="ghost" icon={ArrowLeft} onClick={() => go("login")}>Back</Button> : <Button type="button" variant="ghost" icon={ArrowLeft} onClick={() => setStep(1)}>Back</Button>}
            <Button type="submit">{step === 1 ? "Continue" : "Save and continue"}<ArrowRight size={16} /></Button>
          </div>
        </form>
        <p className="secure-note"><ShieldCheck size={15} /> You can update these details any time in Settings.</p>
      </div>
    </main>
  );
}

function Sidebar({
  page,
  go,
  collapsed,
  onToggle,
  onDoctorProfile,
  desktopSession,
}: {
  page: Page;
  go: (page: Page) => void;
  collapsed: boolean;
  onToggle: () => void;
  onDoctorProfile: () => void;
  desktopSession?: DesktopSessionContext | null;
}) {
  const nav = [
    { id: "dashboard" as Page, label: "Dashboard", icon: LayoutDashboard },
    { id: "patients" as Page, label: "Patients", icon: Users },
    { id: "settings" as Page, label: "Settings", icon: Settings },
  ];
  return (
    <aside className="sidebar">
      <button className="sidebar-logo" aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} title={collapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={onToggle}><Logo /></button>
      {!collapsed && <IconButton className="sidebar-close" label="Collapse sidebar" onClick={onToggle}><X size={17} /></IconButton>}
      <nav aria-label="Main navigation">
        {nav.map((item) => (
          <button key={item.id} className={cn("nav-item", (page === item.id || (item.id === "patients" && ["patient-form", "patient-profile", "consultation", "preview", "bill-form", "bill-preview"].includes(page))) && "active")} onClick={() => go(item.id)}>
            <item.icon size={18} /><span>{item.label}</span>
          </button>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <div className="doctor-card">
          <span className="avatar">
            {desktopSession?.doctor_name
              ? desktopSession.doctor_name
                  .split(" ")
                  .map((n) => n[0])
                  .slice(0, 2)
                  .join("")
                  .toUpperCase()
              : "NK"}
          </span>
          <button onClick={onDoctorProfile}>
            <strong>{desktopSession?.doctor_name || "Dr. Nikhil Kanade"}</strong>
            <small>{desktopSession ? `Clinic: ${desktopSession.clinic_id}` : "Nishti Hospital"}</small>
          </button>
        </div>
      </div>
    </aside>
  );
}

function AppHeader({ title, subtitle, children, onMenu }: { title: string; subtitle?: string; children?: ReactNode; onMenu?: () => void }) {
  return (
    <header className="app-header">
      <div className="page-heading">
        {onMenu && <IconButton label="Open navigation" onClick={onMenu} className="mobile-menu"><Menu size={20} /></IconButton>}
        <div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>
      </div>
      <div className="header-actions">
        {children}
      </div>
    </header>
  );
}

function Dashboard({ go, patients, onOpenPatient }: { go: (page: Page) => void; patients: Patient[]; onOpenPatient: (patient: Patient) => void }) {
  const seenToday = patients.filter((patient) => patient.lastVisit.toLowerCase().startsWith("today")).length;
  const allergyRecords = patients.filter((patient) => patient.allergies.length > 0).length;
  const recordedConditions = patients.reduce((total, patient) => total + patient.conditions.length, 0);
  return (
    <>
      <AppHeader title="Good morning, Dr. Nikhil" subtitle="Tuesday, 01 July 2025">
        <IconButton label="Find patient" onClick={() => go("patients")}><Search size={18} /></IconButton>
        <Button icon={UserRoundPlus} onClick={() => go("patient-form")}>Add patient</Button>
      </AppHeader>
      <div className="page-content dashboard-page">
        <section className="stat-grid" aria-label="Clinic statistics">
          {[
            { label: "Patient records", value: String(patients.length), note: "Current local session", icon: Users },
            { label: "Seen today", value: String(seenToday), note: "From recorded last visits", icon: CalendarDays },
            { label: "Allergy records", value: String(allergyRecords), note: "Require clinical review", icon: AlertCircle },
            { label: "Recorded conditions", value: String(recordedConditions), note: "Across current patients", icon: Stethoscope },
          ].map((stat) => (
            <article className="stat-item" key={stat.label}>
              <div className="stat-icon"><stat.icon size={19} /></div>
              <div><span>{stat.label}</span><strong>{stat.value}</strong><small>{stat.note}</small></div>
            </article>
          ))}
        </section>

        <div className="dashboard-columns">
          <section className="panel">
            <div className="panel-head"><div><h2>Recent consultations</h2><p>Today’s patient activity</p></div><button className="text-btn" onClick={() => go("patients")}>View all <ChevronRight size={15} /></button></div>
            <div className="consultation-list">
              {patients.filter((patient) => patient.lastVisit !== "No visits yet").slice(0, 4).map((patient) => (
                <button className="consultation-row" key={patient.id} onClick={() => onOpenPatient(patient)}>
                  <span className="avatar subtle">{patient.initials}</span>
                  <span className="patient-cell"><strong>{patient.name}</strong><small>{patient.id} · {patient.age} yrs</small></span>
                  <span className="visit-reason">Recorded visit</span>
                  <StatusPill tone="neutral">Local record</StatusPill>
                  <span className="time">{patient.lastVisit}</span>
                  <ChevronRight size={17} />
                </button>
              ))}
            </div>
          </section>
          <div className="side-stack">
            <section className="panel action-panel">
              <div className="panel-head"><div><h2>Quick actions</h2><p>Common daily tasks</p></div></div>
              <button onClick={() => go("patient-form")}><span><UserRoundPlus size={19} /></span><div><strong>Add a new patient</strong><small>Create a patient record</small></div><ChevronRight size={17} /></button>
              <button onClick={() => go("patients")}><span><Search size={19} /></span><div><strong>Find a patient</strong><small>Search records and visits</small></div><ChevronRight size={17} /></button>
            </section>
            <section className="panel delivery-panel">
              <div className="panel-head"><div><h2>WhatsApp delivery</h2><p>Provider connection not configured</p></div><MessageCircle size={19} /></div>
              <div className="delivery-counts">
                <div><strong>—</strong><span><i className="dot success" /> Delivered</span></div>
                <div><strong>—</strong><span><i className="dot warning" /> Queued</span></div>
                <div><strong>—</strong><span><i className="dot danger" /> Failed</span></div>
              </div>
              <button className="failure-row" onClick={() => go("settings")}><AlertCircle size={16} /><span>View messaging configuration</span><ChevronRight size={16} /></button>
            </section>
          </div>
        </div>
      </div>
    </>
  );
}

function PatientsPage({
  go,
  patients,
  onOpenPatient,
  onStartConsultation,
  onCreateBill,
  onEditPatient,
  onDeletePatient,
}: {
  go: (page: Page) => void;
  patients: Patient[];
  onOpenPatient: (patient: Patient) => void;
  onStartConsultation: (patient: Patient) => void;
  onCreateBill: (patient: Patient) => void;
  onEditPatient: (patient: Patient) => void;
  onDeletePatient?: (patientId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [gender, setGender] = useState("All patients");
  const [sort, setSort] = useState("Recent visit");
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 5;
  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const matches = patients.filter((patient) => `${patient.name} ${patient.id} ${patient.phone}`.toLowerCase().includes(normalizedQuery) && (gender === "All patients" || patient.gender === gender));
    if (sort === "Name A–Z") return [...matches].sort((a, b) => a.name.localeCompare(b.name));
    if (sort === "Newest added") return [...matches].sort((a, b) => Number(b.id.replace(/\D/g, "")) - Number(a.id.replace(/\D/g, "")));
    return matches;
  }, [patients, query, gender, sort]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.min(currentPage, totalPages);
  const visiblePatients = filtered.slice((page - 1) * pageSize, page * pageSize);
  useEffect(() => setCurrentPage(1), [query, gender, sort]);

  return (
    <>
      <AppHeader title="Patients" subtitle={`${patients.length} patient records in this prototype`}>
        <IconButton className="topbar-back" label="Back to dashboard" onClick={() => go("dashboard")}><ArrowLeft size={18} /></IconButton>
        <Button icon={UserRoundPlus} onClick={() => go("patient-form")}>Add patient</Button>
      </AppHeader>
      <div className="page-content">
        <section className="patients-toolbar">
          <div className="search-box"><Search size={18} /><input aria-label="Search patients" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name, patient ID, or phone" />{query && <IconButton label="Clear search" onClick={() => setQuery("")}><X size={16} /></IconButton>}</div>
          <SelectInput aria-label="Filter patients" value={gender} onChange={(e) => setGender(e.target.value)}><option>All patients</option><option>Female</option><option>Male</option></SelectInput>
          <SelectInput aria-label="Sort patients" value={sort} onChange={(e) => setSort(e.target.value)}><option>Recent visit</option><option>Name A–Z</option><option>Newest added</option></SelectInput>
        </section>
        <section className="table-panel">
          {filtered.length ? (
            <div className="table-wrap">
              <table>
                <caption className="sr-only">Patient records matching the current search, filter, and sort</caption>
                <thead><tr><th>Patient</th><th>Patient ID</th><th>Age / Gender</th><th>Mobile</th><th>Last visit</th><th><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  {visiblePatients.map((patient) => (
                    <tr key={patient.id}>
                      <td><button className="patient-name" onClick={() => onOpenPatient(patient)}><span className="avatar subtle">{patient.initials}</span><span><strong>{patient.name}</strong>{patient.allergies.length > 0 && <small className="allergy-mini"><AlertCircle size={12} /> Allergy recorded</small>}</span></button></td>
                      <td><span className="mono-id">{patient.id}</span></td>
                      <td>{patient.age} yrs <span className="muted">· {patient.gender}</span></td>
                      <td>{patient.phone}</td>
                      <td>{patient.lastVisit}</td>
                      <td><div className="row-actions"><Button size="sm" variant="secondary" icon={ReceiptIndianRupee} onClick={() => onCreateBill(patient)}>Bill</Button><Button size="sm" variant="secondary" onClick={() => onStartConsultation(patient)}>Start consultation</Button><IconButton label={`Edit ${patient.name}`} onClick={() => onEditPatient(patient)}><PencilLine size={16} /></IconButton>{onDeletePatient && <IconButton label={`Delete ${patient.name}`} onClick={() => { if (window.confirm(`Delete patient ${patient.name}?`)) onDeletePatient(patient.id); }}><Trash2 size={16} /></IconButton>}<IconButton label={`More actions for ${patient.name}`} onClick={() => onOpenPatient(patient)}><MoreHorizontal size={18} /></IconButton></div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty-state"><Search size={28} /><h2>No patients found</h2><p>Try a different name, ID, phone number, or filter.</p><Button variant="secondary" onClick={() => { setQuery(""); setGender("All patients"); }}>Clear filters</Button></div>
          )}
          <div className="table-footer"><span role="status" aria-live="polite">Showing {filtered.length ? (page - 1) * pageSize + 1 : 0}–{Math.min(page * pageSize, filtered.length)} of {filtered.length} matching patients</span><div><Button size="sm" variant="ghost" disabled={page === 1} onClick={() => setCurrentPage((value) => Math.max(1, value - 1))}>Previous</Button><span className="page-number" aria-label={`Page ${page} of ${totalPages}`}>{page}</span><Button size="sm" variant="ghost" disabled={page === totalPages} onClick={() => setCurrentPage((value) => Math.min(totalPages, value + 1))}>Next</Button></div></div>
        </section>
      </div>
    </>
  );
}

function PatientForm({ go, onSave, onReviewPatient, patient, patients, nextPatientId }: { go: (page: Page) => void; onSave: (patient: Patient, startConsultation?: boolean) => void; onReviewPatient: (patient: Patient) => void; patient: Patient | null; patients: Patient[]; nextPatientId: string }) {
  const [submitted, setSubmitted] = useState(false);
  const [name, setName] = useState(patient?.name || "");
  const [phone, setPhone] = useState(patient?.phone || "");
  const [dirty, setDirty] = useState(false);
  const editing = Boolean(patient);
  const normalizedPhone = phone.replace(/\D/g, "").slice(-10);
  const duplicatePatient = useMemo(() => normalizedPhone.length === 10 ? patients.find((record) => record.id !== patient?.id && record.phone.replace(/\D/g, "").slice(-10) === normalizedPhone) : undefined, [normalizedPhone, patient?.id, patients]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const leave = () => {
    if (!dirty || window.confirm("Discard unsaved patient changes?")) go("patients");
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    setSubmitted(true);
    if (!form.checkValidity() || !name.trim() || normalizedPhone.length !== 10) return form.reportValidity();
    if (!duplicatePatient) {
      const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
      const data = new FormData(form);
      const submittedName = name.trim();
      const allergyText = String(data.get("allergies") || "");
      const conditionText = String(data.get("conditions") || "");
      onSave({
        id: patient?.id || nextPatientId,
        name: submittedName,
        initials: submittedName.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase(),
        age: Number(data.get("age")),
        gender: String(data.get("gender")),
        phone: String(data.get("phone")),
        lastVisit: patient?.lastVisit || "No visits yet",
        allergies: allergyText.split(",").map((item) => item.trim()).filter(Boolean),
        conditions: conditionText.split(",").map((item) => item.trim()).filter(Boolean),
        dateOfBirth: String(data.get("dateOfBirth") || ""),
        alternatePhone: String(data.get("alternatePhone") || ""),
        address: String(data.get("address") || ""),
      }, submitter?.value === "consultation");
      setDirty(false);
    }
  };
  return (
    <>
      <AppHeader title={editing ? "Edit patient" : "Add new patient"} subtitle={editing ? `Update ${patient?.name} without changing their patient ID or clinical history` : "Create a separate demographic record before starting a consultation"}>
        <IconButton className="topbar-back" label="Back to patients" onClick={leave}><ArrowLeft size={18} /></IconButton>
        <Button type="submit" form="patient-form">{editing ? "Save changes" : "Save patient"}</Button>
        <Button type="submit" form="patient-form" value="consultation" icon={Stethoscope}>Save & start consultation</Button>
      </AppHeader>
      <form id="patient-form" className="page-content form-page" onSubmit={submit} onChange={() => setDirty(true)}>
        <div className="form-main">
          {duplicatePatient && <div className="duplicate-warning" role="alert"><AlertCircle size={20} /><div><strong>Existing patient with this mobile number</strong><p>{duplicatePatient.name} · {duplicatePatient.id} · {duplicatePatient.phone}</p></div><Button type="button" size="sm" variant="secondary" onClick={() => onReviewPatient(duplicatePatient)}>Review record</Button></div>}
          <FormSection icon={UserRound} title="Personal details" description="Core patient demographics">
            <div className="form-grid three">
              <Field label="Full name" required error={submitted && !name.trim() ? "Full name is required" : undefined} className="span-two"><TextInput name="name" required value={name} onChange={(event) => setName(event.target.value)} placeholder="Enter patient's full name" /></Field>
              <Field label="Patient ID" hint={editing ? "Patient ID cannot be changed" : "Generated automatically"}><TextInput value={patient?.id || nextPatientId} readOnly /></Field>
              <Field label="Date of birth"><TextInput name="dateOfBirth" type="date" defaultValue={patient?.dateOfBirth || ""} /></Field>
              <Field label="Age" required><TextInput name="age" required type="number" defaultValue={patient?.age} placeholder="Years" min="0" max="120" /></Field>
              <Field label="Gender" required><SelectInput name="gender" required defaultValue={patient?.gender || ""} style={{ height: "40px" }}><option value="" disabled>Select gender</option><option>Female</option><option>Male</option><option>Non-binary</option><option>Prefer not to say</option></SelectInput></Field>
              <Field label="Mobile number" required error={submitted && normalizedPhone.length !== 10 ? "Enter a valid 10-digit mobile number" : undefined} className="span-two"><TextInput name="phone" required type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 00000 00000" /></Field>
              <Field label="Alternate phone" hint="Optional"><TextInput name="alternatePhone" type="tel" defaultValue={patient?.alternatePhone || ""} placeholder="+91 00000 00000" /></Field>
              <Field label="Address" hint="Optional" className="full"><TextArea name="address" rows={2} defaultValue={patient?.address || ""} placeholder="House / street, locality, city, postal code" /></Field>
            </div>
          </FormSection>
          <FormSection icon={Activity} title="Clinical background" description="Long-term details that apply across visits">
            <div className="form-grid two">
              <Field label="Known allergies"><TextArea name="allergies" rows={3} defaultValue={patient?.allergies.join(", ") || ""} placeholder="e.g. Drug, food, or environmental allergies" /></Field>
              <Field label="Medical conditions"><TextArea name="conditions" rows={3} defaultValue={patient?.conditions.join(", ") || ""} placeholder="Existing or chronic conditions" /></Field>
            </div>
          </FormSection>
          <div className="patient-form-actions">
            <div><strong>{editing ? "Ready to save changes?" : "Ready to continue?"}</strong><p>{editing ? "The existing record will be updated while visit and prescription history stays preserved." : "Save the patient record, then choose whether to open their first consultation now."}</p></div>
            <Button type="submit" variant="secondary" value="profile">{editing ? "Save changes" : "Save patient"}</Button>
            <Button type="submit" value="consultation" icon={Stethoscope}>{editing ? "Save & start consultation" : "Save & start consultation"}</Button>
          </div>
        </div>
        <aside className="form-aside">
          <div className="aside-tip"><ShieldCheck size={19} /><h3>Patient record integrity</h3><p>Demographics are stored separately from consultation notes. Finalized visits and prescriptions are preserved as immutable history.</p></div>
          <div className="aside-tip"><Cloud size={19} /><h3>Local session status</h3><p>{editing ? "Patient updates remain in this browser session. A backend is required for durable synchronization." : "New patient records remain in this browser session. A backend is required for durable synchronization."}</p><StatusPill tone="warning">Not persisted</StatusPill></div>
        </aside>
      </form>
    </>
  );
}

function FormSection({ icon: Icon, title, description, children }: { icon: ComponentType<{ size?: number }>; title: string; description: string; children: ReactNode }) {
  return (
    <section className="form-section">
      <div className="form-section-head"><span><Icon size={18} /></span><div><h2>{title}</h2><p>{description}</p></div></div>
      {children}
    </section>
  );
}

function PatientProfile({
  go,
  patient,
  saveFeedback,
  onDeletePatient,
}: {
  go: (page: Page) => void;
  patient: Patient;
  saveFeedback: "added" | "updated" | null;
  onDeletePatient?: (patientId: string) => void;
}) {
  const [tab, setTab] = useState("Overview");
  const allergyLabel = patient.allergies.join(", ");
  const hasHistory = patient.lastVisit !== "No visits yet";
  return (
    <>
      <AppHeader title="Patient profile" subtitle={`Patient ID ${patient.id}`}>
        <IconButton className="topbar-back" label="Back to patients" onClick={() => go("patients")}><ArrowLeft size={18} /></IconButton>
        <Button variant="secondary" icon={Edit3} onClick={() => go("patient-form")}>Edit patient</Button>
        <Button icon={Stethoscope} onClick={() => go("consultation")}>Start consultation</Button>
        {onDeletePatient && (
          <Button
            variant="ghost"
            onClick={() => {
              if (window.confirm(`Are you sure you want to delete patient ${patient.name}?`)) {
                onDeletePatient(patient.id);
              }
            }}
          >
            <Trash2 size={16} /> Delete
          </Button>
        )}
      </AppHeader>
      <div className="page-content profile-page">
        {saveFeedback && <div className="success-banner" role="status" aria-live="polite"><CheckCircle2 size={19} /><div><strong>{saveFeedback === "added" ? "Patient added successfully." : "Patient changes saved."}</strong><span>{saveFeedback === "added" ? "The local patient record is ready for this session." : "The existing local record was updated without changing its patient ID."}</span></div></div>}
        <section className="patient-hero">
          <div className="patient-identity"><span className="profile-avatar">{patient.initials}</span><div><h2>{patient.name}</h2><p>{patient.age} years · {patient.gender} · {patient.id}</p><span className="last-seen"><CalendarDays size={14} /> {patient.lastVisit === "No visits yet" ? "No consultations yet" : `Last visit ${patient.lastVisit.toLowerCase()}`}</span></div></div>
          <div className="contact-grid"><span><Phone size={16} /><small>Mobile</small><strong>{patient.phone}</strong></span><span><UserRound size={16} /><small>Patient ID</small><strong>{patient.id}</strong></span></div>
        </section>
        {patient.allergies.length > 0 && <div className="allergy-alert"><AlertCircle size={20} /><div><strong>Allergy alert: {allergyLabel}</strong><p>Review and confirm with the patient before prescribing.</p></div></div>}
        <div className="tabs" role="tablist">
          {["Overview", "Medical History", "Consultations", "Prescriptions"].map((item) => <button key={item} role="tab" aria-selected={tab === item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item}{item === "Consultations" && <span>{hasHistory ? 8 : 0}</span>}{item === "Prescriptions" && <span>{hasHistory ? 7 : 0}</span>}</button>)}
        </div>
        {tab === "Overview" && <OverviewTab go={go} patient={patient} hasHistory={hasHistory} />}
        {tab === "Medical History" && <HistoryTab patient={patient} />}
        {tab === "Consultations" && <ConsultationsTab go={go} hasHistory={hasHistory} />}
        {tab === "Prescriptions" && <PrescriptionsTab go={go} hasHistory={hasHistory} />}
      </div>
    </>
  );
}

function OverviewTab({ go, patient, hasHistory }: { go: (page: Page) => void; patient: Patient; hasHistory: boolean }) {
  return <div className="profile-grid">
    <section className="panel detail-panel"><div className="panel-head"><div><h2>Patient details</h2><p>Demographic information</p></div><button className="text-btn" onClick={() => go("patient-form")}>Edit</button></div><dl className="details-list"><div><dt>Age</dt><dd>{patient.age} years</dd></div><div><dt>Gender</dt><dd>{patient.gender}</dd></div><div><dt>Phone</dt><dd>{patient.phone}</dd></div><div><dt>Patient ID</dt><dd>{patient.id}</dd></div><div className="wide"><dt>Consultation status</dt><dd>{hasHistory ? patient.lastVisit : "No consultations recorded"}</dd></div></dl></section>
    <section className="panel detail-panel"><div className="panel-head"><div><h2>Clinical background</h2><p>Persistent across consultations</p></div></div><div className="clinical-item"><span>Known allergies</span><strong className={patient.allergies.length > 0 ? "danger-text" : ""}>{patient.allergies.join(", ") || "None recorded"}</strong></div><div className="clinical-item"><span>Medical conditions</span><strong>{patient.conditions.join(", ") || "None recorded"}</strong></div><div className="clinical-item"><span>Current medicines</span><strong>None recorded</strong></div><div className="clinical-item"><span>Family history</span><strong>No significant history recorded</strong></div></section>
    <section className="panel timeline-panel"><div className="panel-head"><div><h2>Recent clinical activity</h2><p>Consultations and prescriptions</p></div><button className="text-btn" onClick={() => go("consultation")}>New consultation</button></div>
      {hasHistory ? [["01 Jul 2025", "Consultation draft", "Clinical notes saved · Not finalized"], ["12 Mar 2025", "Consultation finalized", "Prescription revision 1 · Delivered"], ["18 Nov 2024", "Consultation finalized", "Printed at clinic"]].map((entry, index) => <div className="timeline-row" key={entry[0]}><span className={cn("timeline-icon", index === 0 && "draft")}><FileText size={16} /></span><div><strong>{entry[1]}</strong><p>{entry[2]}</p></div><time>{entry[0]}</time>{index === 0 ? <Button size="sm" variant="secondary" onClick={() => go("consultation")}>Resume</Button> : <Button size="sm" variant="secondary" onClick={() => go("preview")}>Review</Button>}</div>) : <div className="empty-state compact"><ClipboardList size={25} /><h2>No clinical activity yet</h2><p>Start the first consultation when the patient is ready.</p><Button icon={Stethoscope} onClick={() => go("consultation")}>Start consultation</Button></div>}
    </section>
  </div>;
}

function HistoryTab({ patient }: { patient: Patient }) {
  return <section className="panel history-layout"><div className="history-block"><h2>Medical history</h2><p>{patient.conditions.join(", ") || "No medical conditions recorded."}</p></div><div className="history-block"><h2>Family history</h2><p>No significant family history recorded.</p></div><div className="history-block"><h2>Current medicines</h2><p>No current long-term medicines recorded.</p></div><div className="history-block"><h2>Allergy record</h2><p>{patient.allergies.length > 0 ? patient.allergies.map((allergy) => <StatusPill key={allergy} tone="danger">{allergy}</StatusPill>) : "No known allergies recorded."}</p>{patient.allergies.length > 0 && <small>Reaction details not recorded. Confirm with patient before prescribing.</small>}</div></section>;
}

function ConsultationsTab({ go, hasHistory }: { go: (page: Page) => void; hasHistory: boolean }) {
  return <section className="panel record-list"><div className="panel-head"><div><h2>Consultation history</h2><p>Finalized visits cannot be overwritten</p></div><Button size="sm" onClick={() => go("consultation")} icon={Plus}>New consultation</Button></div>{hasHistory ? [["01 Jul 2025", "Draft", "Follow-up visit"], ["12 Mar 2025", "Finalized", "New consultation"], ["18 Nov 2024", "Finalized", "Routine consultation"]].map((r) => <button key={r[0]} onClick={() => go(r[1] === "Draft" ? "consultation" : "preview")}><span className="record-icon"><ClipboardList size={18} /></span><span><strong>{r[2]}</strong><small>Dr. Nikhil Kanade · {r[0]}</small></span><StatusPill tone={r[1] === "Draft" ? "warning" : "success"}>{r[1]}</StatusPill><ChevronRight size={17} /></button>) : <div className="empty-state compact"><ClipboardList size={25} /><h2>No consultations yet</h2><p>New consultations will be preserved here.</p></div>}</section>;
}

function PrescriptionsTab({ go, hasHistory }: { go: (page: Page) => void; hasHistory: boolean }) {
  return <section className="panel record-list"><div className="panel-head"><div><h2>Prescription history</h2><p>Finalized records and tracked revisions</p></div></div>{hasHistory ? [["12 Mar 2025", "Revision 1", "Delivered"], ["18 Nov 2024", "Original", "Printed"], ["03 Jul 2024", "Original", "Delivered"]].map((r) => <button key={r[0]} onClick={() => go("preview")}><span className="record-icon"><FileText size={18} /></span><span><strong>Prescription · {r[1]}</strong><small>Finalized {r[0]}</small></span><StatusPill tone="success">{r[2]}</StatusPill><ChevronRight size={17} /></button>) : <div className="empty-state compact"><FileText size={25} /><h2>No prescriptions yet</h2><p>Finalized prescriptions and revisions will appear here.</p></div>}</section>;
}

function Consultation({
  go,
  patient,
  clinicalLibrary,
  vitals,
  onVitalsChange,
  data,
  onDataChange,
  desktopSession,
}: {
  go: (page: Page) => void;
  patient: Patient;
  clinicalLibrary: ClinicalLibrary;
  vitals: Vitals;
  onVitalsChange: (key: keyof Vitals, value: string) => void;
  data: ConsultationData;
  onDataChange: (data: ConsultationData) => void;
  desktopSession?: DesktopSessionContext | null;
}) {
  const [saved, setSaved] = useState(false);
  const [showFinalize, setShowFinalize] = useState(false);
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [complaintPreset, setComplaintPreset] = useState("");
  const [durationPreset, setDurationPreset] = useState("");
  const [diagnosisPreset, setDiagnosisPreset] = useState("");
  const updateData = (updates: Partial<ConsultationData>) => onDataChange({ ...data, ...updates });
  const consultationComplete = Boolean(data.chiefComplaint.trim() && data.diagnosis.trim());
  const updateMedicine = (id: number, key: keyof Medicine, value: string) => updateData({ medicines: data.medicines.map((row) => row.id === id ? { ...row, [key]: value } : row) });
  const addMedicine = () => updateData({ medicines: [...data.medicines, emptyMedicine(Math.max(...data.medicines.map((row) => row.id), 0) + 1)] });
  const removeMedicine = (id: number) => updateData({ medicines: data.medicines.filter((row) => row.id !== id) });

  const handleFinalize = async () => {
    if (isTauriDesktop() && desktopSession?.clinic_id) {
      setIsFinalizing(true);
      try {
        const consultationId = await saveLocalConsultation({
          clinic_id: desktopSession.clinic_id,
          patient_id: patient.id,
          consultation_date: data.date,
          chief_complaint: data.chiefComplaint,
          diagnosis: data.diagnosis,
          clinical_snapshot_json: JSON.stringify({
            vitals,
            symptomDuration: data.symptomDuration,
            followUpDate: data.followUpDate,
            followUpInstructions: data.followUpInstructions,
          }),
        });

        if (consultationId && data.medicines.length > 0) {
          const rxNumber = `RX-${Date.now().toString().slice(-6)}`;
          await saveLocalPrescription({
            clinic_id: desktopSession.clinic_id,
            consultation_id: consultationId,
            patient_id: patient.id,
            prescription_number: rxNumber,
            items_json: JSON.stringify(data.medicines),
          });
        }
      } catch (err) {
        console.error("[Cliniqo Desktop] Failed to save consultation/prescription to SQLite:", err);
      } finally {
        setIsFinalizing(false);
      }
    }
    setShowFinalize(false);
    go("preview");
  };
  return (
    <>
      <AppHeader title="New consultation" subtitle={`${patient.name} · ${patient.id}`}>
        <IconButton className="topbar-back" label="Back to patient profile" onClick={() => go("patient-profile")}><ArrowLeft size={18} /></IconButton>
        <Button variant="secondary" aria-live="polite" onClick={() => { setSaved(true); window.setTimeout(() => setSaved(false), 1800); }}>{saved ? <><Check size={16} /> Session draft updated</> : "Update local draft"}</Button>
        <Button className="consultation-finalize-action" aria-label="Finalize prescription" disabled={!consultationComplete} onClick={() => setShowFinalize(true)}>Finalize prescription</Button>
      </AppHeader>
      <div className="consultation-shell">
        <main className="consultation-main">
          <div className="patient-strip"><span className="avatar">{patient.initials}</span><div><strong>{patient.name}</strong><small>{patient.age} years · {patient.gender} · {patient.id}</small></div>{patient.allergies.length > 0 && <span className="patient-allergy"><AlertCircle size={15} /> Allergy: {patient.allergies.join(", ")}</span>}<button onClick={() => go("patient-profile")}>View profile <ExternalLink size={14} /></button></div>
          <FormSection icon={CalendarDays} title="Consultation date and time" description="Recorded for this patient-linked visit">
            <div className="form-grid two">
              <Field label="Consultation date" required><TextInput type="date" required value={data.date} onChange={(event) => updateData({ date: event.target.value })} /></Field>
              <Field label="Consultation time" required><TextInput type="time" required value={data.time} onChange={(event) => updateData({ time: event.target.value })} /></Field>
            </div>
          </FormSection>
          <FormSection icon={Activity} title="Vitals" description="Record measurements for this visit">
            <div className="vitals-grid">
              <CompactField label="Blood pressure" suffix="mmHg" placeholder="120" secondaryPlaceholder="80" value={vitals.systolic} secondaryValue={vitals.diastolic} onChange={(value) => onVitalsChange("systolic", value)} onSecondaryChange={(value) => onVitalsChange("diastolic", value)} wide />
              <CompactField label="Heart rate" suffix="bpm" placeholder="72" value={vitals.heartRate} onChange={(value) => onVitalsChange("heartRate", value)} />
              <CompactField label="SpO₂" suffix="%" placeholder="98" value={vitals.spo2} onChange={(value) => onVitalsChange("spo2", value)} />
              <CompactField label="Temperature" suffix="°F" placeholder="98.6" value={vitals.temperature} onChange={(value) => onVitalsChange("temperature", value)} step="0.1" />
              <CompactField label="Height" suffix="cm" placeholder="165" value={vitals.height} onChange={(value) => onVitalsChange("height", value)} step="0.1" />
              <CompactField label="Weight" suffix="kg" placeholder="60" value={vitals.weight} onChange={(value) => onVitalsChange("weight", value)} step="0.1" />
            </div>
          </FormSection>
          <FormSection icon={Stethoscope} title="Clinical notes" description="Document findings for this consultation only">
            <div className="form-grid two">
              <Field label="Chief complaints" required><div className="field-stack"><SearchableOptionSelect id="chief-complaint" value={complaintPreset} options={complaintOptions} onChange={(value) => { setComplaintPreset(value); updateData({ chiefComplaint: value }); }} placeholder="Select or search a common complaint" ariaLabel="Search and select chief complaint" emptyMessage="No matching complaint. Continue typing to use a custom value." /><TextArea required rows={3} value={data.chiefComplaint} onChange={(event) => updateData({ chiefComplaint: event.target.value })} placeholder="Record the patient's primary concerns" /></div></Field>
              <Field label="Symptom duration"><div className="field-stack"><SearchableOptionSelect id="symptom-duration" value={durationPreset} options={symptomDurationOptions} onChange={(value) => { setDurationPreset(value); updateData({ symptomDuration: value }); }} placeholder="Select or search symptom duration" ariaLabel="Search and select symptom duration" emptyMessage="No matching duration. Continue typing to use a custom value." /><TextArea rows={3} value={data.symptomDuration} onChange={(event) => updateData({ symptomDuration: event.target.value })} placeholder="Duration, onset, and progression" /></div></Field>
              <Field label="Diagnosis" required><div className="field-stack"><SearchableOptionSelect id="diagnosis" value={diagnosisPreset} options={diagnosisOptions} onChange={(value) => { setDiagnosisPreset(value); updateData({ diagnosis: value }); }} placeholder="Select or search a diagnosis" ariaLabel="Search and select diagnosis" emptyMessage="No matching diagnosis. Continue typing to use a custom value." /><TextArea required rows={3} value={data.diagnosis} onChange={(event) => updateData({ diagnosis: event.target.value })} placeholder="Enter diagnosis after clinical assessment" /></div></Field>
            </div>
          </FormSection>
          <section className="form-section medicines-section">
            <div className="form-section-head medicines-head"><span><Pill size={18} /></span><div><h2>Medicines</h2><p>Add only after clinical review. No medicine or dose is prefilled.</p></div><Button size="sm" variant="secondary" icon={Plus} onClick={addMedicine}>Add medicine</Button></div>
            {data.medicines.length === 0 ? <div className="medicine-empty"><Pill size={22} /><p>No medicines added</p><Button size="sm" variant="secondary" icon={Plus} onClick={addMedicine}>Add medicine</Button></div> : data.medicines.map((medicine, index) => {
              const doseConfig = getDoseConfig(medicine.formulation);
              const strengthOptions = [...new Set([
                ...clinicalLibrary.Strengths,
                ...(["Syrup", "Suspension"].includes(medicine.formulation) ? ["125 mg/5 mL", "250 mg/5 mL"] : []),
              ])];
              const doseOptions = [...new Set([
                ...clinicalLibrary.Doses,
                ...(doseConfig.unit === "mL" ? ["2.5", "5", "10", "15"] : doseConfig.step === "0.5" ? ["0.5", "1", "1.5", "2"] : ["1", "2", "3", "4"]),
              ])];
              const frequencyOptions = ["Once daily", "Twice daily", "Three times daily", "Four times daily", "As needed"];
              return (
              <div className="medicine-row" key={medicine.id}>
                <div className="medicine-number">{index + 1}</div>
                <div className="medicine-fields">
                  <Field label="Formulation" hint={!medicine.formulation ? "Select a formulation to continue" : undefined} className={!medicine.formulation ? "med-formulation-first" : undefined}><SelectInput value={medicine.formulation} style={{ width: "100%", height: "40px" }} onChange={(event) => { const formulation = event.target.value; updateData({ medicines: data.medicines.map((row) => row.id === medicine.id ? { ...row, formulation, name: "", strength: "", dose: "", route: "", food: "", directions: "" } : row) }); }}><option value="">Select formulation</option>{clinicalLibrary.Formulations.map((option) => <option key={option}>{option}</option>)}</SelectInput></Field>
                  {medicine.formulation && <>
                    <Field label="Medicine name" required className="med-name"><SearchableOptionSelect id={`medicine-${medicine.id}`} value={medicine.name} options={[...new Set([...medicineOptions, ...clinicalLibrary.MedicineDefinitions.filter((item) => item.formulation === medicine.formulation).map((item) => item.name)])]} onChange={(value) => { updateMedicine(medicine.id, "name", value); const definition = clinicalLibrary.MedicineDefinitions.find((item) => item.name === value && item.formulation === medicine.formulation); if (definition) updateMedicine(medicine.id, "strength", definition.strength); }} placeholder="Search medicine" ariaLabel="Search and select medicine" emptyMessage="No matching medicine. Continue typing to use a custom name." /></Field>
                    <Field label="Strength"><SearchableOptionSelect id={`strength-${medicine.id}`} value={medicine.strength} options={strengthOptions} onChange={(value) => updateMedicine(medicine.id, "strength", value)} placeholder="Search strength" ariaLabel="Search and select strength" emptyMessage="No matching strength. Continue typing to use a custom value." /></Field>
                    <Field label="Dose" hint={`Unit: ${doseConfig.unit}`}><SearchableOptionSelect id={`dose-${medicine.id}`} value={medicine.dose} options={doseOptions} onChange={(value) => updateMedicine(medicine.id, "dose", value)} placeholder="Search dose" ariaLabel="Search and select dose" emptyMessage="No matching dose. Continue typing to use a custom value." /></Field>
                    <Field label="Frequency"><SearchableOptionSelect id={`frequency-${medicine.id}`} value={medicine.frequency} options={frequencyOptions} onChange={(value) => updateMedicine(medicine.id, "frequency", value)} placeholder="Search frequency" ariaLabel="Search and select frequency" emptyMessage="No matching frequency. Continue typing to use a custom value." /></Field>
                    <Field label="Duration"><SearchableOptionSelect id={`duration-${medicine.id}`} value={medicine.duration} options={clinicalLibrary.Durations} onChange={(value) => updateMedicine(medicine.id, "duration", value)} placeholder="Search duration" ariaLabel="Search and select duration" emptyMessage="No matching duration. Continue typing to use a custom value." /></Field>
                    {medicine.formulation === "Injection" && <Field label="Route"><SelectInput value={medicine.route} style={{ height: "40px" }} onChange={(e) => updateMedicine(medicine.id, "route", e.target.value)}><option value="">Select route</option><option>Intravenous (IV)</option><option>Intramuscular (IM)</option><option>Subcutaneous (SC)</option><option>Intradermal (ID)</option></SelectInput></Field>}
                    {oralFormulations.has(medicine.formulation) && <Field label="Food instruction"><SelectInput value={medicine.food} style={{ height: "40px" }} onChange={(e) => updateMedicine(medicine.id, "food", e.target.value)}><option value="">Select</option><option>Before food</option><option>After food</option><option>With food</option><option>Not applicable</option></SelectInput></Field>}
                    <Field label={topicalFormulations.has(medicine.formulation) ? "Application instructions" : "Additional directions"} className="med-directions"><TextInput value={medicine.directions} onChange={(e) => updateMedicine(medicine.id, "directions", e.target.value)} placeholder={topicalFormulations.has(medicine.formulation) ? "Site, amount, and method of application" : "Optional directions"} /></Field>
                  </>}
                </div>
                <IconButton label={`Remove medicine ${index + 1}`} onClick={() => removeMedicine(medicine.id)}><Trash2 size={17} /></IconButton>
              </div>
              );
            })}
            {data.medicines.length > 0 && <div className="medicine-add-footer"><Button size="sm" variant="secondary" icon={Plus} onClick={addMedicine}>Add another medicine</Button></div>}
          </section>
          <FormSection icon={CalendarDays} title="Follow-up" description="Plan the next step in care">
            <div className="form-grid two">
              <Field label="Follow-up date"><TextInput type="date" value={data.followUpDate} onChange={(event) => updateData({ followUpDate: event.target.value })} /></Field>
              <Field label="Follow-up instructions"><TextInput value={data.followUpInstructions} onChange={(event) => updateData({ followUpInstructions: event.target.value })} placeholder="Reason or tests to bring" /></Field>
            </div>
          </FormSection>
        </main>
      </div>
      {showFinalize && <Modal title="Finalize prescription?" description="Confirm that you have reviewed the diagnosis, medicines, doses, and instructions." onClose={() => setShowFinalize(false)}>
        <div className="review-checklist"><p><CheckCircle2 size={18} /> Patient and allergy details reviewed</p><p><CheckCircle2 size={18} /> Clinical notes and diagnosis reviewed</p><p><CheckCircle2 size={18} /> Medicines and directions reviewed</p></div>
        <div className="modal-warning">
          <LockKeyhole size={17} />
          <p>
            {isTauriDesktop() && desktopSession
              ? "Encrypted local SQLite storage and durable sync outbox are active for this clinic."
              : "This frontend can preview the finalized layout, but durable finalization and revision history require a backend."}
          </p>
        </div>
        <div className="modal-actions">
          <Button variant="ghost" onClick={() => setShowFinalize(false)}>Continue editing</Button>
          <Button onClick={handleFinalize} disabled={isFinalizing}>
            {isFinalizing ? "Saving to encrypted storage..." : "Finalize & view prescription"}
          </Button>
        </div>
      </Modal>}
    </>
  );
}

function CompactField({ label, suffix, placeholder, secondaryPlaceholder, value, secondaryValue = "", onChange, onSecondaryChange, step = "1", wide = false }: { label: string; suffix: string; placeholder: string; secondaryPlaceholder?: string; value: string; secondaryValue?: string; onChange: (value: string) => void; onSecondaryChange?: (value: string) => void; step?: string; wide?: boolean }) {
  return <label className={cn("compact-field", wide && "wide")}><span>{label}</span><div><input type="number" inputMode="decimal" min="0" step={step} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} aria-label={secondaryPlaceholder ? `${label} systolic` : label} />{secondaryPlaceholder && <><b>/</b><input type="number" inputMode="decimal" min="0" step="1" value={secondaryValue} onChange={(event) => onSecondaryChange?.(event.target.value)} placeholder={secondaryPlaceholder} aria-label={`${label} diastolic`} /></>}<em>{suffix}</em></div></label>;
}

function BillForm({ go, patient, bill, onChange }: { go: (page: Page) => void; patient: Patient; bill: BillData; onChange: (bill: BillData) => void }) {
  const subtotal = bill.items.reduce((total, item) => total + item.quantity * item.rate, 0);
  const total = Math.max(0, subtotal - bill.discount);
  const updateItem = (id: number, updates: Partial<BillItem>) => onChange({ ...bill, items: bill.items.map((item) => item.id === id ? { ...item, ...updates } : item) });
  const addItem = () => onChange({ ...bill, items: [...bill.items, { id: Date.now(), description: "", quantity: 1, rate: 0 }] });
  const removeItem = (id: number) => {
    if (bill.items.length === 1) return;
    onChange({ ...bill, items: bill.items.filter((item) => item.id !== id) });
  };
  const canPreview = bill.items.some((item) => item.description.trim() && item.rate > 0);

  return (
    <>
      <AppHeader title="Create bill" subtitle={`${patient.name} · ${patient.id}`}>
        <IconButton className="topbar-back" label="Back to patients" onClick={() => go("patients")}><ArrowLeft size={18} /></IconButton>
      </AppHeader>
      <div className="page-content billing-page">
        <div className="patient-strip"><span className="avatar subtle">{patient.initials}</span><div><strong>{patient.name}</strong><small>{patient.age} years · {patient.gender} · {patient.phone}</small></div><StatusPill tone="warning">Local draft</StatusPill></div>
        <FormSection icon={ReceiptIndianRupee} title="Bill details" description="Add services and charges for this patient">
          <div className="form-grid three bill-meta">
            <Field label="Invoice number"><TextInput value={bill.invoiceNumber} onChange={(event) => onChange({ ...bill, invoiceNumber: event.target.value })} /></Field>
            <Field label="Invoice date"><TextInput type="date" value={bill.date} onChange={(event) => onChange({ ...bill, date: event.target.value })} /></Field>
            <Field label="Payment status"><SelectInput value={bill.paymentStatus} onChange={(event) => onChange({ ...bill, paymentStatus: event.target.value as BillData["paymentStatus"] })}><option>Unpaid</option><option>Paid</option></SelectInput></Field>
          </div>
          <div className="bill-items-head"><span>Service or item</span><span>Qty</span><span>Rate</span><span>Amount</span><span /></div>
          <div className="bill-items">
            {bill.items.map((item) => (
              <div className="bill-item-row" key={item.id}>
                <TextInput aria-label="Service or item" value={item.description} onChange={(event) => updateItem(item.id, { description: event.target.value })} placeholder="e.g. Consultation fee" />
                <TextInput aria-label="Quantity" type="number" min="1" value={item.quantity} onChange={(event) => updateItem(item.id, { quantity: Math.max(1, Number(event.target.value)) })} />
                <div className="money-input"><IndianRupee size={14} /><input aria-label="Rate" type="number" min="0" value={item.rate || ""} onChange={(event) => updateItem(item.id, { rate: Math.max(0, Number(event.target.value)) })} placeholder="0" /></div>
                <strong>₹{(item.quantity * item.rate).toLocaleString("en-IN")}</strong>
                <IconButton label="Remove item" onClick={() => removeItem(item.id)} disabled={bill.items.length === 1}><Trash2 size={16} /></IconButton>
              </div>
            ))}
          </div>
          <Button size="sm" variant="secondary" icon={Plus} onClick={addItem}>Add item</Button>
          <div className="bill-summary">
            <div><span>Subtotal</span><strong>₹{subtotal.toLocaleString("en-IN")}</strong></div>
            <label><span>Discount</span><div className="money-input"><IndianRupee size={13} /><input aria-label="Discount" type="number" min="0" value={bill.discount || ""} onChange={(event) => onChange({ ...bill, discount: Math.max(0, Number(event.target.value)) })} placeholder="0" /></div></label>
            <div className="bill-total"><span>Total</span><strong>₹{total.toLocaleString("en-IN")}</strong></div>
          </div>
        </FormSection>
        <div className="patient-form-actions"><div><strong>Review local bill draft</strong><p>Browser printing is available. Saving, PDF generation, and WhatsApp delivery require backend services.</p></div><Button variant="ghost" onClick={() => go("patients")}>Cancel</Button><Button icon={ReceiptIndianRupee} disabled={!canPreview} onClick={() => go("bill-preview")}>Make bill</Button></div>
      </div>
    </>
  );
}

function BillPreview({ go, patient, bill, bannerImage, signatureImage, layout, returnPage }: { go: (page: Page) => void; patient: Patient; bill: BillData; bannerImage: { src: string; name: string } | null; signatureImage: { src: string; name: string } | null; layout: BillLayoutPreferences; returnPage: "bill-form" | "settings" }) {
  const [whatsapp, setWhatsapp] = useState(false);
  const [delivery, setDelivery] = useState<"confirm" | "sending" | "queued">("confirm");
  const subtotal = bill.items.reduce((total, item) => total + item.quantity * item.rate, 0);
  const total = Math.max(0, subtotal - bill.discount);
  const formattedDate = bill.date ? new Date(`${bill.date}T00:00:00`).toLocaleDateString("en-IN", { day: "2-digit", month: "long", year: "numeric" }) : "—";
  const sendBill = () => {
    setDelivery("sending");
    window.setTimeout(() => setDelivery("queued"), 900);
  };
  return (
    <>
      <AppHeader title="Bill preview" subtitle={`${bill.invoiceNumber} · ${bill.paymentStatus}`}>
        <IconButton className="topbar-back" label={returnPage === "settings" ? "Back to bill settings" : "Back to bill"} onClick={() => go(returnPage)}><ArrowLeft size={18} /></IconButton>
        <Button variant="secondary" icon={Printer} onClick={() => window.print()}>Print bill</Button>
        <Button icon={MessageCircle} onClick={() => { setDelivery("confirm"); setWhatsapp(true); }}>Preview WhatsApp flow</Button>
      </AppHeader>
      <div className="preview-page">
        <div className="preview-note bill-preview-note"><ReceiptIndianRupee size={17} /><span>Review the bill details before printing or sharing with the patient.</span><Button size="sm" variant="ghost" onClick={() => go("bill-form")} icon={Edit3}>Edit bill</Button></div>
        <article className="prescription-paper bill-paper" id="printable-bill">
          <div className={cn("rx-banner-slot", !layout.showBanner && "rx-content-hidden")}>
            {bannerImage ? <div className="rx-custom-banner"><img src={bannerImage.src} alt="Custom bill banner" /></div> : <header className="rx-header">
              <div className="rx-clinic"><span className={cn("rx-logo", !layout.showClinicLogo && "rx-content-hidden")}><HeartPulse size={24} /></span><div><h2>Nishti Hospital</h2><p>14, Sea View Road, Bandra West, Mumbai 400050</p><p>+91 22 4123 8765 · <span className={cn(!layout.showClinicEmail && "rx-content-hidden")}>care@harbourclinic.in</span></p></div></div>
              <div className="rx-doctor"><strong>Dr. Nikhil Kanade</strong><span>MBBS, MD (Internal Medicine)</span><span>Reg. No. MMC 2011/04/1842</span></div>
            </header>}
          </div>
          <div className="bill-title"><div><span>Tax invoice</span><h2>Patient bill</h2></div><StatusPill tone={bill.paymentStatus === "Paid" ? "success" : "warning"}>{bill.paymentStatus}</StatusPill></div>
          <section className="rx-patient"><div><span>Billed to</span><strong>{patient.name}</strong><small>{patient.age} years · {patient.gender} · {patient.phone}</small></div><div><span>Patient ID</span><strong>{patient.id}</strong></div><div><span>Invoice date</span><strong>{formattedDate}</strong></div></section>
          <section className="bill-document">
            <div className="bill-number"><span>Invoice number</span><strong>{bill.invoiceNumber}</strong></div>
            <table><thead><tr><th>Service or item</th><th>Qty</th><th>Rate</th><th>Amount</th></tr></thead><tbody>{bill.items.filter((item) => item.description.trim()).map((item) => <tr key={item.id}><td>{item.description}</td><td>{item.quantity}</td><td>₹{item.rate.toLocaleString("en-IN")}</td><td>₹{(item.quantity * item.rate).toLocaleString("en-IN")}</td></tr>)}</tbody></table>
            <div className="bill-document-totals"><div><span>Subtotal</span><strong>₹{subtotal.toLocaleString("en-IN")}</strong></div>{bill.discount > 0 && <div><span>Discount</span><strong>− ₹{bill.discount.toLocaleString("en-IN")}</strong></div>}<div className="grand-total"><span>Total amount</span><strong>₹{total.toLocaleString("en-IN")}</strong></div></div>
          </section>
          <section className={cn("bill-payment-note", !layout.showPaymentNote && "rx-content-hidden")}><strong>Payment status: {bill.paymentStatus}</strong><span>Thank you for choosing Nishti Hospital. Please retain this bill for your records.</span></section>
          <footer className="rx-footer bill-footer"><div><span>For Nishti Hospital</span><strong>Authorized medical services bill</strong></div><div className={cn("signature", !layout.showSignature && "rx-content-hidden")}>{signatureImage && <img src={signatureImage.src} alt="Dr. Nikhil Kanade’s signature" />}<span>Doctor’s signature</span><strong>Dr. Nikhil Kanade</strong></div></footer>
        </article>
      </div>
      {whatsapp && <Modal title="Bill WhatsApp flow preview" description="Frontend-only illustration; no message or PDF will be created." onClose={() => setWhatsapp(false)}>
        {delivery === "confirm" && <><div className="send-summary"><span className="avatar">{patient.initials}</span><div><small>Patient</small><strong>{patient.name}</strong><span>{patient.phone}</span></div></div><div className="document-row"><span><ReceiptIndianRupee size={20} /></span><div><strong>Bill · {bill.invoiceNumber}</strong><small>₹{total.toLocaleString("en-IN")} · Local preview only</small></div><Paperclip size={16} /></div><div className="delivery-disclaimer"><AlertCircle size={17} /><p>No API request is sent. Real queued and delivery states require a WhatsApp provider response.</p></div><div className="modal-actions"><Button variant="ghost" onClick={() => setWhatsapp(false)}>Cancel</Button><Button icon={MessageCircle} onClick={sendBill}>Preview queued state</Button></div></>}
        {delivery === "sending" && <div className="delivery-state"><span className="state-icon loading"><RefreshCw className="spin" size={25} /></span><h3>Preparing demo state…</h3><p>No external service is being contacted.</p></div>}
        {delivery === "queued" && <div className="delivery-state"><span className="state-icon success"><Check size={25} /></span><h3>Demo: bill queued</h3><p>This illustrates provider acceptance; no bill was sent.</p><div className="modal-actions"><Button onClick={() => setWhatsapp(false)}>Done</Button></div></div>}
      </Modal>}
    </>
  );
}

function PrescriptionPreview({ go, patient, vitals, data, bannerVisible, bannerImage, signatureImage, showClinicLogo, showClinicEmail, showAllergyWarning, returnPage }: { go: (page: Page) => void; patient: Patient; vitals: Vitals; data: ConsultationData; bannerVisible: boolean; bannerImage: { src: string; name: string } | null; signatureImage: { src: string; name: string } | null; showClinicLogo: boolean; showClinicEmail: boolean; showAllergyWarning: boolean; returnPage: "consultation" | "settings" }) {
  const [whatsapp, setWhatsapp] = useState(false);
  const [delivery, setDelivery] = useState<"confirm" | "sending" | "queued" | "failed">("confirm");
  const send = () => {
    setDelivery("sending");
    window.setTimeout(() => setDelivery("queued"), 1000);
  };
  return (
    <>
      <AppHeader title="Prescription preview" subtitle="Local session preview · Not persisted">
        <IconButton className="topbar-back" label={returnPage === "settings" ? "Back to prescription settings" : "Back to consultation"} onClick={() => go(returnPage)}><ArrowLeft size={18} /></IconButton>
        <Button variant="secondary" icon={Printer} onClick={() => window.print()}>Print prescription</Button>
        <Button icon={MessageCircle} onClick={() => { setDelivery("confirm"); setWhatsapp(true); }}>Send on WhatsApp</Button>
      </AppHeader>
      <div className="preview-page">
        <div className="preview-note"><AlertCircle size={17} /><span>This is a browser preview using current consultation data. Backend storage is required for finalization and revision history.</span><Button size="sm" variant="ghost" onClick={() => go("consultation")} icon={Edit3}>Edit consultation</Button></div>
        <article className="prescription-paper" id="printable-prescription">
          <div className={cn("rx-banner-slot", !bannerVisible && "rx-content-hidden")}>
            {bannerImage ? <div className="rx-custom-banner"><img src={bannerImage.src} alt="Custom prescription banner" /></div> : <header className="rx-header">
            <div className="rx-clinic"><span className={cn("rx-logo", !showClinicLogo && "rx-content-hidden")}><HeartPulse size={24} /></span><div><h2>Nishti Hospital</h2><p>14, Sea View Road, Bandra West, Mumbai 400050</p><p>+91 22 4123 8765 · <span className={cn(!showClinicEmail && "rx-content-hidden")}>care@harbourclinic.in</span></p></div></div>
            <div className="rx-doctor"><strong>Dr. Nikhil Kanade</strong><span>MBBS, MD (Internal Medicine)</span><span>Reg. No. MMC 2011/04/1842</span></div>
            </header>}
          </div>
          <section className="rx-patient">
            <div><span>Patient</span><strong>{patient.name}</strong><small>{patient.age} years · {patient.gender}</small></div>
            <div><span>Patient ID</span><strong>{patient.id}</strong></div>
            <div><span>Date</span><strong>{data.date || "—"}</strong></div>
          </section>
          <section className="rx-vitals">
            <span className="rx-section-label">Vitals</span>
            <div><span>Blood pressure</span><strong>{vitals.systolic && vitals.diastolic ? `${vitals.systolic}/${vitals.diastolic} mmHg` : "—"}</strong></div>
            <div><span>Heart rate</span><strong>{vitals.heartRate ? `${vitals.heartRate} bpm` : "—"}</strong></div>
            <div><span>SpO₂</span><strong>{vitals.spo2 ? `${vitals.spo2}%` : "—"}</strong></div>
            <div><span>Temperature</span><strong>{vitals.temperature ? `${vitals.temperature} °F` : "—"}</strong></div>
            <div><span>Height</span><strong>{vitals.height ? `${vitals.height} cm` : "—"}</strong></div>
            <div><span>Weight</span><strong>{vitals.weight ? `${vitals.weight} kg` : "—"}</strong></div>
          </section>
          <section className="rx-diagnosis"><span>Diagnosis</span><p>{data.diagnosis || "No diagnosis entered."}</p></section>
          <section className={cn("rx-medicines", data.medicines.length > 0 && "has-data")}>
            <div className="rx-symbol">℞</div>
            <table><thead><tr><th>Medicine</th><th>Dose & frequency</th><th>Duration</th><th>Instructions</th></tr></thead><tbody>{data.medicines.length > 0 ? data.medicines.map((medicine) => <tr key={medicine.id}><td><strong>{medicine.name || "Unnamed medicine"}</strong><br /><span>{[medicine.formulation, medicine.strength].filter(Boolean).join(" · ")}</span></td><td>{[formatMedicineDose(medicine.dose, medicine.formulation), medicine.frequency].filter(Boolean).join(" · ") || "—"}</td><td>{medicine.duration || "—"}</td><td>{[medicine.route, medicine.food, medicine.directions].filter(Boolean).join(" · ") || "—"}</td></tr>) : <tr><td colSpan={4}><div className="rx-empty"><strong>No medicines added.</strong><span>Medicine fields remain blank until entered by the doctor.</span></div></td></tr>}</tbody></table>
          </section>
          <section className="rx-instructions"><h3>Clinical summary</h3><p>{data.chiefComplaint || "No chief complaint entered."}{data.symptomDuration ? ` · Duration: ${data.symptomDuration}` : ""}</p><div><strong>Follow-up</strong><span>{[data.followUpDate, data.followUpInstructions].filter(Boolean).join(" · ") || "No follow-up entered."}</span></div></section>
          <footer className="rx-footer"><div className={cn(!showAllergyWarning && "rx-content-hidden")}>{patient.allergies.length > 0 ? <><span>Allergy alert</span><strong>{patient.allergies.join(", ")}</strong></> : <><span>Allergies</span><strong>None recorded</strong></>}</div><div className="signature">{signatureImage && <img src={signatureImage.src} alt="Dr. Nikhil Kanade’s signature" />}<span>Doctor’s signature</span><strong>Dr. Nikhil Kanade</strong></div></footer>
        </article>
      </div>
      {whatsapp && <Modal title="Send prescription on WhatsApp" description="Review the destination and delivery details before sending." onClose={() => setWhatsapp(false)}>
        {delivery === "confirm" && <>
          <div className="send-summary"><span className="avatar">{patient.initials}</span><div><small>Patient</small><strong>{patient.name}</strong><span>{patient.phone}</span></div><Button size="sm" variant="ghost" onClick={() => go("patient-form")}>Edit number</Button></div>
          <div className="document-row"><span><FileText size={20} /></span><div><strong>Prescription preview · {data.date || "No date"}</strong><small>No PDF or message will be generated in this frontend demo</small></div><Paperclip size={16} /></div>
          <div className="delivery-disclaimer"><AlertCircle size={17} /><p><strong>Demo state only.</strong> No WhatsApp API request is sent. Real queued, sent, delivered, and failure states require provider responses.</p></div>
          <div className="modal-actions"><Button variant="ghost" onClick={() => setWhatsapp(false)}>Cancel</Button><Button icon={MessageCircle} onClick={send}>Preview delivery state</Button></div>
        </>}
        {delivery === "sending" && <div className="delivery-state"><span className="state-icon loading"><RefreshCw className="spin" size={25} /></span><h3>Preparing demo state…</h3><p>No external service is being contacted.</p></div>}
        {delivery === "queued" && <div className="delivery-state"><span className="state-icon success"><Check size={25} /></span><h3>Demo: queued</h3><p>This illustrates a queued provider response; no message was sent.</p><div className="status-track"><span className="done">Queued</span><i /><span>Sent</span><i /><span>Delivered</span></div><div className="modal-actions"><Button variant="secondary" onClick={() => setDelivery("failed")}>Preview failure</Button><Button onClick={() => setWhatsapp(false)}>Done</Button></div></div>}
        {delivery === "failed" && <div className="delivery-state"><span className="state-icon danger"><X size={25} /></span><h3>Demo: delivery failure</h3><p>This illustrates a provider error. No real delivery attempt occurred.</p><div className="error-box">Example provider response: Destination temporarily unavailable.</div><div className="modal-actions"><Button variant="ghost" onClick={() => setWhatsapp(false)}>Close</Button><Button icon={RefreshCw} onClick={send}>Preview retry</Button></div></div>}
      </Modal>}
    </>
  );
}

function SettingsPage({
  go,
  logout,
  darkMode,
  onDarkModeChange,
  clinicalLibrary,
  onAddLibraryItem,
  onAddMedicine,
  bannerVisible,
  onBannerVisibleChange,
  bannerImage,
  onBannerImageChange,
  signatureImage,
  onSignatureImageChange,
  showClinicLogo,
  onShowClinicLogoChange,
  showClinicEmail,
  onShowClinicEmailChange,
  showAllergyWarning,
  onShowAllergyWarningChange,
  billLayout,
  onBillLayoutChange,
  initialTab,
  desktopSession,
}: {
  go: (page: Page) => void;
  logout: () => void;
  darkMode: boolean;
  onDarkModeChange: (enabled: boolean) => void;
  clinicalLibrary: ClinicalLibrary;
  onAddLibraryItem: (category: ClinicalLibraryCategory, value: string) => void;
  onAddMedicine: (medicine: ClinicalMedicineDefinition) => void;
  bannerVisible: boolean;
  onBannerVisibleChange: (visible: boolean) => void;
  bannerImage: { src: string; name: string } | null;
  onBannerImageChange: (image: { src: string; name: string } | null) => void;
  signatureImage: { src: string; name: string } | null;
  onSignatureImageChange: (image: { src: string; name: string } | null) => void;
  showClinicLogo: boolean;
  onShowClinicLogoChange: (visible: boolean) => void;
  showClinicEmail: boolean;
  onShowClinicEmailChange: (visible: boolean) => void;
  showAllergyWarning: boolean;
  onShowAllergyWarningChange: (visible: boolean) => void;
  billLayout: BillLayoutPreferences;
  onBillLayoutChange: (layout: BillLayoutPreferences) => void;
  initialTab: string;
  desktopSession?: DesktopSessionContext | null;
}) {
  const [tab, setTab] = useState(initialTab);
  const [saved, setSaved] = useState(false);
  const sections = [
    { label: "Doctor profile", icon: UserRound },
    { label: "Clinic profile", icon: Building2 },
    { label: "Prescription layout", icon: FileText },
    { label: "Bill layout", icon: ReceiptIndianRupee },
    { label: "Clinical library", icon: Pill },
    { label: "Appearance", icon: Moon },
    { label: "WhatsApp", icon: MessageCircle },
    { label: "Security", icon: ShieldCheck },
    { label: "Sync & data", icon: Cloud },
  ];
  return (
    <>
      <AppHeader title="Settings" subtitle="Manage your profile, clinic, and workspace preferences"><IconButton className="topbar-back" label="Back to dashboard" onClick={() => go("dashboard")}><ArrowLeft size={18} /></IconButton></AppHeader>
      <div className="settings-page">
        <aside className="settings-nav">{sections.map((s) => <button key={s.label} className={tab === s.label ? "active" : ""} onClick={() => setTab(s.label)}><s.icon size={17} />{s.label}<ChevronRight size={15} /></button>)}<button className="logout-setting" onClick={logout}><LogOut size={17} />Log out</button></aside>
        <main className="settings-content">
          {tab === "Doctor profile" && <SettingsProfile title="Doctor profile" description="Details shown on prescriptions and clinic records." clinic={false} />}
          {tab === "Clinic profile" && <SettingsProfile title="Clinic profile" description="Contact information visible to your patients." clinic />}
          {tab === "Prescription layout" && <PrescriptionSettings go={go} bannerVisible={bannerVisible} onBannerVisibleChange={onBannerVisibleChange} bannerImage={bannerImage} onBannerImageChange={onBannerImageChange} signatureImage={signatureImage} onSignatureImageChange={onSignatureImageChange} showClinicLogo={showClinicLogo} onShowClinicLogoChange={onShowClinicLogoChange} showClinicEmail={showClinicEmail} onShowClinicEmailChange={onShowClinicEmailChange} showAllergyWarning={showAllergyWarning} onShowAllergyWarningChange={onShowAllergyWarningChange} />}
          {tab === "Bill layout" && <BillLayoutSettings go={go} layout={billLayout} onChange={onBillLayoutChange} bannerImage={bannerImage} signatureImage={signatureImage} />}
          {tab === "Clinical library" && <ClinicalLibrarySettings library={clinicalLibrary} onAdd={onAddLibraryItem} onAddMedicine={onAddMedicine} />}
          {tab === "Appearance" && <AppearanceSettings darkMode={darkMode} onDarkModeChange={onDarkModeChange} />}
          {tab === "WhatsApp" && <WhatsAppSettings />}
          {tab === "Security" && <SecuritySettings logout={logout} desktopSession={desktopSession} />}
          {tab === "Sync & data" && <SyncSettings />}
          {(tab === "Doctor profile" || tab === "Clinic profile") && <div className="settings-actions"><Button variant="secondary" onClick={() => go("dashboard")}>Cancel</Button><Button onClick={() => { setSaved(true); window.setTimeout(() => setSaved(false), 1800); }}>{saved ? <><Check size={16} /> Saved</> : "Save changes"}</Button></div>}
        </main>
      </div>
    </>
  );
}

function ClinicalLibrarySettings({ library, onAdd, onAddMedicine }: { library: ClinicalLibrary; onAdd: (category: ClinicalLibraryCategory, value: string) => void; onAddMedicine: (medicine: ClinicalMedicineDefinition) => void }) {
  const [category, setCategory] = useState<ClinicalLibraryCategory>("Medicines");
  const [newItem, setNewItem] = useState("");
  const [medicineName, setMedicineName] = useState("");
  const [medicineFormulation, setMedicineFormulation] = useState("");
  const [medicineStrength, setMedicineStrength] = useState("");
  const addItem = () => {
    const value = newItem.trim();
    if (!value || library[category].some((item) => item.toLowerCase() === value.toLowerCase())) return;
    onAdd(category, value);
    setNewItem("");
  };
  const addMedicine = () => {
    const name = medicineName.trim();
    if (!name || !medicineFormulation || !medicineStrength) return;
    onAddMedicine({ name, formulation: medicineFormulation, strength: medicineStrength });
    setMedicineName("");
    setMedicineFormulation("");
    setMedicineStrength("");
  };

  return <section className="settings-section"><div className="settings-title"><h2>Clinical library</h2><p>Add custom options that appear in consultation medicine fields.</p></div><div className="library-tabs" role="tablist">{clinicalLibraryCategories.map((item) => <button key={item} role="tab" aria-selected={category === item} className={category === item ? "active" : ""} onClick={() => setCategory(item)}>{item}<span>{library[item].length}</span></button>)}</div>{category === "Medicines" ? <div className="medicine-library-form"><div className="library-step"><span>1</span><Field label="Formulation" required><SelectInput id="library-formulation-select" value={medicineFormulation} onChange={(event) => setMedicineFormulation(event.target.value)}><option value="">Select formulation</option>{library.Formulations.map((item) => <option key={item}>{item}</option>)}</SelectInput></Field></div><div className={cn("library-step", !medicineFormulation && "disabled")}><span>2</span><Field label="Medicine name" required><TextInput value={medicineName} onChange={(event) => setMedicineName(event.target.value)} disabled={!medicineFormulation} placeholder="Enter medicine name" /></Field></div><div className={cn("library-step", !medicineName.trim() && "disabled")}><span>3</span><Field label="Strength" required><SelectInput id="library-strength-select" value={medicineStrength} onChange={(event) => setMedicineStrength(event.target.value)} disabled={!medicineName.trim()}><option value="">Select strength</option>{library.Strengths.map((item) => <option key={item}>{item}</option>)}</SelectInput></Field></div><div className="library-medicine-action"><Button icon={Plus} onClick={addMedicine} disabled={!medicineName.trim() || !medicineFormulation || !medicineStrength}>Add medicine</Button></div></div> : <div className="library-add"><TextInput value={newItem} onChange={(event) => setNewItem(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addItem(); } }} placeholder={`Add custom ${category.toLowerCase().replace(/s$/, "")}`} /><Button icon={Plus} onClick={addItem} disabled={!newItem.trim()}>Add option</Button></div>}<div className="library-list">{category === "Medicines" ? library.MedicineDefinitions.map((item) => <span key={`${item.name}-${item.formulation}-${item.strength}`}><strong>{item.name}</strong><small>{item.formulation} · {item.strength}</small></span>) : library[category].map((item) => <span key={item}>{item}</span>)}</div><div className="info-callout"><ShieldCheck size={17} /><p>Library options are suggestions only. Diagnoses, medicines, strengths, and doses remain blank until the doctor explicitly selects them during a consultation.</p></div></section>;
}

function AppearanceSettings({ darkMode, onDarkModeChange }: { darkMode: boolean; onDarkModeChange: (enabled: boolean) => void }) {
  return <section className="settings-section"><div className="settings-title"><h2>Appearance</h2><p>Choose how the clinic workspace appears on this device.</p></div><div className="appearance-card"><span className="appearance-icon">{darkMode ? <Moon size={21} /> : <Sun size={21} />}</span><div><strong>Dark mode</strong><p>Use a darker interface to reduce glare in low-light environments.</p></div><button className={cn("theme-switch", darkMode && "active")} role="switch" aria-checked={darkMode} aria-label="Toggle dark mode" onClick={() => onDarkModeChange(!darkMode)}><span /></button></div><div className="appearance-preview" aria-hidden="true"><div className="preview-sidebar"><span /><span /><span /></div><div className="preview-workspace"><span /><div><i /><i /><i /></div><div><i /><i /></div></div></div><div className="info-callout"><Sun size={17} /><p>Your appearance preference is saved on this device and applied automatically the next time you open Cliniqo.</p></div></section>;
}

function SettingsProfile({ title, description, clinic }: { title: string; description: string; clinic: boolean }) {
  return <section className="settings-section"><div className="settings-title"><h2>{title}</h2><p>{description}</p></div><div className="photo-upload"><span className={clinic ? "clinic-logo-placeholder" : "photo-placeholder"}>{clinic ? <Building2 size={24} /> : "NK"}</span><div><strong>{clinic ? "Clinic logo" : "Profile photo"}</strong><p>PNG or JPG, up to 2 MB</p></div><Button size="sm" variant="secondary" icon={Upload} onClick={() => window.alert("Image picker opened in the production application.")}>Upload</Button></div><div className="form-grid two">{clinic ? <><Field label="Clinic name"><TextInput defaultValue="Nishti Hospital" /></Field><Field label="Clinic phone"><TextInput defaultValue="+91 22 4123 8765" /></Field><Field label="Address" className="full"><TextInput defaultValue="14, Sea View Road, Bandra West, Mumbai 400050" /></Field><Field label="Email"><TextInput defaultValue="care@harbourclinic.in" /></Field><Field label="Location link"><TextInput placeholder="Add Google Maps link" /></Field></> : <><Field label="Full name"><TextInput defaultValue="Dr. Nikhil Kanade" /></Field><Field label="Gender"><SelectInput defaultValue="Male" style={{ height: "40px" }}><option>Female</option><option>Male</option></SelectInput></Field><Field label="Qualifications"><TextInput defaultValue="MBBS, MD (Internal Medicine)" /></Field><Field label="Registration number"><TextInput defaultValue="MMC 2011/04/1842" /></Field><Field label="Mobile number"><TextInput defaultValue="+91 98200 76421" /></Field><Field label="Email"><TextInput defaultValue="nikhil@nishtihospital.in" /></Field></>}</div></section>;
}

function PrescriptionSettings({ go, bannerVisible, onBannerVisibleChange, bannerImage, onBannerImageChange, signatureImage, onSignatureImageChange, showClinicLogo, onShowClinicLogoChange, showClinicEmail, onShowClinicEmailChange, showAllergyWarning, onShowAllergyWarningChange }: { go: (page: Page) => void; bannerVisible: boolean; onBannerVisibleChange: (visible: boolean) => void; bannerImage: { src: string; name: string } | null; onBannerImageChange: (image: { src: string; name: string } | null) => void; signatureImage: { src: string; name: string } | null; onSignatureImageChange: (image: { src: string; name: string } | null) => void; showClinicLogo: boolean; onShowClinicLogoChange: (visible: boolean) => void; showClinicEmail: boolean; onShowClinicEmailChange: (visible: boolean) => void; showAllergyWarning: boolean; onShowAllergyWarningChange: (visible: boolean) => void }) {
  const bannerInputRef = useRef<HTMLInputElement | null>(null);
  const signatureInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadError, setUploadError] = useState("");
  const [signatureError, setSignatureError] = useState("");
  const uploadBanner = (file?: File) => {
    if (!file) return;
    if (!["image/png", "image/jpeg"].includes(file.type)) {
      setUploadError("Upload a PNG or JPG image.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setUploadError("Banner image must be smaller than 5 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      onBannerImageChange({ src: String(reader.result), name: file.name });
      onBannerVisibleChange(true);
      setUploadError("");
    };
    reader.onerror = () => setUploadError("We couldn’t read that image. Please try another file.");
    reader.readAsDataURL(file);
  };
  const uploadSignature = (file?: File) => {
    if (!file) return;
    if (!["image/png", "image/jpeg"].includes(file.type)) {
      setSignatureError("Upload a PNG or JPG image.");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setSignatureError("Signature image must be smaller than 2 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      onSignatureImageChange({ src: String(reader.result), name: file.name });
      setSignatureError("");
    };
    reader.onerror = () => setSignatureError("We couldn’t read that image. Please try another file.");
    reader.readAsDataURL(file);
  };
  return (
    <section className="settings-section">
      <div className="settings-title"><h2>Prescription layout</h2><p>Configure how finalized prescriptions appear when printed or shared.</p></div>
      <div className="option-list">
        <label><span><strong>Show prescription banner</strong><small>Display the clinic and doctor banner at the top of prescriptions</small></span><input type="checkbox" checked={bannerVisible} onChange={(event) => onBannerVisibleChange(event.target.checked)} /></label>
        <label><span><strong>Show clinic logo</strong><small>Display your uploaded logo in the prescription header</small></span><input type="checkbox" checked={showClinicLogo} onChange={(event) => onShowClinicLogoChange(event.target.checked)} /></label>
        <label><span><strong>Show clinic email</strong><small>Include the clinic email with contact details</small></span><input type="checkbox" checked={showClinicEmail} onChange={(event) => onShowClinicEmailChange(event.target.checked)} /></label>
        <label><span><strong>Include allergy warning</strong><small>Display recorded allergies prominently in the footer</small></span><input type="checkbox" checked={showAllergyWarning} onChange={(event) => onShowAllergyWarningChange(event.target.checked)} /></label>
      </div>
      <h3 className="subsection-title">Custom banner image</h3>
      <div className={cn("banner-upload-card", !bannerVisible && "banner-muted")}>
        <div className="banner-thumbnail">{bannerImage ? <img src={bannerImage.src} alt="" /> : <ImageIcon size={24} />}</div>
        <div className="banner-upload-copy"><strong>{bannerImage ? bannerImage.name : "Use your own prescription banner"}</strong><p>{bannerImage ? "Custom banner will replace the default clinic header." : "PNG or JPG · Recommended 1600 × 300 px · Up to 5 MB"}</p></div>
        <input ref={bannerInputRef} className="sr-only" type="file" accept="image/png,image/jpeg" onChange={(event) => { uploadBanner(event.target.files?.[0]); event.target.value = ""; }} />
        {bannerImage && <Button size="sm" variant="ghost" onClick={() => onBannerImageChange(null)}>Remove</Button>}
        <Button size="sm" variant="secondary" icon={Upload} onClick={() => bannerInputRef.current?.click()}>{bannerImage ? "Replace" : "Upload banner"}</Button>
      </div>
      {uploadError && <div className="banner-upload-error" role="alert"><AlertCircle size={15} />{uploadError}</div>}
      {!bannerVisible && <p className="banner-hidden-note"><AlertCircle size={14} /> Banner is hidden. Uploads are saved and will appear when you turn it back on.</p>}
      <h3 className="subsection-title">Doctor’s signature</h3>
      <div className="banner-upload-card">
        <div className="signature-thumbnail">{signatureImage ? <img src={signatureImage.src} alt="" /> : <PencilLine size={24} />}</div>
        <div className="banner-upload-copy"><strong>{signatureImage ? signatureImage.name : "Upload doctor’s signature"}</strong><p>{signatureImage ? "Signature will appear above the doctor’s name." : "Transparent PNG recommended · JPG supported · Up to 2 MB"}</p></div>
        <input ref={signatureInputRef} className="sr-only" type="file" accept="image/png,image/jpeg" onChange={(event) => { uploadSignature(event.target.files?.[0]); event.target.value = ""; }} />
        {signatureImage && <Button size="sm" variant="ghost" onClick={() => onSignatureImageChange(null)}>Remove</Button>}
        <Button size="sm" variant="secondary" icon={Upload} onClick={() => signatureInputRef.current?.click()}>{signatureImage ? "Replace" : "Upload signature"}</Button>
      </div>
      {signatureError && <div className="banner-upload-error" role="alert"><AlertCircle size={15} />{signatureError}</div>}
      <div className="layout-preview"><FileText size={28} /><div><strong>A4 clinical prescription</strong><p>{bannerVisible ? (bannerImage ? "Custom banner" : "Default clinic banner") : "Banner hidden"} · Structured medicines · Signature footer</p></div><Button size="sm" variant="secondary" icon={ExternalLink} onClick={() => go("preview")}>Preview sample</Button></div>
    </section>
  );
}

function BillLayoutSettings({ go, layout, onChange, bannerImage, signatureImage }: { go: (page: Page) => void; layout: BillLayoutPreferences; onChange: (layout: BillLayoutPreferences) => void; bannerImage: { src: string; name: string } | null; signatureImage: { src: string; name: string } | null }) {
  const update = (key: keyof BillLayoutPreferences, visible: boolean) => onChange({ ...layout, [key]: visible });
  return (
    <section className="settings-section">
      <div className="settings-title"><h2>Bill layout</h2><p>Choose which clinic details appear when bills are printed or shared.</p></div>
      <div className="option-list">
        <label><span><strong>Show bill banner</strong><small>Display the clinic and doctor banner at the top of bills</small></span><input type="checkbox" checked={layout.showBanner} onChange={(event) => update("showBanner", event.target.checked)} /></label>
        <label><span><strong>Show clinic logo</strong><small>Display the clinic logo in the bill header</small></span><input type="checkbox" checked={layout.showClinicLogo} onChange={(event) => update("showClinicLogo", event.target.checked)} /></label>
        <label><span><strong>Show clinic email</strong><small>Include the clinic email with contact details</small></span><input type="checkbox" checked={layout.showClinicEmail} onChange={(event) => update("showClinicEmail", event.target.checked)} /></label>
        <label><span><strong>Show doctor’s signature</strong><small>Display the uploaded signature and doctor name in the footer</small></span><input type="checkbox" checked={layout.showSignature} onChange={(event) => update("showSignature", event.target.checked)} /></label>
        <label><span><strong>Show payment note</strong><small>Include payment status and the patient receipt message</small></span><input type="checkbox" checked={layout.showPaymentNote} onChange={(event) => update("showPaymentNote", event.target.checked)} /></label>
      </div>
      <div className="info-callout"><ReceiptIndianRupee size={17} /><p>Bill layout uses the {bannerImage ? "custom clinic banner" : "default clinic banner"} and {signatureImage ? "uploaded doctor’s signature" : "standard signature footer"} configured in Prescription layout. Hidden items keep their space, so the bill structure does not shift.</p></div>
      <div className="layout-preview"><ReceiptIndianRupee size={28} /><div><strong>A4 patient bill</strong><p>{layout.showBanner ? "Clinic banner" : "Banner hidden"} · Itemized charges · {layout.showSignature ? "Signature footer" : "Signature hidden"}</p></div><Button size="sm" variant="secondary" icon={ExternalLink} onClick={() => go("bill-preview")}>Preview sample</Button></div>
    </section>
  );
}

function WhatsAppSettings() {
  const [tested, setTested] = useState(false);
  return <section className="settings-section"><div className="settings-title with-status"><div><h2>WhatsApp configuration</h2><p>Provider credentials and delivery webhooks are backend-dependent.</p></div><StatusPill tone="warning">Not connected</StatusPill></div><div className="integration-card"><span><MessageCircle size={21} /></span><div><strong>WhatsApp Business provider</strong><p>{tested ? "Frontend check complete · No provider request sent" : "No provider is connected in this UI build"}</p></div><Button size="sm" variant="secondary" onClick={() => setTested(true)}>{tested ? "UI checked" : "Check UI state"}</Button></div><div className="info-callout"><AlertCircle size={17} /><p>Real queued, sent, delivered, and failed statuses must come from provider API responses and webhooks. This frontend does not send messages.</p></div><h3 className="subsection-title">Delivery history</h3><div className="empty-state compact"><MessageCircle size={24} /><h2>No provider delivery data</h2><p>Delivery records will appear only after a backend integration is connected.</p></div></section>;
}

function SecuritySettings({
  logout,
  desktopSession,
}: {
  logout: () => void;
  desktopSession?: DesktopSessionContext | null;
}) {
  return (
    <section className="settings-section">
      <div className="settings-title">
        <h2>Security</h2>
        <p>
          {desktopSession
            ? "Cryptographically verified RS256 desktop session with DPAPI-protected credentials."
            : "Authentication and clinic access controls require a backend."}
        </p>
      </div>
      <div className="security-row">
        <span><ShieldCheck size={20} /></span>
        <div>
          <strong>
            {desktopSession
              ? `Verified Session: ${desktopSession.doctor_name}`
              : "Frontend authentication demo"}
          </strong>
          <p>
            {desktopSession
              ? `Clinic: ${desktopSession.clinic_id} • Role: ${desktopSession.role} • Expires: ${new Date(desktopSession.expires_at * 1000).toLocaleTimeString()}`
              : "No verified session, account, role, or clinic access boundary is active."}
          </p>
        </div>
        <StatusPill tone={desktopSession ? "success" : "warning"}>
          {desktopSession ? "Active (RS256)" : "Demo only"}
        </StatusPill>
      </div>
      <div className="danger-zone">
        <div>
          <strong>{desktopSession ? "End desktop session" : "Return to sign in"}</strong>
          <p>
            {desktopSession
              ? "Revokes server session, clears in-memory keys, and wipes DPAPI-persisted refresh token."
              : "This clears the current UI route; no server session exists to revoke."}
          </p>
        </div>
        <Button variant="danger" onClick={logout}>Log out</Button>
      </div>
    </section>
  );
}

function SyncSettings() {
  const [syncEnabled, setSyncEnabled] = useState(false);
  const [nativeStatus, setNativeStatus] = useState<SyncStatusInfo | null>(null);

  useEffect(() => {
    if (!isTauriDesktop()) return;

    let mounted = true;
    const fetchStatus = async () => {
      try {
        const s = await getSyncStatus();
        if (mounted && s) {
          setNativeStatus(s);
        }
      } catch (err) {
        console.warn("Failed to query sync status:", err);
      }
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 3000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  if (isTauriDesktop()) {
    const isLive = nativeStatus?.is_running ?? false;
    const tone =
      nativeStatus?.status === "SYNCING"
        ? "info"
        : nativeStatus?.status === "OFFLINE"
        ? "warning"
        : nativeStatus?.status === "ERROR"
        ? "danger"
        : "success";

    return (
      <section className="settings-section">
        <div className="settings-title with-status">
          <div>
            <h2>Native Synchronization Engine</h2>
            <p>Background worker with transactional SQLite persistence and cloud sync.</p>
          </div>
          <StatusPill tone={tone}>
            {nativeStatus?.status || (isLive ? "RUNNING" : "STOPPED")}
          </StatusPill>
        </div>

        <div className="sync-hero">
          <span><Cloud size={24} /></span>
          <div>
            <strong>
              {nativeStatus?.active_clinic_id
                ? `Active Clinic: ${nativeStatus.active_clinic_id}`
                : "No active clinic session"}
            </strong>
            <p>
              {nativeStatus?.last_synced_at
                ? `Last synchronized: ${new Date(nativeStatus.last_synced_at).toLocaleTimeString()}`
                : "Awaiting initial sync cycle"}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3 my-4">
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 bg-slate-50 dark:bg-slate-900/50">
            <span className="text-xs text-slate-500 uppercase tracking-wider block">Pending Mutations</span>
            <span className="text-xl font-bold text-slate-800 dark:text-slate-100">{nativeStatus?.pending_mutations ?? 0}</span>
          </div>
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 bg-slate-50 dark:bg-slate-900/50">
            <span className="text-xs text-slate-500 uppercase tracking-wider block">In-Flight Jobs</span>
            <span className="text-xl font-bold text-slate-800 dark:text-slate-100">{nativeStatus?.in_flight_mutations ?? 0}</span>
          </div>
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 bg-slate-50 dark:bg-slate-900/50">
            <span className="text-xs text-slate-500 uppercase tracking-wider block">Conflicts Recorded</span>
            <span className="text-xl font-bold text-amber-600 dark:text-amber-400">{nativeStatus?.conflicts_count ?? 0}</span>
          </div>
        </div>

        {nativeStatus?.last_error && (
          <div className="info-callout text-amber-700 bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-900 mb-3">
            <AlertCircle size={17} />
            <p><strong>Sync Alert:</strong> {nativeStatus.last_error}</p>
          </div>
        )}

        <div className="info-callout">
          <Cloud size={17} />
          <p>
            <strong>Phase 5C Native Sync Active:</strong> Patient demographics and clinical snapshots are encrypted with AES-256-GCM before local SQLite persistence. Mutations push with backend idempotency keys, and changes pull with monotonic sequence cursors.
          </p>
        </div>
      </section>
    );
  }

  return <section className="settings-section"><div className="settings-title with-status"><div><h2>Synchronization & data</h2><p>This frontend keeps workflow data in memory unless explicitly noted.</p></div><StatusPill tone={syncEnabled ? "info" : "warning"}>{syncEnabled ? "UI demo on" : "UI demo off"}</StatusPill></div><div className="sync-hero"><span><Cloud size={24} /></span><div><strong>{syncEnabled ? "Sync preference is on" : "Sync preference is off"}</strong><p>{syncEnabled ? "UI state only — no data is uploaded to or downloaded from a cloud service" : "Local workflow data stays in this browser session"}</p></div><button className={cn("theme-switch", syncEnabled && "active")} role="switch" aria-checked={syncEnabled} aria-label="Toggle synchronization demo" onClick={() => setSyncEnabled((enabled) => !enabled)}><span /></button></div><div className="info-callout"><WifiOff size={17} /><p><strong>UI prototype only:</strong> Turning this switch on does not upload, download, back up, or synchronize patient data. A secure backend and authenticated clinic account are required for real cloud sync.</p></div></section>;
}

export default function App() {
  const [page, setPage] = useState<Page>("login");
  const [desktopSession, setDesktopSession] = useState<DesktopSessionContext | null>(null);
  const [isRestoringSession, setIsRestoringSession] = useState<boolean>(isTauriDesktop);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [patientRecords, setPatientRecords] = useState<Patient[]>(() => isTauriDesktop() ? [] : initialPatients);
  const [selectedPatient, setSelectedPatient] = useState<Patient>(() => isTauriDesktop() ? ({
    id: "PT-INIT",
    name: "No patient selected",
    initials: "--",
    age: 0,
    gender: "Other",
    phone: "",
    lastVisit: "No visits yet",
    allergies: [],
    conditions: [],
  }) : initialPatients[0]);
  const [editingPatient, setEditingPatient] = useState<Patient | null>(null);
  const [patientSaveFeedback, setPatientSaveFeedback] = useState<"added" | "updated" | null>(null);
  const [settingsKey, setSettingsKey] = useState(0);
  const [settingsInitialTab, setSettingsInitialTab] = useState("Doctor profile");
  const [prescriptionPreviewReturnPage, setPrescriptionPreviewReturnPage] = useState<"consultation" | "settings">("consultation");
  const [billPreviewReturnPage, setBillPreviewReturnPage] = useState<"bill-form" | "settings">("bill-form");
  const [vitals, setVitals] = useState<Vitals>({ systolic: "", diastolic: "", heartRate: "", spo2: "", temperature: "", height: "", weight: "" });
  const [consultationData, setConsultationData] = useState<ConsultationData>(createEmptyConsultationData);
  const [darkMode, setDarkMode] = useState(() => window.localStorage.getItem("cliniqo-theme") === "dark");
  const [clinicalLibrary, setClinicalLibrary] = useState<ClinicalLibrary>(loadClinicalLibrary);
  const [prescriptionBannerVisible, setPrescriptionBannerVisible] = useState(true);
  const [prescriptionBannerImage, setPrescriptionBannerImage] = useState<{ src: string; name: string } | null>(null);
  const [doctorSignatureImage, setDoctorSignatureImage] = useState<{ src: string; name: string } | null>(null);
  const [showClinicLogo, setShowClinicLogo] = useState(true);
  const [showClinicEmail, setShowClinicEmail] = useState(true);
  const [showAllergyWarning, setShowAllergyWarning] = useState(true);
  const [billLayout, setBillLayout] = useState<BillLayoutPreferences>({
    showBanner: true,
    showClinicLogo: true,
    showClinicEmail: true,
    showSignature: true,
    showPaymentNote: true,
  });
  const [billData, setBillData] = useState<BillData>({
    invoiceNumber: "INV-2025-1048",
    date: "2025-07-01",
    paymentStatus: "Unpaid",
    discount: 0,
    items: [{ id: 1, description: "Consultation fee", quantity: 1, rate: 800 }],
  });
  const nextPatientId = `PC-${Math.max(...patientRecords.map((patient) => Number(patient.id.replace(/\D/g, "")) || 0), 1048) + 1}`;

  // Desktop session bootstrap: check active in-memory session or restore via DPAPI refresh token
  useEffect(() => {
    if (!isTauriDesktop()) return;

    let mounted = true;
    async function bootstrapDesktopSession() {
      try {
        const active = await getDesktopSession();
        const nowSec = Math.floor(Date.now() / 1000);
        if (active && active.expires_at > nowSec) {
          if (mounted) {
            setDesktopSession(active);
            try {
              const localPatients = await getLocalPatients(active.clinic_id);
              if (localPatients && localPatients.length > 0) {
                const mapped = localPatients.map(mapLocalRecordToPatient);
                setPatientRecords(mapped);
                setSelectedPatient(mapped[0]);
              } else {
                setPatientRecords([]);
              }
            } catch (err) {
              console.warn("[Cliniqo Desktop] Failed to load local patients:", err);
            }
            setPage((curr) => (curr === "login" || curr === "register" ? "dashboard" : curr));
            setIsRestoringSession(false);
          }
          return;
        }

        const hasToken = await hasPersistedRefreshToken();
        if (hasToken) {
          const restored = await refreshDesktopSession();
          if (restored && mounted) {
            setDesktopSession(restored.session);
            try {
              const localPatients = await getLocalPatients(restored.session.clinic_id);
              if (localPatients && localPatients.length > 0) {
                const mapped = localPatients.map(mapLocalRecordToPatient);
                setPatientRecords(mapped);
                setSelectedPatient(mapped[0]);
              } else {
                setPatientRecords([]);
              }
            } catch (err) {
              console.warn("[Cliniqo Desktop] Failed to load local patients:", err);
            }
            setPage((curr) => (curr === "login" || curr === "register" ? "dashboard" : curr));
            setIsRestoringSession(false);
            return;
          }
        }

        if (mounted) {
          setDesktopSession(null);
          setPage("login");
          setIsRestoringSession(false);
        }
      } catch (err) {
        console.warn("[Cliniqo Desktop] Session bootstrap error:", err);
        if (mounted) {
          setDesktopSession(null);
          setPage("login");
          setIsRestoringSession(false);
        }
      }
    }

    bootstrapDesktopSession();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode);
    window.localStorage.setItem("cliniqo-theme", darkMode ? "dark" : "light");
  }, [darkMode]);

  useEffect(() => {
    window.localStorage.setItem("cliniqo-clinical-library", JSON.stringify(clinicalLibrary));
  }, [clinicalLibrary]);

  const go = (next: Page) => {
    // Desktop Route Guard:
    // When running inside Tauri desktop container, do not allow navigation to protected pages without verified session
    if (isTauriDesktop() && !desktopSession && next !== "login" && next !== "register") {
      setPage("login");
      return;
    }

    if (next === "preview") {
      const fromSettings = page === "settings";
      setPrescriptionPreviewReturnPage(fromSettings ? "settings" : "consultation");
      if (fromSettings) setSettingsInitialTab("Prescription layout");
    }
    if (next === "bill-preview") {
      const fromSettings = page === "settings";
      setBillPreviewReturnPage(fromSettings ? "settings" : "bill-form");
      if (fromSettings) setSettingsInitialTab("Bill layout");
    }
    if (next === "patient-form") setEditingPatient(page === "patient-profile" || page === "preview" ? selectedPatient : null);
    if (next === "settings" && page !== "preview" && page !== "bill-preview") setSettingsInitialTab("Doctor profile");
    setPage(next);
    setSidebarOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const logout = async () => {
    if (isTauriDesktop()) {
      try {
        await logoutDesktopSession();
      } catch (err) {
        console.warn("[Cliniqo Desktop] Error during logout:", err);
      }
      setDesktopSession(null);
      setPatientRecords([]);
    }
    go("login");
  };

  const openPatient = (patient: Patient) => {
    setSelectedPatient(patient);
    setPatientSaveFeedback(null);
    setConsultationData(createEmptyConsultationData());
    setVitals({ systolic: "", diastolic: "", heartRate: "", spo2: "", temperature: "", height: "", weight: "" });
    go("patient-profile");
  };

  const startConsultation = (patient: Patient) => {
    setSelectedPatient(patient);
    setPatientSaveFeedback(null);
    setConsultationData(createEmptyConsultationData());
    setVitals({ systolic: "", diastolic: "", heartRate: "", spo2: "", temperature: "", height: "", weight: "" });
    go("consultation");
  };

  const editPatient = (patient: Patient) => {
    setSelectedPatient(patient);
    setPatientSaveFeedback(null);
    setEditingPatient(patient);
    setPage("patient-form");
    setSidebarOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const startBill = (patient: Patient) => {
    setSelectedPatient(patient);
    setBillData({
      invoiceNumber: `INV-2025-${patient.id.replace(/\D/g, "")}`,
      date: "2025-07-01",
      paymentStatus: "Unpaid",
      discount: 0,
      items: [{ id: Date.now(), description: "Consultation fee", quantity: 1, rate: 800 }],
    });
    go("bill-form");
  };

  const savePatient = async (patient: Patient, startConsultation = false) => {
    const wasEditing = Boolean(editingPatient);
    let effectivePatient = patient;

    if (isTauriDesktop() && desktopSession?.clinic_id) {
      try {
        const savedId = await saveLocalPatient({
          id: wasEditing ? editingPatient?.id : null,
          clinic_id: desktopSession.clinic_id,
          patient_code: patient.id,
          name: patient.name,
          phone: patient.phone,
          gender: patient.gender,
          date_of_birth: patient.dateOfBirth || null,
          age: patient.age,
          allergies: patient.allergies,
          conditions: patient.conditions,
        });
        if (savedId) {
          effectivePatient = { ...patient, id: wasEditing ? patient.id : savedId };
        }
      } catch (err) {
        console.error("[Cliniqo Desktop] Failed to save patient to SQLite:", err);
      }
    }

    setPatientRecords((records) => [effectivePatient, ...records.filter((record) => record.id !== patient.id && record.id !== effectivePatient.id)]);
    setSelectedPatient(effectivePatient);
    setPatientSaveFeedback(startConsultation ? null : wasEditing ? "updated" : "added");
    setEditingPatient(null);
    if (startConsultation) {
      setConsultationData(createEmptyConsultationData());
      setVitals({ systolic: "", diastolic: "", heartRate: "", spo2: "", temperature: "", height: "", weight: "" });
    }
    go(startConsultation ? "consultation" : "patient-profile");
  };

  const deletePatient = async (patientId: string) => {
    if (isTauriDesktop() && desktopSession?.clinic_id) {
      try {
        await deleteLocalPatient(desktopSession.clinic_id, patientId);
      } catch (err) {
        console.error("[Cliniqo Desktop] Failed to delete patient from SQLite:", err);
      }
    }
    setPatientRecords((records) => records.filter((p) => p.id !== patientId));
    if (selectedPatient?.id === patientId) {
      const remaining = patientRecords.filter((p) => p.id !== patientId);
      if (remaining.length > 0) {
        setSelectedPatient(remaining[0]);
      }
    }
    go("patients");
  };

  const handleLoginSuccess = async (session: DesktopSessionContext) => {
    setDesktopSession(session);
    try {
      const localPatients = await getLocalPatients(session.clinic_id);
      if (localPatients && localPatients.length > 0) {
        const mapped = localPatients.map(mapLocalRecordToPatient);
        setPatientRecords(mapped);
        setSelectedPatient(mapped[0]);
      } else {
        setPatientRecords([]);
      }
    } catch (err) {
      console.warn("[Cliniqo Desktop] Failed to load local patients on login:", err);
    }
    go("dashboard");
  };

  const addLibraryItem = (category: ClinicalLibraryCategory, value: string) => {
    setClinicalLibrary((library) => ({ ...library, [category]: [...library[category], value] }));
  };

  const addMedicineDefinition = (medicine: ClinicalMedicineDefinition) => {
    setClinicalLibrary((library) => {
      const exists = library.MedicineDefinitions.some((item) => item.name.toLowerCase() === medicine.name.toLowerCase() && item.formulation === medicine.formulation && item.strength === medicine.strength);
      if (exists) return library;
      return {
        ...library,
        Medicines: library.Medicines.some((item) => item.toLowerCase() === medicine.name.toLowerCase()) ? library.Medicines : [...library.Medicines, medicine.name],
        MedicineDefinitions: [...library.MedicineDefinitions, medicine],
      };
    });
  };

  const openDoctorProfile = () => {
    setSettingsKey((key) => key + 1);
    go("settings");
  };

  const updateVital = (key: keyof Vitals, value: string) => {
    setVitals((current) => ({ ...current, [key]: value }));
  };

  if (isRestoringSession) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-900 text-slate-700 dark:text-slate-200">
        <div className="flex flex-col items-center gap-3">
          <RefreshCw className="animate-spin text-teal-600" size={32} />
          <p className="text-sm font-medium">Verifying desktop security session...</p>
        </div>
      </div>
    );
  }

  // Desktop unauthenticated route guard fallback
  if (isTauriDesktop() && !desktopSession && page !== "login" && page !== "register") {
    return (
      <Login
        go={go}
        onLoginSuccess={handleLoginSuccess}
      />
    );
  }

  if (page === "login") {
    return (
      <Login
        go={go}
        onLoginSuccess={handleLoginSuccess}
      />
    );
  }
  if (page === "register") return <Register go={go} />;
  if (page === "setup") return <Setup go={go} />;

  let content: ReactNode;
  if (page === "dashboard") content = <Dashboard go={go} patients={patientRecords} onOpenPatient={openPatient} />;
  else if (page === "patients") content = <PatientsPage go={go} patients={patientRecords} onOpenPatient={openPatient} onStartConsultation={startConsultation} onCreateBill={startBill} onEditPatient={editPatient} onDeletePatient={deletePatient} />;
  else if (page === "patient-form") content = <PatientForm go={go} onSave={savePatient} onReviewPatient={openPatient} patient={editingPatient} patients={patientRecords} nextPatientId={nextPatientId} />;
  else if (page === "patient-profile") content = <PatientProfile go={go} patient={selectedPatient} saveFeedback={patientSaveFeedback} onDeletePatient={deletePatient} />;
  else if (page === "consultation") content = <Consultation go={go} patient={selectedPatient} clinicalLibrary={clinicalLibrary} vitals={vitals} onVitalsChange={updateVital} data={consultationData} onDataChange={setConsultationData} desktopSession={desktopSession} />;
  else if (page === "preview") content = <PrescriptionPreview go={go} patient={selectedPatient} vitals={vitals} data={consultationData} bannerVisible={prescriptionBannerVisible} bannerImage={prescriptionBannerImage} signatureImage={doctorSignatureImage} showClinicLogo={showClinicLogo} showClinicEmail={showClinicEmail} showAllergyWarning={showAllergyWarning} returnPage={prescriptionPreviewReturnPage} />;
  else if (page === "bill-form") content = <BillForm go={go} patient={selectedPatient} bill={billData} onChange={setBillData} />;
  else if (page === "bill-preview") content = <BillPreview go={go} patient={selectedPatient} bill={billData} bannerImage={prescriptionBannerImage} signatureImage={doctorSignatureImage} layout={billLayout} returnPage={billPreviewReturnPage} />;
  else content = <SettingsPage key={settingsKey} go={go} logout={logout} darkMode={darkMode} onDarkModeChange={setDarkMode} clinicalLibrary={clinicalLibrary} onAddLibraryItem={addLibraryItem} onAddMedicine={addMedicineDefinition} bannerVisible={prescriptionBannerVisible} onBannerVisibleChange={setPrescriptionBannerVisible} bannerImage={prescriptionBannerImage} onBannerImageChange={setPrescriptionBannerImage} signatureImage={doctorSignatureImage} onSignatureImageChange={setDoctorSignatureImage} showClinicLogo={showClinicLogo} onShowClinicLogoChange={setShowClinicLogo} showClinicEmail={showClinicEmail} onShowClinicEmailChange={setShowClinicEmail} showAllergyWarning={showAllergyWarning} onShowAllergyWarningChange={setShowAllergyWarning} billLayout={billLayout} onBillLayoutChange={setBillLayout} initialTab={settingsInitialTab} desktopSession={desktopSession} />;

  return (
    <div className={cn("app-shell", sidebarCollapsed && "sidebar-collapsed")}>
      <div className={cn("mobile-overlay", sidebarOpen && "open")} onClick={() => setSidebarOpen(false)} />
      <div className={cn("sidebar-wrap", sidebarOpen && "open", sidebarCollapsed && "collapsed")}><Sidebar page={page} go={go} collapsed={sidebarCollapsed} onToggle={() => { if (window.matchMedia("(max-width: 820px)").matches) setSidebarOpen(false); else setSidebarCollapsed((value) => !value); }} onDoctorProfile={openDoctorProfile} desktopSession={desktopSession} /></div>
      <div className="main-shell">
        <div className="mobile-topbar"><IconButton label="Open navigation" onClick={() => setSidebarOpen(true)}><Menu size={20} /></IconButton><Logo /><span className="sync-dot" /></div>
        {content}
      </div>
    </div>
  );
}
