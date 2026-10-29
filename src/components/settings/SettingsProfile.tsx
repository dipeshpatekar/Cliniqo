import { Building2, Upload } from "lucide-react"
import { Button, Field, TextInput, SelectInput } from "../common"

import type { DesktopSessionContext } from "../../desktop/desktop-bridge"

export interface SettingsProfileProps {
  title: string
  description: string
  clinic: boolean
  desktopSession?: DesktopSessionContext | null
}

export function SettingsProfile({
  title,
  description,
  clinic,
  desktopSession,
}: SettingsProfileProps) {
  const doctorName = desktopSession?.doctor_name || ""
  const doctorInitials = doctorName
    ? doctorName
        .split(" ")
        .filter(Boolean)
        .map((n) => n[0])
        .slice(0, 2)
        .join("")
        .toUpperCase()
    : "DR"

  return (
    <section className="settings-section">
      <div className="settings-title">
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      <div className="photo-upload">
        <span
          className={clinic ? "clinic-logo-placeholder" : "photo-placeholder"}
        >
          {clinic ? <Building2 size={24} /> : doctorInitials}
        </span>
        <div>
          <strong>{clinic ? "Clinic logo" : "Profile photo"}</strong>
          <p>PNG or JPG, up to 2 MB</p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          icon={Upload}
          onClick={() =>
            window.alert("Image picker opened in the production application.")
          }
        >
          Upload
        </Button>
      </div>
      <div className="form-grid two">
        {clinic ? (
          <>
            <Field label="Clinic name">
              <TextInput
                defaultValue={desktopSession?.clinic_id ? `Clinic ${desktopSession.clinic_id}` : ""}
                placeholder="Enter clinic or hospital name"
              />
            </Field>
            <Field label="Clinic phone">
              <TextInput
                defaultValue=""
                placeholder="+91 00000 00000"
              />
            </Field>
            <Field label="Address" className="full">
              <TextInput
                defaultValue=""
                placeholder="Enter clinic address, street, city, pin code"
              />
            </Field>
            <Field label="Email">
              <TextInput
                defaultValue={desktopSession?.doctor_email || ""}
                placeholder="care@clinic.com"
              />
            </Field>
            <Field label="Location link">
              <TextInput placeholder="Add Google Maps link" />
            </Field>
          </>
        ) : (
          <>
            <Field label="Full name">
              <TextInput
                defaultValue={doctorName}
                placeholder="Enter your full name"
              />
            </Field>
            <Field label="Gender">
              <SelectInput defaultValue="Male" style={{ height: "40px" }}>
                <option>Female</option>
                <option>Male</option>
                <option>Non-binary</option>
                <option>Prefer not to say</option>
              </SelectInput>
            </Field>
            <Field label="Qualifications">
              <TextInput
                defaultValue=""
                placeholder="e.g. MBBS, MD"
              />
            </Field>
            <Field label="Registration number">
              <TextInput
                defaultValue=""
                placeholder="e.g. MMC 2024/01/1234"
              />
            </Field>
            <Field label="Mobile number">
              <TextInput
                defaultValue=""
                placeholder="+91 00000 00000"
              />
            </Field>
            <Field label="Email">
              <TextInput
                defaultValue={desktopSession?.doctor_email || ""}
                placeholder="doctor@clinic.com"
              />
            </Field>
          </>
        )}
      </div>
    </section>
  )
}

export default SettingsProfile
