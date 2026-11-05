import { useState, useEffect } from "react"
import {
  ArrowLeft,
  Printer,
  MessageCircle,
  ReceiptIndianRupee,
  Edit3,
  HeartPulse,
  Paperclip,
  AlertCircle,
  RefreshCw,
  Check,
} from "lucide-react"
import {
  getPublicPatientId,
  type Page,
  type Patient,
  type BillData,
  type BillLayoutPreferences,
} from "../../types"
import { computeBillTotals } from "../../utils/billing"
import { cn } from "../../utils/cn"
import { Button, IconButton, StatusPill, Modal } from "../common"
import { AppHeader } from "../layout"
import {
  getClinicProfile,
  getDoctorProfile,
  type ClinicProfile,
  type DoctorProfile,
  type DesktopSessionContext,
} from "../../desktop/desktop-bridge"

export interface BillPreviewProps {
  go: (page: Page) => void
  patient: Patient
  bill: BillData
  bannerImage: { src: string; name: string } | null
  signatureImage: { src: string; name: string } | null
  layout: BillLayoutPreferences
  returnPage: "bill-form" | "settings" | "patient-profile"
  desktopSession?: DesktopSessionContext | null
}

export function BillPreview({
  go,
  patient,
  bill,
  bannerImage,
  signatureImage,
  layout,
  returnPage,
  desktopSession,
}: BillPreviewProps) {
  const [whatsapp, setWhatsapp] = useState(false)
  const [delivery, setDelivery] = useState<"confirm" | "sending" | "queued">(
    "confirm",
  )

  const [clinicProfile, setClinicProfile] = useState<ClinicProfile | null>(null)
  const [doctorProfile, setDoctorProfile] = useState<DoctorProfile | null>(null)
  const [clinicLogo, setClinicLogo] = useState<string | null>(null)

  useEffect(() => {
    if (desktopSession?.clinic_id) {
      getClinicProfile(desktopSession.clinic_id).then((p) => {
        if (p) setClinicProfile(p)
      })
      if (typeof window !== "undefined" && window.localStorage) {
        const storedLogo =
          window.localStorage.getItem(`cliniqo_clinic_logo_${desktopSession.clinic_id}`) ||
          window.localStorage.getItem("cliniqo_clinic_logo")
        if (storedLogo) setClinicLogo(storedLogo)
      }
    }
    if (desktopSession?.doctor_id) {
      getDoctorProfile(desktopSession.doctor_id).then((doc) => {
        if (doc) setDoctorProfile(doc)
      })
    }
  }, [desktopSession?.clinic_id, desktopSession?.doctor_id])

  const {
    subtotalRupees,
    discountRupees,
    taxRatePercent,
    taxRupees,
    totalRupees,
  } = computeBillTotals(bill.items, bill.discount, bill.taxRatePercent)

  const formattedDate = bill.date
    ? new Date(`${bill.date}T00:00:00`).toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "long",
        year: "numeric",
      })
    : "—"

  const isFinalized = bill.status === "FINALIZED"
  const doctorName = desktopSession?.doctor_name || "Doctor"

  const sendBill = () => {
    setDelivery("sending")
    window.setTimeout(() => setDelivery("queued"), 900)
  }

  return (
    <>
      <AppHeader
        title="Bill preview"
        subtitle={`${bill.invoiceNumber} · ${bill.paymentStatus} · ${
          isFinalized ? "Finalized" : "Draft"
        }`}
      >
        <IconButton
          className="topbar-back"
          label={
            returnPage === "settings" ? "Back to bill settings" : "Back to bill"
          }
          onClick={() => go(returnPage)}
        >
          <ArrowLeft size={18} />
        </IconButton>
        <Button
          variant="secondary"
          icon={Printer}
          onClick={() => window.print()}
        >
          Print bill
        </Button>
        <Button
          icon={MessageCircle}
          onClick={() => {
            setDelivery("confirm")
            setWhatsapp(true)
          }}
        >
          Preview WhatsApp flow
        </Button>
      </AppHeader>

      <div className="preview-page">
        <div className="preview-note bill-preview-note">
          <ReceiptIndianRupee size={17} />
          <span>
            {isFinalized
              ? "Finalized tax invoice. Ready for patient delivery and printing."
              : "Review the bill draft details before finalizing or printing."}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => go("bill-form")}
            icon={Edit3}
          >
            {isFinalized ? "View invoice" : "Edit bill"}
          </Button>
        </div>

        <article className="prescription-paper bill-paper" id="printable-bill">
          <div
            className={cn(
              "rx-banner-slot",
              !layout.showBanner && "rx-content-hidden",
            )}
          >
            {bannerImage ? (
              <div className="rx-custom-banner">
                <img src={bannerImage.src} alt="Custom bill banner" />
              </div>
            ) : (
              <header className="rx-header">
                <div className="rx-clinic">
                  <span
                    className={cn(
                      "rx-logo",
                      !layout.showClinicLogo && "rx-content-hidden",
                    )}
                  >
                    {clinicLogo ? (
                      <img
                        src={clinicLogo}
                        alt="Clinic logo"
                        style={{ width: "100%", height: "100%", objectFit: "contain", borderRadius: "4px" }}
                      />
                    ) : (
                      <HeartPulse size={24} />
                    )}
                  </span>
                  <div>
                    <h2>{clinicProfile?.name || (desktopSession?.clinic_id ? `Clinic ${desktopSession.clinic_id}` : "Medical Clinic")}</h2>
                    <p>
                      {[clinicProfile?.street, clinicProfile?.city, clinicProfile?.state, clinicProfile?.postal_code]
                        .filter(Boolean)
                        .join(", ") || (desktopSession?.clinic_id ? "Registered Healthcare Facility" : "Local Clinic Workspace")}
                    </p>
                    {clinicProfile?.phone && (
                      <p style={{ fontSize: "11px", color: "var(--text-muted, #64748b)" }}>
                        Ph: {clinicProfile.phone}
                      </p>
                    )}
                    {(clinicProfile?.email || desktopSession?.doctor_email) && (
                      <p>
                        <span
                          className={cn(
                            !layout.showClinicEmail && "rx-content-hidden",
                          )}
                        >
                          {clinicProfile?.email || desktopSession?.doctor_email}
                        </span>
                      </p>
                    )}
                  </div>
                </div>
                <div className="rx-doctor">
                  <strong>{desktopSession?.doctor_name || doctorProfile?.full_name || doctorName}</strong>
                  <span>{doctorProfile?.qualification || (desktopSession ? "Authorized Medical Practitioner" : "Medical Practitioner")}</span>
                  {doctorProfile?.registration_number && (
                    <span>Reg. No: {doctorProfile.registration_number}</span>
                  )}
                  {doctorProfile?.phone && (
                    <span>Ph: {doctorProfile.phone}</span>
                  )}
                </div>
              </header>
            )}
          </div>

          <div className="bill-title">
            <div>
              <span>Tax invoice</span>
              <h2>Patient bill</h2>
            </div>
            <div style={{ display: "flex", gap: "8px" }}>
              <StatusPill tone={isFinalized ? "success" : "warning"}>
                {isFinalized ? "Finalized" : "Draft"}
              </StatusPill>
              <StatusPill
                tone={bill.paymentStatus === "Paid" ? "success" : "neutral"}
              >
                {bill.paymentStatus}
              </StatusPill>
            </div>
          </div>

          <section className="rx-patient">
            <div>
              <span>Billed to</span>
              <strong>{patient.name}</strong>
              <small>
                {patient.age} years · {patient.gender} · {patient.phone}
              </small>
            </div>
            <div>
              <span>Patient ID</span>
              <strong>{getPublicPatientId(patient)}</strong>
            </div>
            <div>
              <span>Invoice date</span>
              <strong>{formattedDate}</strong>
            </div>
          </section>

          <section className="bill-document">
            <div className="bill-number">
              <span>Invoice number</span>
              <strong>{bill.invoiceNumber}</strong>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Service or item</th>
                  <th>Qty</th>
                  <th>Rate</th>
                  <th>Amount</th>
                </tr>
              </thead>
              <tbody>
                {bill.items
                  .filter((item) => item.description.trim())
                  .map((item) => (
                    <tr key={item.id}>
                      <td>{item.description}</td>
                      <td>{item.quantity}</td>
                      <td>
                        ₹
                        {item.rate.toLocaleString("en-IN", {
                          minimumFractionDigits: 2,
                        })}
                      </td>
                      <td>
                        ₹
                        {(item.quantity * item.rate).toLocaleString("en-IN", {
                          minimumFractionDigits: 2,
                        })}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            <div className="bill-document-totals">
              <div>
                <span>Subtotal</span>
                <strong>
                  ₹
                  {subtotalRupees.toLocaleString("en-IN", {
                    minimumFractionDigits: 2,
                  })}
                </strong>
              </div>
              {discountRupees > 0 && (
                <div>
                  <span>Discount</span>
                  <strong>
                    − ₹
                    {discountRupees.toLocaleString("en-IN", {
                      minimumFractionDigits: 2,
                    })}
                  </strong>
                </div>
              )}
              {taxRatePercent > 0 && (
                <div>
                  <span>GST ({taxRatePercent}%)</span>
                  <strong>
                    + ₹
                    {taxRupees.toLocaleString("en-IN", {
                      minimumFractionDigits: 2,
                    })}
                  </strong>
                </div>
              )}
              <div className="grand-total">
                <span>Total amount</span>
                <strong>
                  ₹
                  {totalRupees.toLocaleString("en-IN", {
                    minimumFractionDigits: 2,
                  })}
                </strong>
              </div>
            </div>
          </section>

          {bill.notes && (
            <section
              style={{
                margin: "14px 0",
                padding: "10px 14px",
                background: "#f8fafc",
                border: "1px solid #e2e8f0",
                borderRadius: "6px",
                fontSize: "11px",
              }}
            >
              <strong>Remarks:</strong> {bill.notes}
            </section>
          )}

          <section
            className={cn(
              "bill-payment-note",
              !layout.showPaymentNote && "rx-content-hidden",
            )}
          >
            <strong>Payment status: {bill.paymentStatus}</strong>
            <span>
              Thank you for choosing {clinicProfile?.name || "our clinic"}. Please retain this bill
              for your records.
            </span>
          </section>

          <footer className="rx-footer bill-footer">
            <div>
              <span>For {clinicProfile?.name || "Authorized Clinic"}</span>
              <strong>Authorized medical services bill</strong>
            </div>
            <div
              className={cn(
                "signature",
                !layout.showSignature && "rx-content-hidden",
              )}
            >
              {signatureImage && (
                <img
                  src={signatureImage.src}
                  alt={`${doctorName}’s signature`}
                />
              )}
              <span>Doctor’s signature</span>
              <strong>{doctorName}</strong>
            </div>
          </footer>
        </article>
      </div>

      {whatsapp && (
        <Modal
          title="Bill WhatsApp flow preview"
          description="Frontend-only illustration; no message or PDF will be created."
          onClose={() => setWhatsapp(false)}
        >
          {delivery === "confirm" && (
            <>
              <div className="send-summary">
                <span className="avatar">{patient.initials}</span>
                <div>
                  <small>Patient</small>
                  <strong>{patient.name}</strong>
                  <span>{patient.phone}</span>
                </div>
              </div>
              <div className="document-row">
                <span>
                  <ReceiptIndianRupee size={20} />
                </span>
                <div>
                  <strong>Bill · {bill.invoiceNumber}</strong>
                  <small>
                    ₹
                    {totalRupees.toLocaleString("en-IN", {
                      minimumFractionDigits: 2,
                    })}{" "}
                    · Local preview only
                  </small>
                </div>
                <Paperclip size={16} />
              </div>
              <div className="delivery-disclaimer">
                <AlertCircle size={17} />
                <p>
                  No API request is sent. Real queued and delivery states
                  require a WhatsApp provider response.
                </p>
              </div>
              <div className="modal-actions">
                <Button variant="ghost" onClick={() => setWhatsapp(false)}>
                  Cancel
                </Button>
                <Button icon={MessageCircle} onClick={sendBill}>
                  Preview queued state
                </Button>
              </div>
            </>
          )}
          {delivery === "sending" && (
            <div className="delivery-state">
              <span className="state-icon loading">
                <RefreshCw className="spin" size={25} />
              </span>
              <h3>Preparing demo state…</h3>
              <p>No external service is being contacted.</p>
            </div>
          )}
          {delivery === "queued" && (
            <div className="delivery-state">
              <span className="state-icon success">
                <Check size={25} />
              </span>
              <h3>Demo: bill queued</h3>
              <p>This illustrates provider acceptance; no bill was sent.</p>
              <div className="modal-actions">
                <Button onClick={() => setWhatsapp(false)}>Done</Button>
              </div>
            </div>
          )}
        </Modal>
      )}
    </>
  )
}

export default BillPreview
