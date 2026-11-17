import { useState, useMemo, useEffect, useRef, type FormEvent } from "react"
import {
  Button,
  ConfirmDialog,
  Field,
  FormSection,
  IconButton,
  SelectInput,
  TextArea,
  TextInput,
} from "../common"
import { AppHeader } from "../layout"
import type { Page, Patient, PatientFormFieldPreferences } from "../../types"
import {
  defaultPatientFormFieldPreferences,
  getIndiaDateTimeLocalString,
} from "../../types"
import { AlertCircle, ArrowLeft, Stethoscope, UserRound } from "lucide-react"
import type { PatientSaveDiagnostic } from "../../desktop/desktop-bridge"

export function PatientForm({
  go,
  onSave,
  onReviewPatient,
  patient,
  patients,
  nextPatientId,
  fieldPreferences = defaultPatientFormFieldPreferences,
}: {
  go: (page: Page) => void
  onSave: (
    patient: Patient,
    startConsultation?: boolean,
    clientMutationId?: string,
  ) => Promise<void> | void
  onReviewPatient: (patient: Patient) => void
  patient: Patient | null
  patients: Patient[]
  nextPatientId: string
  fieldPreferences?: PatientFormFieldPreferences
}) {
  const [submitted, setSubmitted] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false)
  const [saveError, setSaveError] = useState<PatientSaveDiagnostic | null>(null)
  const [name, setName] = useState(patient?.name || "")
  const [phone, setPhone] = useState(patient?.phone || "")
  const [dirty, setDirty] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)
  const isSavingRef = useRef(false)
  const lastStartConsultationRef = useRef(false)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const clientMutationIdRef = useRef<string>(
    patient?.id
      ? `patient-edit-${patient.id}`
      : `patient-create-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
  )

  useEffect(() => {
    // Automatically focus the patient name input on mount so the user can type immediately
    const timer = setTimeout(() => {
      nameInputRef.current?.focus()
    }, 50)
    return () => clearTimeout(timer)
  }, [])

  const editing = Boolean(patient)
  const showDob = editing || fieldPreferences.showDob
  const showPhone = editing || fieldPreferences.showPhone
  const showAlternatePhone = editing || fieldPreferences.showAlternatePhone
  const showAddress = editing || fieldPreferences.showAddress
  const normalizedPhone = phone.replace(/\D/g, "").slice(-10)

  const duplicatePatient = useMemo(
    () =>
      phone.trim() && normalizedPhone.length === 10
        ? patients.find(
            (record) =>
              record.id !== patient?.id &&
              record.phone.replace(/\D/g, "").slice(-10) === normalizedPhone,
          )
        : undefined,
    [normalizedPhone, patient?.id, patients, phone],
  )

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!dirty) return
      event.preventDefault()
    }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [dirty])

  const leave = () => {
    if (dirty) {
      setShowDiscardConfirm(true)
    } else {
      go("patients")
    }
  }

  const performSave = async (startConsultation: boolean) => {
    lastStartConsultationRef.current = startConsultation
    if (isSavingRef.current || isSaving) return
    const form = formRef.current
    if (!form) return
    setSubmitted(true)

    if (
      !form.checkValidity() ||
      !name.trim() ||
      (phone.trim() && normalizedPhone.length !== 10)
    ) {
      return form.reportValidity()
    }

    if (!duplicatePatient) {
      isSavingRef.current = true
      setIsSaving(true)
      setSaveError(null)
      try {
        const data = new FormData(form)
        const submittedName = name.trim()
        const registeredAtVal = String(data.get("registeredAt") || "")

        await onSave(
          {
            id: patient?.id || nextPatientId,
            name: submittedName,
            initials: submittedName
              .split(/\s+/)
              .slice(0, 2)
              .map((part) => part[0])
              .join("")
              .toUpperCase(),
            age:
              data.get("age") !== null
                ? String(data.get("age")).trim() !== ""
                  ? Math.max(0, parseInt(String(data.get("age")), 10) || 0)
                  : 0
                : (patient?.age ?? 0),
            ageMonths:
              data.get("ageMonths") !== null
                ? String(data.get("ageMonths")).trim() !== ""
                  ? Math.min(
                      11,
                      Math.max(
                        0,
                        parseInt(String(data.get("ageMonths")), 10) || 0,
                      ),
                    )
                  : 0
                : (patient?.ageMonths ?? 0),
            gender: String(data.get("gender") || patient?.gender || "").trim(),
            phone: phone.trim() ? phone.trim() : patient?.phone || "",
            lastVisit: patient?.lastVisit || "No visits yet",
            allergies: patient?.allergies || [],
            conditions: patient?.conditions || [],
            dateOfBirth: String(
              data.get("dateOfBirth") || patient?.dateOfBirth || "",
            ),
            alternatePhone: String(
              data.get("alternatePhone") || patient?.alternatePhone || "",
            ),
            address: String(data.get("address") || patient?.address || ""),
            registeredAt:
              registeredAtVal ||
              patient?.registeredAt ||
              new Date().toISOString(),
          },
          startConsultation,
          clientMutationIdRef.current,
        )
        setDirty(false)
      } catch (err: any) {
        const diag: PatientSaveDiagnostic = err?.diagnostic || {
          category: "UNKNOWN_SAVE_FAILURE",
          stage: "form_submission",
          command: "save_local_patient",
          sqlite_error_code: null,
          message:
            err?.message ||
            "Failed to save patient. Consultation cannot be started.",
          retryable: true,
        }
        setSaveError(diag)
      } finally {
        setIsSaving(false)
        isSavingRef.current = false
      }
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const submitter = (event.nativeEvent as SubmitEvent)
      ?.submitter as HTMLButtonElement | null
    await performSave(submitter?.value === "consultation")
  }

  useEffect(() => {
    const handleShortcut = (e: Event) => {
      const customEvent = e as CustomEvent<{ action: string }>
      if (customEvent.detail?.action === "save-and-start-consultation") {
        performSave(true)
      } else if (
        customEvent.detail?.action === "save-draft" ||
        customEvent.detail?.action === "save-patient"
      ) {
        performSave(false)
      }
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        (e.key === "s" || e.key === "S") &&
        !e.shiftKey
      ) {
        e.preventDefault()
        e.stopPropagation()
        performSave(false)
      }
    }

    window.addEventListener("cliniqo-shortcut", handleShortcut)
    window.addEventListener("keydown", handleKeyDown)
    return () => {
      window.removeEventListener("cliniqo-shortcut", handleShortcut)
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [
    name,
    phone,
    normalizedPhone,
    duplicatePatient,
    patient,
    nextPatientId,
    onSave,
    isSaving,
  ])

  return (
    <>
      <AppHeader title={editing ? "Edit patient" : "Add new patient"}>
        <IconButton
          className="topbar-back"
          label="Back to patients"
          onClick={leave}
        >
          <ArrowLeft size={18} />
        </IconButton>
        <Button
          type="submit"
          form="patient-form"
          disabled={isSaving}
          loading={isSaving}
        >
          {editing ? "Save changes" : "Save patient"}
        </Button>
        <Button
          type="submit"
          form="patient-form"
          value="consultation"
          icon={Stethoscope}
          title="Save & start consultation (Ctrl+Shift+C)"
          disabled={isSaving}
          loading={isSaving}
        >
          Save & start consultation
        </Button>
      </AppHeader>

      <form
        ref={formRef}
        id="patient-form"
        className="page-content form-page"
        onSubmit={submit}
        onChange={() => setDirty(true)}
      >
        <div className="form-main">
          {saveError && (
            <div
              className="patient-save-error-banner"
              role="alert"
              style={{
                margin: "0 0 16px 0",
                padding: "12px 16px",
                borderRadius: "8px",
                backgroundColor: "var(--color-bg-danger-subtle, #fef2f2)",
                border: "1px solid var(--color-border-danger, #fca5a5)",
                color: "var(--color-text-danger, #991b1b)",
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: "12px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  gap: "10px",
                  alignItems: "flex-start",
                }}
              >
                <AlertCircle
                  size={20}
                  style={{ flexShrink: 0, marginTop: "2px" }}
                />
                <div>
                  <div
                    style={{
                      fontWeight: 600,
                      fontSize: "14px",
                      marginBottom: "2px",
                    }}
                  >
                    {saveError.category === "SESSION_EXPIRED" &&
                      "Session Expired"}
                    {saveError.category === "CLINIC_MISMATCH" &&
                      "Clinic Tenancy Conflict"}
                    {saveError.category === "DATABASE_BUSY" && "Database Busy"}
                    {saveError.category === "DATABASE_FULL" &&
                      "Storage Space Full"}
                    {saveError.category === "DATABASE_CONSTRAINT" &&
                      "Validation Constraint Conflict"}
                    {saveError.category ===
                      "PATIENT_ID_ALLOCATION_FAILURE" &&
                      "Patient Code Allocation Error"}
                    {saveError.category === "ENCRYPTION_FAILURE" &&
                      "Security Encryption Error"}
                    {saveError.category ===
                      "DATABASE_TRANSACTION_FAILURE" &&
                      "Transaction Save Failed"}
                    {saveError.category === "UNKNOWN_SAVE_FAILURE" &&
                      "Patient Save Failed"}
                  </div>
                  <p style={{ margin: 0, fontSize: "13px", opacity: 0.9 }}>
                    {saveError.message}
                    {saveError.category === "DATABASE_BUSY" &&
                      " The database was busy syncing. Click Retry to complete your save."}
                  </p>
                </div>
              </div>
              <div style={{ display: "flex", gap: "8px", flexShrink: 0 }}>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => performSave(lastStartConsultationRef.current)}
                  disabled={isSaving}
                  loading={isSaving}
                >
                  Retry
                </Button>
              </div>
            </div>
          )}

          {duplicatePatient && (
            <div className="duplicate-warning" role="alert">
              <AlertCircle size={20} />
              <div>
                <strong>Existing patient with this mobile number</strong>
                <p>
                  {duplicatePatient.name} · {duplicatePatient.id} ·{" "}
                  {duplicatePatient.phone}
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => onReviewPatient(duplicatePatient)}
              >
                Review record
              </Button>
            </div>
          )}

          <FormSection icon={UserRound} title="Personal details">
            <div className="form-grid four">
              <Field
                label="Full name"
                required
                error={
                  submitted && !name.trim()
                    ? "Full name is required"
                    : undefined
                }
              >
                <TextInput
                  ref={nameInputRef}
                  autoFocus
                  name="name"
                  required
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Enter patient's full name"
                  aria-invalid={submitted && !name.trim()}
                />
              </Field>

              <Field label="Patient ID">
                <TextInput value={patient?.id || nextPatientId} readOnly />
              </Field>

              <Field label="Age">
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: "8px",
                  }}
                >
                  <TextInput
                    name="age"
                    type="number"
                    defaultValue={
                      patient?.age !== undefined && patient?.age !== null
                        ? patient.age
                        : ""
                    }
                    placeholder="Years"
                    min="0"
                    max="120"
                    aria-label="Age in years"
                  />
                  <TextInput
                    name="ageMonths"
                    type="number"
                    defaultValue={
                      patient?.ageMonths !== undefined &&
                      patient?.ageMonths !== null
                        ? patient.ageMonths
                        : ""
                    }
                    placeholder="Months"
                    min="0"
                    max="11"
                    aria-label="Age in months"
                  />
                </div>
              </Field>

              <Field label="Gender">
                <SelectInput
                  name="gender"
                  defaultValue={patient?.gender || ""}
                  style={{ height: "40px" }}
                >
                  <option value="">Select gender</option>
                  <option>Female</option>
                  <option>Male</option>
                  <option>Non-binary</option>
                  <option>Prefer not to say</option>
                </SelectInput>
              </Field>

              <Field label="Registration Date & Time">
                <TextInput
                  name="registeredAt"
                  type="datetime-local"
                  defaultValue={
                    patient?.registeredAt
                      ? getIndiaDateTimeLocalString(patient.registeredAt)
                      : getIndiaDateTimeLocalString()
                  }
                />
              </Field>

              {showDob && (
                <Field label="Date of birth">
                  <TextInput
                    name="dateOfBirth"
                    type="date"
                    defaultValue={patient?.dateOfBirth || ""}
                  />
                </Field>
              )}

              {showPhone && (
                <Field
                  label="Mobile number"
                  error={
                    submitted && phone.trim() && normalizedPhone.length !== 10
                      ? "Enter a valid 10-digit mobile number"
                      : undefined
                  }
                >
                  <TextInput
                    name="phone"
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+91 00000 00000"
                    aria-invalid={
                      submitted &&
                      Boolean(phone.trim()) &&
                      normalizedPhone.length !== 10
                    }
                  />
                </Field>
              )}

              {showAlternatePhone && (
                <Field label="Alternate phone">
                  <TextInput
                    name="alternatePhone"
                    type="tel"
                    defaultValue={patient?.alternatePhone || ""}
                    placeholder="+91 00000 00000"
                  />
                </Field>
              )}

              {showAddress && (
                <Field label="Address" className="full">
                  <TextArea
                    name="address"
                    rows={2}
                    defaultValue={patient?.address || ""}
                    placeholder="House / street, locality, city, postal code"
                  />
                </Field>
              )}
            </div>
          </FormSection>

          <div className="patient-form-actions">
            <div>
              <strong>{editing ? "Save changes" : "Save patient"}</strong>
            </div>
            <Button
              type="submit"
              variant="secondary"
              value="profile"
              disabled={isSaving}
              loading={isSaving}
            >
              {editing ? "Save changes" : "Save patient"}
            </Button>
            <Button
              type="submit"
              value="consultation"
              icon={Stethoscope}
              title="Save & start consultation (Ctrl+Shift+C)"
              disabled={isSaving}
              loading={isSaving}
            >
              Save & start consultation
            </Button>
          </div>
        </div>
      </form>

      <ConfirmDialog
        isOpen={showDiscardConfirm}
        title="Discard unsaved changes?"
        description="You have unsaved changes in this patient form. If you leave now, your edits will not be saved."
        confirmText="Discard changes"
        cancelText="Continue editing"
        isDangerous
        onConfirm={() => {
          setShowDiscardConfirm(false)
          setDirty(false)
          go("patients")
        }}
        onCancel={() => setShowDiscardConfirm(false)}
      />
    </>
  )
}
