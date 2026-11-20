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
import { AlertCircle, ArrowLeft, Stethoscope, UserRound, Check, Loader2 } from "lucide-react"
import type { PatientSaveDiagnostic, DesktopSessionContext } from "../../desktop/desktop-bridge"

export function PatientForm({
  go,
  onSave,
  onReviewPatient,
  patient,
  patients,
  nextPatientId,
  fieldPreferences = defaultPatientFormFieldPreferences,
  desktopSession,
  registerNavigationInterceptor,
}: {
  go: (page: Page) => void
  onSave: (
    patient: Patient,
    startConsultation?: boolean,
    clientMutationId?: string,
    navigateAfterSave?: boolean,
  ) => Promise<Patient | void> | void
  onReviewPatient: (patient: Patient) => void
  patient: Patient | null
  patients: Patient[]
  nextPatientId: string
  fieldPreferences?: PatientFormFieldPreferences
  desktopSession?: DesktopSessionContext | null
  registerNavigationInterceptor?: (
    interceptor: ((next: Page) => Promise<boolean | void> | boolean | void) | null,
  ) => () => void
}) {
  const [submitted, setSubmitted] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false)
  const [saveError, setSaveError] = useState<PatientSaveDiagnostic | null>(null)
  const [name, setName] = useState(patient?.name || "")
  const [phone, setPhone] = useState(patient?.phone || "")
  const [dirty, setDirty] = useState(false)
  const [autoSaveStatus, setAutoSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle")
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isInitialDraftLoadedRef = useRef(false)
  const createdPatientIdRef = useRef<string | null>(patient?.id || null)
  const draftPatientKey = `cliniqo_draft_patient_${desktopSession?.clinic_id || "default"}`

  const formRef = useRef<HTMLFormElement>(null)
  const isSavingRef = useRef(false)
  const lastStartConsultationRef = useRef(false)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const clientMutationIdRef = useRef<string>(
    patient?.id
      ? `patient-edit-${patient.id}`
      : `patient-create-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
  )

  // Restore draft on mount if creating a new patient
  useEffect(() => {
    if (patient) return
    try {
      const saved = window.localStorage.getItem(draftPatientKey)
      if (saved) {
        const parsed = JSON.parse(saved)
        if (parsed && typeof parsed === "object") {
          // If this draft belongs to a patient who has already been registered in patients list, discard the stale draft!
          const draftCleanPhone = (parsed.phone || "").replace(/\D/g, "").slice(-10)
          const isAlreadySaved =
            draftCleanPhone.length === 10 &&
            patients.some(
              (p) => (p.phone || "").replace(/\D/g, "").slice(-10) === draftCleanPhone,
            )
          if (isAlreadySaved) {
            window.localStorage.removeItem(draftPatientKey)
            return
          }

          if (parsed.name && !name) setName(parsed.name)
          if (parsed.phone && !phone) setPhone(parsed.phone)
          if (formRef.current) {
            const form = formRef.current
            if (parsed.age !== undefined && form.elements.namedItem("age")) {
              ;(form.elements.namedItem("age") as HTMLInputElement).value = parsed.age
            }
            if (parsed.ageMonths !== undefined && form.elements.namedItem("ageMonths")) {
              ;(form.elements.namedItem("ageMonths") as HTMLInputElement).value = parsed.ageMonths
            }
            if (parsed.gender && form.elements.namedItem("gender")) {
              ;(form.elements.namedItem("gender") as HTMLSelectElement).value = parsed.gender
            }
            if (parsed.dateOfBirth && form.elements.namedItem("dateOfBirth")) {
              ;(form.elements.namedItem("dateOfBirth") as HTMLInputElement).value = parsed.dateOfBirth
            }
            if (parsed.alternatePhone && form.elements.namedItem("alternatePhone")) {
              ;(form.elements.namedItem("alternatePhone") as HTMLInputElement).value = parsed.alternatePhone
            }
            if (parsed.address && form.elements.namedItem("address")) {
              ;(form.elements.namedItem("address") as HTMLTextAreaElement).value = parsed.address
            }
            if (parsed.registeredAt && form.elements.namedItem("registeredAt")) {
              ;(form.elements.namedItem("registeredAt") as HTMLInputElement).value = parsed.registeredAt
            }
          }
          setAutoSaveStatus("saved")
        }
      }
    } catch {}

    const timer = setTimeout(() => {
      isInitialDraftLoadedRef.current = true
    }, 300)
    return () => clearTimeout(timer)
  }, [patient, draftPatientKey, patients])

  const executePatientAutoSave = async () => {
    if (isSavingRef.current) return
    const form = formRef.current
    if (!form) return

    const data = new FormData(form)
    const currentName = (name || String(data.get("name") || "")).trim()
    const currentPhone = (phone || String(data.get("phone") || "")).trim()
    const currentAddress = String(data.get("address") || "")
    const currentRegisteredAt = String(data.get("registeredAt") || "")
    const currentDateOfBirth = String(data.get("dateOfBirth") || "")
    const currentAlternatePhone = String(data.get("alternatePhone") || "")
    const currentGender = String(data.get("gender") || "")
    const currentAge =
      data.get("age") !== null && String(data.get("age")).trim() !== ""
        ? Math.max(0, parseInt(String(data.get("age")), 10) || 0)
        : (patient?.age ?? 0)
    const currentAgeMonths =
      data.get("ageMonths") !== null && String(data.get("ageMonths")).trim() !== ""
        ? Math.min(11, Math.max(0, parseInt(String(data.get("ageMonths")), 10) || 0))
        : (patient?.ageMonths ?? 0)

    // Also persist draft to localStorage for temporary crash recovery
    try {
      const payload = {
        name: currentName,
        phone: currentPhone,
        age: currentAge,
        ageMonths: currentAgeMonths,
        gender: currentGender,
        dateOfBirth: currentDateOfBirth,
        alternatePhone: currentAlternatePhone,
        address: currentAddress,
        registeredAt: currentRegisteredAt,
        savedAt: new Date().toISOString(),
      }
      window.localStorage.setItem(draftPatientKey, JSON.stringify(payload))
    } catch {}

    // Only persist if at least some patient info is entered
    if (!currentName && !currentPhone && !currentAddress) {
      return
    }

    setAutoSaveStatus("saving")
    try {
      const normPhone = currentPhone.replace(/\D/g, "").slice(-10)
      const matchingExistingPatient =
        normPhone.length === 10
          ? patients.find(
              (record) =>
                record.id !== patient?.id &&
                (record.phone || "").replace(/\D/g, "").slice(-10) === normPhone,
            )
          : undefined

      if (matchingExistingPatient && !createdPatientIdRef.current && !patient) {
        createdPatientIdRef.current = matchingExistingPatient.id
      }

      const targetId =
        patient?.id ||
        createdPatientIdRef.current ||
        matchingExistingPatient?.id ||
        nextPatientId

      const candidatePatient: Patient = {
        id: targetId,
        name: currentName || "Unnamed Patient",
        initials:
          (currentName || "UP")
            .split(/\s+/)
            .slice(0, 2)
            .map((part) => part[0])
            .join("")
            .toUpperCase() || "PT",
        age: currentAge,
        ageMonths: currentAgeMonths,
        gender: currentGender || "Other",
        phone: currentPhone,
        lastVisit: patient?.lastVisit || "No visits yet",
        allergies: patient?.allergies || [],
        conditions: patient?.conditions || [],
        dateOfBirth: currentDateOfBirth,
        alternatePhone: currentAlternatePhone,
        address: currentAddress,
        registeredAt:
          currentRegisteredAt ||
          patient?.registeredAt ||
          new Date().toISOString(),
      }

      const result = await onSave(
        candidatePatient,
        false,
        clientMutationIdRef.current,
        false,
      )

      if (result && typeof result === "object" && "id" in result) {
        createdPatientIdRef.current = (result as Patient).id
      } else {
        createdPatientIdRef.current = targetId
      }
      setAutoSaveStatus("saved")
      setDirty(false)

      // Once the patient is safely registered in SQLite / patientRecords, clear unpersisted form draft
      try {
        window.localStorage.removeItem(draftPatientKey)
      } catch {}
    } catch (err) {
      console.warn("[Cliniqo] Patient auto-save failed:", err)
      setAutoSaveStatus("error")
    }
  }

  const triggerDebouncedAutoSave = () => {
    setDirty(true)
    if (!isInitialDraftLoadedRef.current) return
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current)
    }
    autoSaveTimerRef.current = setTimeout(() => {
      executePatientAutoSave()
    }, 700)
  }

  const handleBlurCapture = () => {
    if (!isInitialDraftLoadedRef.current) return
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current)
    }
    executePatientAutoSave()
  }

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
    if (!registerNavigationInterceptor) return
    const unregister = registerNavigationInterceptor(async () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current)
      }
      await executePatientAutoSave()
    })
    return unregister
  }, [registerNavigationInterceptor, name, phone, patient, nextPatientId])

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        executePatientAutoSave()
      }
    }
    const handleBeforeUnload = () => {
      executePatientAutoSave()
    }
    document.addEventListener("visibilitychange", handleVisibilityChange)
    window.addEventListener("beforeunload", handleBeforeUnload)
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange)
      window.removeEventListener("beforeunload", handleBeforeUnload)
    }
  }, [name, phone, patient, nextPatientId])

  const leave = async () => {
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current)
    }
    if (dirty || name.trim() || phone.trim()) {
      await executePatientAutoSave()
    }
    go("patients")
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

        const targetId =
          patient?.id || createdPatientIdRef.current || nextPatientId

        await onSave(
          {
            id: targetId,
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
          true,
        )
        setDirty(false)
        try {
          window.localStorage.removeItem(draftPatientKey)
        } catch {}
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
        {autoSaveStatus === "saving" && (
          <span
            className="autosave-status text-xs text-slate-500 dark:text-slate-400 flex items-center gap-1.5 px-2 py-1"
            role="status"
          >
            <Loader2 size={13} className="animate-spin" /> Saving...
          </span>
        )}
        {autoSaveStatus === "saved" && (
          <span
            className="autosave-status text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5 px-2 py-1"
            role="status"
          >
            <Check size={13} /> Saved
          </span>
        )}
        {autoSaveStatus === "error" && (
          <span
            className="autosave-status text-xs text-rose-600 dark:text-rose-400 flex items-center gap-1.5 px-2 py-1"
            role="alert"
          >
            <AlertCircle size={13} /> Unable to save –{" "}
            <button
              type="button"
              className="underline hover:text-rose-700 font-medium cursor-pointer ml-1"
              onClick={executePatientAutoSave}
            >
              Retry
            </button>
          </span>
        )}
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
        onChange={triggerDebouncedAutoSave}
        onInput={triggerDebouncedAutoSave}
        onBlurCapture={handleBlurCapture}
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
                    {saveError.sqlite_error_code &&
                      !saveError.message.includes(
                        saveError.sqlite_error_code,
                      ) && (
                        <span style={{ marginLeft: "4px", opacity: 0.8 }}>
                          (Code: {saveError.sqlite_error_code})
                        </span>
                      )}
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
          try {
            window.localStorage.removeItem(draftPatientKey)
          } catch {}
          go("patients")
        }}
        onCancel={() => setShowDiscardConfirm(false)}
      />
    </>
  )
}
