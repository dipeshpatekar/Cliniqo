import { useRef, useState } from "react"
import {
  Upload,
  ImageIcon,
  PencilLine,
  FileText,
  ExternalLink,
  AlertCircle,
} from "lucide-react"
import type { Page } from "../../types"
import { cn } from "../../utils/cn"
import { Button } from "../common"

export interface PrescriptionSettingsProps {
  go: (page: Page) => void
  bannerVisible: boolean
  onBannerVisibleChange: (visible: boolean) => void
  bannerImage: { src: string; name: string } | null
  onBannerImageChange: (image: { src: string; name: string } | null) => void
  signatureImage: { src: string; name: string } | null
  onSignatureImageChange: (image: { src: string; name: string } | null) => void
  showClinicLogo: boolean
  onShowClinicLogoChange: (visible: boolean) => void
  showClinicEmail: boolean
  onShowClinicEmailChange: (visible: boolean) => void
  showAllergyWarning: boolean
  onShowAllergyWarningChange: (visible: boolean) => void
}

export function PrescriptionSettings({
  go,
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
}: PrescriptionSettingsProps) {
  const bannerInputRef = useRef<HTMLInputElement | null>(null)
  const signatureInputRef = useRef<HTMLInputElement | null>(null)
  const [uploadError, setUploadError] = useState("")
  const [signatureError, setSignatureError] = useState("")

  const uploadBanner = (file?: File) => {
    if (!file) return
    if (!["image/png", "image/jpeg"].includes(file.type)) {
      setUploadError("Upload a PNG or JPG image.")
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      setUploadError("Banner image must be smaller than 5 MB.")
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      onBannerImageChange({ src: String(reader.result), name: file.name })
      onBannerVisibleChange(true)
      setUploadError("")
    }
    reader.onerror = () =>
      setUploadError("We couldn’t read that image. Please try another file.")
    reader.readAsDataURL(file)
  }

  const uploadSignature = (file?: File) => {
    if (!file) return
    if (!["image/png", "image/jpeg"].includes(file.type)) {
      setSignatureError("Upload a PNG or JPG image.")
      return
    }
    if (file.size > 2 * 1024 * 1024) {
      setSignatureError("Signature image must be smaller than 2 MB.")
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      onSignatureImageChange({ src: String(reader.result), name: file.name })
      setSignatureError("")
    }
    reader.onerror = () =>
      setSignatureError("We couldn’t read that image. Please try another file.")
    reader.readAsDataURL(file)
  }

  return (
    <section className="settings-section">
      <div className="settings-title">
        <h2>Prescription layout</h2>
      </div>
      <div className="option-list">
        <label>
          <span>
            <strong>Show prescription banner</strong>
          </span>
          <input
            type="checkbox"
            checked={bannerVisible}
            onChange={(event) => onBannerVisibleChange(event.target.checked)}
          />
        </label>
        <label>
          <span>
            <strong>Show clinic logo</strong>
          </span>
          <input
            type="checkbox"
            checked={showClinicLogo}
            onChange={(event) => onShowClinicLogoChange(event.target.checked)}
          />
        </label>
        <label>
          <span>
            <strong>Show clinic email</strong>
          </span>
          <input
            type="checkbox"
            checked={showClinicEmail}
            onChange={(event) => onShowClinicEmailChange(event.target.checked)}
          />
        </label>
        <label>
          <span>
            <strong>Include allergy warning</strong>
          </span>
          <input
            type="checkbox"
            checked={showAllergyWarning}
            onChange={(event) =>
              onShowAllergyWarningChange(event.target.checked)
            }
          />
        </label>
      </div>

      <h3 className="subsection-title">Custom banner image</h3>
      <div
        className={cn("banner-upload-card", !bannerVisible && "banner-muted")}
      >
        <div className="banner-thumbnail">
          {bannerImage ? (
            <img src={bannerImage.src} alt="" />
          ) : (
            <ImageIcon size={24} />
          )}
        </div>
        <div className="banner-upload-copy">
          <strong>
            {bannerImage
              ? bannerImage.name
              : "Use your own prescription banner"}
          </strong>
          <p>
            {bannerImage
              ? "Custom banner will replace the default clinic header."
              : "PNG or JPG · Recommended 1600 × 300 px · Up to 5 MB"}
          </p>
        </div>
        <input
          ref={bannerInputRef}
          className="sr-only"
          type="file"
          accept="image/png,image/jpeg"
          onChange={(event) => {
            uploadBanner(event.target.files?.[0])
            event.target.value = ""
          }}
        />
        {bannerImage && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onBannerImageChange(null)}
          >
            Remove
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          icon={Upload}
          onClick={() => bannerInputRef.current?.click()}
        >
          {bannerImage ? "Replace" : "Upload banner"}
        </Button>
      </div>
      {uploadError && (
        <div className="banner-upload-error" role="alert">
          <AlertCircle size={15} />
          {uploadError}
        </div>
      )}
      {!bannerVisible && (
        <p className="banner-hidden-note">
          <AlertCircle size={14} /> Banner is hidden. Uploads are saved and will
          appear when you turn it back on.
        </p>
      )}

      <h3 className="subsection-title">Doctor’s signature</h3>
      <div className="banner-upload-card">
        <div className="signature-thumbnail">
          {signatureImage ? (
            <img src={signatureImage.src} alt="" />
          ) : (
            <PencilLine size={24} />
          )}
        </div>
        <div className="banner-upload-copy">
          <strong>
            {signatureImage ? signatureImage.name : "Upload doctor’s signature"}
          </strong>
          <p>
            {signatureImage
              ? "Signature will appear above the doctor’s name."
              : "Transparent PNG recommended · JPG supported · Up to 2 MB"}
          </p>
        </div>
        <input
          ref={signatureInputRef}
          className="sr-only"
          type="file"
          accept="image/png,image/jpeg"
          onChange={(event) => {
            uploadSignature(event.target.files?.[0])
            event.target.value = ""
          }}
        />
        {signatureImage && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onSignatureImageChange(null)}
          >
            Remove
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          icon={Upload}
          onClick={() => signatureInputRef.current?.click()}
        >
          {signatureImage ? "Replace" : "Upload signature"}
        </Button>
      </div>
      {signatureError && (
        <div className="banner-upload-error" role="alert">
          <AlertCircle size={15} />
          {signatureError}
        </div>
      )}

      <div className="layout-preview">
        <FileText size={28} />
        <div>
          <strong>A4 clinical prescription</strong>
        </div>
        <Button
          size="sm"
          variant="secondary"
          icon={ExternalLink}
          onClick={() => go("preview")}
        >
          Preview sample
        </Button>
      </div>
    </section>
  )
}

export default PrescriptionSettings
