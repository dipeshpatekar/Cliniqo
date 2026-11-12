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
  onSave: (patient: Patient, startConsultation?: boolean) => void
  onReviewPatient: (patient: Patient) => void
  patient: Patient | null
  patients: Patient[]
  nextPatientId: string
  fieldPreferences?: PatientFormFieldPreferences
}) {
  const [submitted, setSubmitted] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false)
  const [name, setName] = useState(patient?.name || "")
  const [phone, setPhone] = useState(patient?.phone || "")
  const [dirty, setDirty] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)
  const isSavingRef = useRef(false)
  const nameInputRef = useRef<HTMLInputElement>(null)

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
            age: data.get("age")
              ? Number(data.get("age"))
              : (patient?.age ?? 0),
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
        )
        setDirty(false)
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
      }
    }
    window.addEventListener("cliniqo-shortcut", handleShortcut)
    return () => {
      window.removeEventListener("cliniqo-shortcut", handleShortcut)
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
                <TextInput
                  name="age"
                  type="number"
                  defaultValue={patient?.age}
                  placeholder="Years"
                  min="0"
                  max="120"
                />
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
