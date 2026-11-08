import { useState, useEffect, useRef } from "react"
import { Building2, Upload, AlertCircle } from "lucide-react"
import { Button, Field, TextInput, SelectInput } from "../common"

import {
  type DesktopSessionContext,
  type ClinicProfile,
  type DoctorProfile,
  getClinicProfile,
  saveClinicProfile,
  getDoctorProfile,
  saveDoctorProfile,
} from "../../desktop/desktop-bridge"

export interface SettingsProfileProps {
  title: string
  description?: string
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

  // Doctor profile form state
  const [docFullName, setDocFullName] = useState(
    desktopSession?.doctor_name || "",
  )
  const [docGender, setDocGender] = useState("Male")
  const [docQualification, setDocQualification] = useState("")
  const [docRegistrationNumber, setDocRegistrationNumber] = useState("")
  const [docMobile, setDocMobile] = useState("")
  const [docEmail, setDocEmail] = useState(desktopSession?.doctor_email || "")

  // File upload state for Doctor Photo & Clinic Logo
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [fileError, setFileError] = useState("")

  const [doctorPhoto, setDoctorPhoto] = useState<string | null>(() => {
    if (typeof window === "undefined" || !window.localStorage) return null
    return (
      (desktopSession?.doctor_id &&
        window.localStorage.getItem(
          `cliniqo_doctor_photo_${desktopSession.doctor_id}`,
        )) ||
      window.localStorage.getItem("cliniqo_doctor_photo") ||
      null
    )
  })

  const [clinicLogo, setClinicLogo] = useState<string | null>(() => {
    if (typeof window === "undefined" || !window.localStorage) return null
    return (
      (desktopSession?.clinic_id &&
        window.localStorage.getItem(
          `cliniqo_clinic_logo_${desktopSession.clinic_id}`,
        )) ||
      window.localStorage.getItem("cliniqo_clinic_logo") ||
      null
    )
  })

  useEffect(() => {
    if (typeof window === "undefined" || !window.localStorage) return
    if (desktopSession?.doctor_id) {
      const stored = window.localStorage.getItem(
        `cliniqo_doctor_photo_${desktopSession.doctor_id}`,
      )
      if (stored) setDoctorPhoto(stored)
    }
  }, [desktopSession?.doctor_id])

  useEffect(() => {
    if (typeof window === "undefined" || !window.localStorage) return
    if (desktopSession?.clinic_id) {
      const stored = window.localStorage.getItem(
        `cliniqo_clinic_logo_${desktopSession.clinic_id}`,
      )
      if (stored) setClinicLogo(stored)
    }
  }, [desktopSession?.clinic_id])

  const handleFileSelect = (file?: File) => {
    if (!file) return
    if (!["image/png", "image/jpeg"].includes(file.type)) {
      setFileError("Upload a PNG or JPG image.")
      return
    }
    if (file.size > 2 * 1024 * 1024) {
      setFileError("Image must be smaller than 2 MB.")
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result)
      if (clinic) {
        setClinicLogo(dataUrl)
        if (typeof window !== "undefined" && window.localStorage) {
          window.localStorage.setItem("cliniqo_clinic_logo", dataUrl)
          if (desktopSession?.clinic_id) {
            window.localStorage.setItem(
              `cliniqo_clinic_logo_${desktopSession.clinic_id}`,
              dataUrl,
            )
          }
        }
      } else {
        setDoctorPhoto(dataUrl)
        if (typeof window !== "undefined" && window.localStorage) {
          window.localStorage.setItem("cliniqo_doctor_photo", dataUrl)
          if (desktopSession?.doctor_id) {
            window.localStorage.setItem(
              `cliniqo_doctor_photo_${desktopSession.doctor_id}`,
              dataUrl,
            )
          }
        }
      }
      setFileError("")
    }
    reader.onerror = () =>
      setFileError("We couldn’t read that image. Please try another file.")
    reader.readAsDataURL(file)
  }

  const handleRemoveImage = () => {
    if (clinic) {
      setClinicLogo(null)
      if (typeof window !== "undefined" && window.localStorage) {
        window.localStorage.removeItem("cliniqo_clinic_logo")
        if (desktopSession?.clinic_id) {
          window.localStorage.removeItem(
            `cliniqo_clinic_logo_${desktopSession.clinic_id}`,
          )
        }
      }
    } else {
      setDoctorPhoto(null)
      if (typeof window !== "undefined" && window.localStorage) {
        window.localStorage.removeItem("cliniqo_doctor_photo")
        if (desktopSession?.doctor_id) {
          window.localStorage.removeItem(
            `cliniqo_doctor_photo_${desktopSession.doctor_id}`,
          )
        }
      }
    }
    setFileError("")
  }

  useEffect(() => {
    if (clinic || !desktopSession?.doctor_id) return
    getDoctorProfile(desktopSession.doctor_id).then((profile) => {
      if (profile) {
        if (profile.full_name) setDocFullName(profile.full_name)
        if (profile.gender) setDocGender(profile.gender)
        if (profile.qualification) setDocQualification(profile.qualification)
        if (profile.registration_number)
          setDocRegistrationNumber(profile.registration_number)
        if (profile.phone) setDocMobile(profile.phone)
        if (profile.email) setDocEmail(profile.email)
      }
    })
  }, [clinic, desktopSession?.doctor_id])

  useEffect(() => {
    if (clinic || !onSave) return
    onSave(async () => {
      if (!desktopSession?.doctor_id) return true
      try {
        await saveDoctorProfile({
          doctor_id: desktopSession.doctor_id,
          full_name: docFullName.trim() || desktopSession.doctor_name,
          email: docEmail.trim() || desktopSession.doctor_email,
          phone: docMobile.trim(),
          qualification: docQualification.trim(),
          registration_number: docRegistrationNumber.trim(),
          gender: docGender || "Male",
        })
        return true
      } catch (err) {
        console.error("Failed to save doctor profile:", err)
        return false
      }
    })
  }, [
    clinic,
    onSave,
    desktopSession?.doctor_id,
    desktopSession?.doctor_name,
    desktopSession?.doctor_email,
    docFullName,
    docGender,
    docQualification,
    docRegistrationNumber,
    docMobile,
    docEmail,
  ])

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
        {description && <p>{description}</p>}
      </div>
      <div className="photo-upload">
        <span
          className={clinic ? "clinic-logo-placeholder" : "photo-placeholder"}
        >
          {clinic ? (
            clinicLogo ? (
              <img src={clinicLogo} alt="Clinic logo" />
            ) : (
              <Building2 size={24} />
            )
          ) : doctorPhoto ? (
            <img src={doctorPhoto} alt="Doctor profile" />
          ) : (
            doctorInitials
          )}
        </span>
        <div>
          <strong>{clinic ? "Clinic logo" : "Profile photo"}</strong>
          <p>PNG or JPG, up to 2 MB</p>
        </div>
        <input
          ref={fileInputRef}
          className="sr-only"
          type="file"
          accept="image/png,image/jpeg"
          onChange={(event) => {
            handleFileSelect(event.target.files?.[0])
            event.target.value = ""
          }}
        />
        {(clinic ? clinicLogo : doctorPhoto) && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={handleRemoveImage}
          >
            Remove
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="secondary"
          icon={Upload}
          onClick={() => fileInputRef.current?.click()}
        >
          {(clinic ? clinicLogo : doctorPhoto) ? "Replace" : "Upload"}
        </Button>
      </div>
      {fileError && (
        <div className="photo-upload-error" role="alert">
          <AlertCircle size={15} />
          {fileError}
        </div>
      )}
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
                value={docFullName}
                onChange={(e) => setDocFullName(e.target.value)}
                placeholder="Enter your full name"
              />
            </Field>
            <Field label="Gender">
              <SelectInput
                value={docGender}
                onChange={(e) => setDocGender(e.target.value)}
                style={{ height: "40px" }}
              >
                <option value="Male">Male</option>
                <option value="Female">Female</option>
                <option value="Non-binary">Non-binary</option>
                <option value="Prefer not to say">Prefer not to say</option>
              </SelectInput>
            </Field>
            <Field label="Qualifications">
              <TextInput
                value={docQualification}
                onChange={(e) => setDocQualification(e.target.value)}
                placeholder="e.g. MBBS, MD"
              />
            </Field>
            <Field label="Registration number">
              <TextInput
                value={docRegistrationNumber}
                onChange={(e) => setDocRegistrationNumber(e.target.value)}
                placeholder="e.g. MMC 2024/01/1234"
              />
            </Field>
            <Field label="Mobile number">
              <TextInput
                value={docMobile}
                onChange={(e) => setDocMobile(e.target.value)}
                placeholder="+91 00000 00000"
              />
            </Field>
            <Field label="Email">
              <TextInput
                value={docEmail}
                onChange={(e) => setDocEmail(e.target.value)}
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
