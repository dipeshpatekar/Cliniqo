import { ReceiptIndianRupee, ExternalLink } from "lucide-react"
import type { Page, BillLayoutPreferences } from "../../types"
import { Button } from "../common"

export interface BillLayoutSettingsProps {
  go: (page: Page) => void
  layout: BillLayoutPreferences
  onChange: (layout: BillLayoutPreferences) => void
  bannerImage: { src: string; name: string } | null
  signatureImage: { src: string; name: string } | null
}

export function BillLayoutSettings({
  go,
  layout,
  onChange,
  bannerImage,
  signatureImage,
}: BillLayoutSettingsProps) {
  const update = (key: keyof BillLayoutPreferences, visible: boolean) =>
    onChange({ ...layout, [key]: visible })

  return (
    <section className="settings-section">
      <div className="settings-title">
        <h2>Bill layout</h2>
      </div>
      <div className="option-list">
        <label>
          <span>
            <strong>Show bill banner</strong>
          </span>
          <input
            type="checkbox"
            checked={layout.showBanner}
            onChange={(event) => update("showBanner", event.target.checked)}
          />
        </label>
        <label>
          <span>
            <strong>Show clinic logo</strong>
          </span>
          <input
            type="checkbox"
            checked={layout.showClinicLogo}
            onChange={(event) => update("showClinicLogo", event.target.checked)}
          />
        </label>
        <label>
          <span>
            <strong>Show clinic email</strong>
          </span>
          <input
            type="checkbox"
            checked={layout.showClinicEmail}
            onChange={(event) =>
              update("showClinicEmail", event.target.checked)
            }
          />
        </label>
        <label>
          <span>
            <strong>Show doctor’s signature</strong>
          </span>
          <input
            type="checkbox"
            checked={layout.showSignature}
            onChange={(event) => update("showSignature", event.target.checked)}
          />
        </label>
        <label>
          <span>
            <strong>Show payment note</strong>
          </span>
          <input
            type="checkbox"
            checked={layout.showPaymentNote}
            onChange={(event) =>
              update("showPaymentNote", event.target.checked)
            }
          />
        </label>
      </div>
      <div className="info-callout">
        <ReceiptIndianRupee size={17} />
        <p>
          Bill layout uses the{" "}
          {bannerImage ? "custom clinic banner" : "default clinic banner"} and{" "}
          {signatureImage
            ? "uploaded doctor’s signature"
            : "standard signature footer"}{" "}
          configured in Prescription layout. Hidden items keep their space, so
          the bill structure does not shift.
        </p>
      </div>
      <div className="layout-preview">
        <ReceiptIndianRupee size={28} />
        <div>
          <strong>A4 patient bill</strong>
          <p>
            {layout.showBanner ? "Clinic banner" : "Banner hidden"} · Itemized
            charges ·{" "}
            {layout.showSignature ? "Signature footer" : "Signature hidden"}
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          icon={ExternalLink}
          onClick={() => go("bill-preview")}
        >
          Preview sample
        </Button>
      </div>
    </section>
  )
}

export default BillLayoutSettings
