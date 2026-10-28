import { useState, type FormEvent } from "react"
import { Button, Field, Logo, SelectInput, TextInput } from "../common"
import type { Page } from "../../types"
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  ShieldCheck,
  Upload,
  UserRound,
} from "lucide-react"

export function Setup({ go }: { go: (page: Page) => void }) {
  const [step, setStep] = useState(1)
  const [error, setError] = useState(false)
  const next = (event: FormEvent) => {
    event.preventDefault()
    const form = event.currentTarget as HTMLFormElement
    if (!form.checkValidity()) {
      setError(true)
      form.reportValidity()
      return
    }
    if (step < 2) setStep(2)
    else go("dashboard")
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
                  error={error ? "Enter your full name" : undefined}
                >
                  <TextInput
                    required
                    defaultValue="Dr. Nikhil Kanade"
                    placeholder="Dr. Full name"
                  />
                </Field>
                <Field label="Gender" required>
                  <SelectInput
                    id="setup-gender-select"
                    required
                    defaultValue="Male"
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
                    defaultValue="MBBS, MD (Internal Medicine)"
                    placeholder="e.g. MBBS, MD"
                  />
                </Field>
                <Field label="Medical registration number" required>
                  <TextInput
                    required
                    defaultValue="MMC 2011/04/1842"
                    placeholder="Registration number"
                  />
                </Field>
                <Field label="Mobile number" required>
                  <TextInput
                    required
                    defaultValue="+91 98200 76421"
                    type="tel"
                  />
                </Field>
                <Field label="Professional email" required>
                  <TextInput
                    required
                    defaultValue="nikhil@nishtihospital.in"
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
                  <TextInput required defaultValue="Nishti Hospital" />
                </Field>
                <Field label="Clinic phone" required>
                  <TextInput
                    required
                    defaultValue="+91 22 4123 8765"
                    type="tel"
                  />
                </Field>
                <Field label="Address" required className="full">
                  <TextInput
                    required
                    defaultValue="14, Sea View Road, Bandra West"
                  />
                </Field>
                <Field label="City" required>
                  <TextInput required defaultValue="Mumbai" />
                </Field>
                <Field label="Postal code" required>
                  <TextInput required defaultValue="400050" />
                </Field>
                <Field label="Google Maps location" hint="Optional">
                  <TextInput placeholder="Paste location link" />
                </Field>
                <Field label="Clinic email" hint="Optional">
                  <TextInput
                    defaultValue="care@harbourclinic.in"
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
                onClick={() => go("login")}
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
            <Button type="submit">
              {step === 1 ? "Continue" : "Save and continue"}
              <ArrowRight size={16} />
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
