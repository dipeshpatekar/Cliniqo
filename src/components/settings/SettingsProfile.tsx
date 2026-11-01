import { useState, useEffect } from "react"
import { Building2, Upload } from "lucide-react"
import { Button, Field, TextInput, SelectInput } from "../common"

import {
  type DesktopSessionContext,
  type ClinicProfile,
  getClinicProfile,
  saveClinicProfile,
} from "../../desktop/desktop-bridge"

export interface SettingsProfileProps {
  title: string
  description: string
  clinic: boolean
  desktopSession?: DesktopSessionContext | null
  onSave?: (handler: () => Promise<boolean>) => void
  onProfileLoaded?: (profile: ClinicProfile) => void
}

export function SettingsProfile({
  title,
  description,
  clinic,
  desktopSession,
  onSave,
  onProfileLoaded,
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

  // Clinic profile form state
  const [clinicName, setClinicName] = useState(
    desktopSession?.clinic_id ? `Clinic ${desktopSession.clinic_id}` : "",
  )
  const [clinicSlug, setClinicSlug] = useState("")
  const [clinicPhone, setClinicPhone] = useState("")
  const [address, setAddress] = useState("")
  const [city, setCity] = useState("")
  const [stateVal, setStateVal] = useState("")
  const [postalCode, setPostalCode] = useState("")
  const [countryVal, setCountryVal] = useState("India")
  const [clinicEmail, setClinicEmail] = useState(
    desktopSession?.doctor_email || "",
  )
  const [locationLink, setLocationLink] = useState("")

  useEffect(() => {
    if (!clinic || !desktopSession?.clinic_id) return
    getClinicProfile(desktopSession.clinic_id).then((profile) => {
      if (profile) {
        if (profile.name) setClinicName(profile.name)
        if (profile.slug) setClinicSlug(profile.slug)
        if (profile.phone) setClinicPhone(profile.phone)
        if (profile.email) setClinicEmail(profile.email)
        if (profile.street) setAddress(profile.street)
        if (profile.city) setCity(profile.city)
        if (profile.state) setStateVal(profile.state)
        if (profile.postal_code) setPostalCode(profile.postal_code)
        if (profile.country) setCountryVal(profile.country)
        if (profile.location_link) setLocationLink(profile.location_link)
        if (onProfileLoaded) onProfileLoaded(profile)
      }
    })
  }, [clinic, desktopSession?.clinic_id, onProfileLoaded])

  useEffect(() => {
    if (!clinic || !onSave) return
    onSave(async () => {
      if (!desktopSession?.clinic_id) return true
      try {
        await saveClinicProfile({
          clinic_id: desktopSession.clinic_id,
          name:
            clinicName.trim() ||
            (desktopSession?.clinic_id
              ? `Clinic ${desktopSession.clinic_id}`
              : ""),
          slug: clinicSlug.trim(),
          phone: clinicPhone.trim(),
          email: clinicEmail.trim() || desktopSession.doctor_email || "",
          street: address.trim(),
          city: city.trim(),
          state: stateVal.trim(),
          postal_code: postalCode.trim(),
          country: countryVal.trim() || "India",
          location_link: locationLink.trim(),
        })
        return true
      } catch (err) {
        console.error("Failed to save clinic profile:", err)
        return false
      }
    })
  }, [
    clinic,
    onSave,
    desktopSession?.clinic_id,
    desktopSession?.doctor_email,
    clinicName,
    clinicSlug,
    clinicPhone,
    clinicEmail,
    address,
    city,
    stateVal,
    postalCode,
    countryVal,
    locationLink,
  ])

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
                value={clinicName}
                onChange={(e) => setClinicName(e.target.value)}
                placeholder="Enter clinic or hospital name"
              />
            </Field>
            <Field label="Clinic phone">
              <TextInput
                value={clinicPhone}
                onChange={(e) => setClinicPhone(e.target.value)}
                placeholder="+91 00000 00000"
              />
            </Field>
            <Field label="Address" className="full">
              <TextInput
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Enter clinic street address"
              />
            </Field>
            <Field label="City">
              <TextInput
                value={city}
                onChange={(e) => setCity(e.target.value)}
                placeholder="City"
              />
            </Field>
            <Field label="State">
              <TextInput
                value={stateVal}
                onChange={(e) => setStateVal(e.target.value)}
                placeholder="State"
              />
            </Field>
            <Field label="PIN code">
              <TextInput
                value={postalCode}
                onChange={(e) => setPostalCode(e.target.value)}
                placeholder="Postal / PIN code"
              />
            </Field>
            <Field label="Email">
              <TextInput
                value={clinicEmail}
                onChange={(e) => setClinicEmail(e.target.value)}
                placeholder="care@clinic.com"
              />
            </Field>
            <Field label="Location link" className="full">
              <TextInput
                value={locationLink}
                onChange={(e) => setLocationLink(e.target.value)}
                placeholder="Add Google Maps link"
              />
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
