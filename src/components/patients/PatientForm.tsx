import { useState, useMemo, useEffect, type FormEvent } from "react"
import {
  Button,
  ConfirmDialog,
  Field,
  FormSection,
  IconButton,
  SelectInput,
  StatusPill,
  TextArea,
  TextInput,
} from "../common"
import { AppHeader } from "../layout"
import type { Page, Patient } from "../../types"
import {
  Activity,
  AlertCircle,
  ArrowLeft,
  Cloud,
  ShieldCheck,
  Stethoscope,
  UserRound,
} from "lucide-react"

export function PatientForm({
  go,
  onSave,
  onReviewPatient,
  patient,
  patients,
  nextPatientId,
}: {
  go: (page: Page) => void
  onSave: (patient: Patient, startConsultation?: boolean) => void
  onReviewPatient: (patient: Patient) => void
  patient: Patient | null
  patients: Patient[]
  nextPatientId: string
}) {
  const [submitted, setSubmitted] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false)
  const [name, setName] = useState(patient?.name || "")
  const [phone, setPhone] = useState(patient?.phone || "")
  const [dirty, setDirty] = useState(false)

  const editing = Boolean(patient)
  const normalizedPhone = phone.replace(/\D/g, "").slice(-10)

  const duplicatePatient = useMemo(
    () =>
      normalizedPhone.length === 10
        ? patients.find(
            (record) =>
              record.id !== patient?.id &&
              record.phone.replace(/\D/g, "").slice(-10) === normalizedPhone,
          )
        : undefined,
    [normalizedPhone, patient?.id, patients],
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

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const form = event.currentTarget as HTMLFormElement
    setSubmitted(true)

    if (
      !form.checkValidity() ||
      !name.trim() ||
      normalizedPhone.length !== 10
    ) {
      return form.reportValidity()
    }

    if (!duplicatePatient) {
      const submitter = (event.nativeEvent as SubmitEvent)
        .submitter as HTMLButtonElement | null
      const data = new FormData(form)
      const submittedName = name.trim()
      const allergyText = String(data.get("allergies") || "")
      const conditionText = String(data.get("conditions") || "")

      setIsSaving(true)
      try {
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
            age: Number(data.get("age")),
            gender: String(data.get("gender")),
            phone: String(data.get("phone")),
            lastVisit: patient?.lastVisit || "No visits yet",
            allergies: allergyText
              .split(",")
              .map((item) => item.trim())
              .filter(Boolean),
            conditions: conditionText
              .split(",")
              .map((item) => item.trim())
              .filter(Boolean),
            dateOfBirth: String(data.get("dateOfBirth") || ""),
            alternatePhone: String(data.get("alternatePhone") || ""),
            address: String(data.get("address") || ""),
          },
          submitter?.value === "consultation",
        )
        setDirty(false)
      } finally {
        setIsSaving(false)
      }
    }
  }

  return (
    <>
      <AppHeader
        title={editing ? "Edit patient" : "Add new patient"}
        subtitle={
          editing
            ? `Update ${patient?.name} without changing their patient ID or clinical history`
            : "Create a separate demographic record before starting a consultation"
        }
      >
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
          disabled={isSaving}
          loading={isSaving}
        >
          Save & start consultation
        </Button>
      </AppHeader>

      <form
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

          <FormSection
            icon={UserRound}
            title="Personal details"
            description="Core patient demographics"
          >
            <div className="form-grid three">
              <Field
                label="Full name"
                required
                error={
                  submitted && !name.trim()
                    ? "Full name is required"
                    : undefined
                }
                className="span-two"
              >
                <TextInput
                  name="name"
                  required
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Enter patient's full name"
                  aria-invalid={submitted && !name.trim()}
                />
              </Field>
              <Field
                label="Patient ID"
                hint={
                  editing
                    ? "Patient ID cannot be changed"
                    : "Generated automatically"
                }
              >
                <TextInput value={patient?.id || nextPatientId} readOnly />
              </Field>
              <Field label="Date of birth">
                <TextInput
                  name="dateOfBirth"
                  type="date"
                  defaultValue={patient?.dateOfBirth || ""}
                />
              </Field>
              <Field label="Age" required>
                <TextInput
                  name="age"
                  required
                  type="number"
                  defaultValue={patient?.age}
                  placeholder="Years"
                  min="0"
                  max="120"
                />
              </Field>
              <Field label="Gender" required>
                <SelectInput
                  name="gender"
                  required
                  defaultValue={patient?.gender || ""}
                  style={{ height: "40px" }}
                >
                  <option value="" disabled>
                    Select gender
                  </option>
                  <option>Female</option>
                  <option>Male</option>
                  <option>Non-binary</option>
                  <option>Prefer not to say</option>
                </SelectInput>
              </Field>
              <Field
                label="Mobile number"
                required
                error={
                  submitted && normalizedPhone.length !== 10
                    ? "Enter a valid 10-digit mobile number"
                    : undefined
                }
                className="span-two"
              >
                <TextInput
                  name="phone"
                  required
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+91 00000 00000"
                  aria-invalid={submitted && normalizedPhone.length !== 10}
                />
              </Field>
              <Field label="Alternate phone" hint="Optional">
                <TextInput
                  name="alternatePhone"
                  type="tel"
                  defaultValue={patient?.alternatePhone || ""}
                  placeholder="+91 00000 00000"
                />
              </Field>
              <Field label="Address" hint="Optional" className="full">
                <TextArea
                  name="address"
                  rows={2}
                  defaultValue={patient?.address || ""}
                  placeholder="House / street, locality, city, postal code"
                />
              </Field>
            </div>
          </FormSection>

          <FormSection
            icon={Activity}
            title="Clinical background"
            description="Long-term details that apply across visits"
          >
            <div className="form-grid two">
              <Field label="Known allergies">
                <TextArea
                  name="allergies"
                  rows={3}
                  defaultValue={patient?.allergies.join(", ") || ""}
                  placeholder="e.g. Drug, food, or environmental allergies"
                />
              </Field>
              <Field label="Medical conditions">
                <TextArea
                  name="conditions"
                  rows={3}
                  defaultValue={patient?.conditions.join(", ") || ""}
                  placeholder="Existing or chronic conditions"
                />
              </Field>
            </div>
          </FormSection>

          <div className="patient-form-actions">
            <div>
              <strong>
                {editing ? "Ready to save changes?" : "Ready to continue?"}
              </strong>
              <p>
                {editing
                  ? "The existing record will be updated while visit and prescription history stays preserved."
                  : "Save the patient record, then choose whether to open their first consultation now."}
              </p>
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
              disabled={isSaving}
              loading={isSaving}
            >
              Save & start consultation
            </Button>
          </div>
        </div>

        <aside className="form-aside">
          <div className="aside-tip">
            <ShieldCheck size={19} />
            <h3>Patient record integrity</h3>
            <p>
              Demographics are stored with AES-256-GCM zero-plaintext
              encryption. Finalized visits and prescriptions are preserved as
              immutable history.
            </p>
          </div>
          <div className="aside-tip">
            <Cloud size={19} />
            <h3>Encrypted offline persistence</h3>
            <p>
              Records are saved directly to local encrypted SQLite storage and
              synchronized with the server.
            </p>
            <StatusPill tone="success">Encrypted SQLite</StatusPill>
          </div>
        </aside>
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
