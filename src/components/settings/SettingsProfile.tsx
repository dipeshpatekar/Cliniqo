import { Building2, Upload } from "lucide-react"
import { Button, Field, TextInput, SelectInput } from "../common"

export interface SettingsProfileProps {
  title: string
  description: string
  clinic: boolean
}

export function SettingsProfile({
  title,
  description,
  clinic,
}: SettingsProfileProps) {
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
          {clinic ? <Building2 size={24} /> : "NK"}
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
              <TextInput defaultValue="Nishti Hospital" />
            </Field>
            <Field label="Clinic phone">
              <TextInput defaultValue="+91 22 4123 8765" />
            </Field>
            <Field label="Address" className="full">
              <TextInput defaultValue="14, Sea View Road, Bandra West, Mumbai 400050" />
            </Field>
            <Field label="Email">
              <TextInput defaultValue="care@harbourclinic.in" />
            </Field>
            <Field label="Location link">
              <TextInput placeholder="Add Google Maps link" />
            </Field>
          </>
        ) : (
          <>
            <Field label="Full name">
              <TextInput defaultValue="Dr. Nikhil Kanade" />
            </Field>
            <Field label="Gender">
              <SelectInput defaultValue="Male" style={{ height: "40px" }}>
                <option>Female</option>
                <option>Male</option>
              </SelectInput>
            </Field>
            <Field label="Qualifications">
              <TextInput defaultValue="MBBS, MD (Internal Medicine)" />
            </Field>
            <Field label="Registration number">
              <TextInput defaultValue="MMC 2011/04/1842" />
            </Field>
            <Field label="Mobile number">
              <TextInput defaultValue="+91 98200 76421" />
            </Field>
            <Field label="Email">
              <TextInput defaultValue="nikhil@nishtihospital.in" />
            </Field>
          </>
        )}
      </div>
    </section>
  )
}

export default SettingsProfile
