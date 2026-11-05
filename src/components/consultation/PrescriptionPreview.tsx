import { useState, useEffect } from "react"
import {
  ArrowLeft,
  Printer,
  MessageCircle,
  AlertCircle,
  Edit3,
  HeartPulse,
  FileText,
  Paperclip,
  RefreshCw,
  Check,
  X,
} from "lucide-react"
import { getPublicPatientId, type Page, type Patient, type Vitals, type ConsultationData } from "../../types"
import { formatMedicineDose } from "../../types"
import { cn } from "../../utils/cn"
import { Button, IconButton, Modal } from "../common"
import { AppHeader } from "../layout"
import {
  getClinicProfile,
  getDoctorProfile,
  type ClinicProfile,
  type DoctorProfile,
  type DesktopSessionContext,
} from "../../desktop/desktop-bridge"

export interface PrescriptionPreviewProps {
  go: (page: Page) => void
  patient: Patient
  vitals: Vitals
  data: ConsultationData
  bannerVisible: boolean
  bannerImage: { src: string; name: string } | null
  signatureImage: { src: string; name: string } | null
  showClinicLogo: boolean
  showClinicEmail: boolean
  showAllergyWarning: boolean
  returnPage: "consultation" | "settings"
  desktopSession?: DesktopSessionContext | null
}

export function PrescriptionPreview({
  go,
  patient,
  vitals,
  data,
  bannerVisible,
  bannerImage,
  signatureImage,
  showClinicLogo,
  showClinicEmail,
  showAllergyWarning,
  returnPage,
  desktopSession,
}: PrescriptionPreviewProps) {
  const [whatsapp, setWhatsapp] = useState(false)
  const [delivery, setDelivery] =
    useState<"confirm" | "sending" | "queued" | "failed">("confirm")

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

  const send = () => {
    setDelivery("sending")
    window.setTimeout(() => setDelivery("queued"), 1000)
  }

  return (
    <>
      <AppHeader
        title="Prescription preview"
        subtitle="Local session preview · Not persisted"
      >
        <IconButton
          className="topbar-back"
          label={
            returnPage === "settings"
              ? "Back to prescription settings"
              : "Back to consultation"
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
          Print prescription
        </Button>
        <Button
          icon={MessageCircle}
          onClick={() => {
            setDelivery("confirm")
            setWhatsapp(true)
          }}
        >
          Send on WhatsApp
        </Button>
      </AppHeader>

      <div className="preview-page">
        <div className="preview-note">
          <AlertCircle size={17} />
          <span>
            This is a browser preview using current consultation data. Backend
            storage is required for finalization and revision history.
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => go("consultation")}
            icon={Edit3}
          >
            Edit consultation
          </Button>
        </div>

        <article className="prescription-paper" id="printable-prescription">
          <div
            className={cn(
              "rx-banner-slot",
              !bannerVisible && "rx-content-hidden",
            )}
          >
            {bannerImage ? (
              <div className="rx-custom-banner">
                <img src={bannerImage.src} alt="Custom prescription banner" />
              </div>
            ) : (
              <header className="rx-header">
                <div className="rx-clinic">
                  <span
                    className={cn(
                      "rx-logo",
                      !showClinicLogo && "rx-content-hidden",
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
                          className={cn(!showClinicEmail && "rx-content-hidden")}
                        >
                          {clinicProfile?.email || desktopSession?.doctor_email}
                        </span>
                      </p>
                    )}
                  </div>
                </div>
                <div className="rx-doctor">
                  <strong>{desktopSession?.doctor_name || doctorProfile?.full_name || "Doctor"}</strong>
                  <span>{doctorProfile?.qualification || "Registered Medical Practitioner"}</span>
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

          <section className="rx-patient">
            <div>
              <span>Patient</span>
              <strong>{patient.name}</strong>
              <small>
                {patient.age} years · {patient.gender}
              </small>
            </div>
            <div>
              <span>Patient ID</span>
              <strong>{getPublicPatientId(patient)}</strong>
            </div>
            <div>
              <span>Date</span>
              <strong>{data.date || "—"}</strong>
            </div>
          </section>

          <section className="rx-vitals">
            <span className="rx-section-label">Vitals</span>
            <div>
              <span>Blood pressure</span>
              <strong>
                {vitals.systolic && vitals.diastolic
                  ? `${vitals.systolic}/${vitals.diastolic} mmHg`
                  : "—"}
              </strong>
            </div>
            <div>
              <span>Heart rate</span>
              <strong>
                {vitals.heartRate ? `${vitals.heartRate} bpm` : "—"}
              </strong>
            </div>
            <div>
              <span>SpO₂</span>
              <strong>{vitals.spo2 ? `${vitals.spo2}%` : "—"}</strong>
            </div>
            <div>
              <span>Temperature</span>
              <strong>
                {vitals.temperature ? `${vitals.temperature} °F` : "—"}
              </strong>
            </div>
            <div>
              <span>Height</span>
              <strong>{vitals.height ? `${vitals.height} cm` : "—"}</strong>
            </div>
            <div>
              <span>Weight</span>
              <strong>{vitals.weight ? `${vitals.weight} kg` : "—"}</strong>
            </div>
          </section>

          <section className="rx-diagnosis">
            <span>Diagnosis</span>
            <p>{data.diagnosis || "No diagnosis entered."}</p>
          </section>

          <section
            className={cn(
              "rx-medicines",
              data.medicines.length > 0 && "has-data",
            )}
          >
            <div className="rx-symbol">℞</div>
            <table>
              <thead>
                <tr>
                  <th>Medicine</th>
                  <th>Dose & frequency</th>
                  <th>Duration</th>
                  <th>Instructions</th>
                </tr>
              </thead>
              <tbody>
                {data.medicines.length > 0 ? (
                  data.medicines.map((medicine) => (
                    <tr key={medicine.id}>
                      <td>
                        <strong>{medicine.name || "Unnamed medicine"}</strong>
                        <br />
                        <span>
                          {[
                            medicine.formulation,
                            medicine.strength,
                            medicine.releaseType &&
                            medicine.releaseType !== "IMMEDIATE_RELEASE"
                              ? medicine.releaseType
                                  .replace("_RELEASE", "")
                                  .replace("GASTRO_RESISTANT", "EC")
                                  .replace("_", " ")
                              : null,
                            medicine.activeIngredient &&
                            medicine.activeIngredient !== medicine.name
                              ? `(${medicine.activeIngredient})`
                              : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </td>
                      <td>
                        {[
                          formatMedicineDose(
                            medicine.dose,
                            medicine.formulation,
                          ),
                          medicine.frequency,
                        ]
                          .filter(Boolean)
                          .join(" · ") || "—"}
                      </td>
                      <td>{medicine.duration || "—"}</td>
                      <td>
                        {[medicine.route, medicine.food, medicine.directions]
                          .filter(Boolean)
                          .join(" · ") || "—"}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={4}>
                      <div className="rx-empty">
                        <strong>No medicines added.</strong>
                        <span>
                          Medicine fields remain blank until entered by the
                          doctor.
                        </span>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>

          <section className="rx-instructions">
            <h3>Clinical summary</h3>
            <p>
              {data.chiefComplaint || "No chief complaint entered."}
              {data.symptomDuration
                ? ` · Duration: ${data.symptomDuration}`
                : ""}
            </p>
            <div>
              <strong>Follow-up</strong>
              <span>
                {[data.followUpDate, data.followUpInstructions]
                  .filter(Boolean)
                  .join(" · ") || "No follow-up entered."}
              </span>
            </div>
          </section>

          <footer className="rx-footer">
            <div className={cn(!showAllergyWarning && "rx-content-hidden")}>
              {patient.allergies.length > 0 ? (
                <>
                  <span>Allergy alert</span>
                  <strong>{patient.allergies.join(", ")}</strong>
                </>
              ) : (
                <>
                  <span>Allergies</span>
                  <strong>None recorded</strong>
                </>
              )}
            </div>
            <div className="signature">
              {signatureImage && (
                <img
                  src={signatureImage.src}
                  alt={`${desktopSession?.doctor_name || "Doctor"}’s signature`}
                />
              )}
              <span>Doctor’s signature</span>
              <strong>{desktopSession?.doctor_name || "Doctor"}</strong>
            </div>
          </footer>
        </article>
      </div>

      {whatsapp && (
        <Modal
          title="Send prescription on WhatsApp"
          description="Review the destination and delivery details before sending."
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
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => go("patient-form")}
                >
                  Edit number
                </Button>
              </div>
              <div className="document-row">
                <span>
                  <FileText size={20} />
                </span>
                <div>
                  <strong>
                    Prescription preview · {data.date || "No date"}
                  </strong>
                  <small>
                    No PDF or message will be generated in this frontend demo
                  </small>
                </div>
                <Paperclip size={16} />
              </div>
              <div className="delivery-disclaimer">
                <AlertCircle size={17} />
                <p>
                  <strong>Demo state only.</strong> No WhatsApp API request is
                  sent. Real queued, sent, delivered, and failure states require
                  provider responses.
                </p>
              </div>
              <div className="modal-actions">
                <Button variant="ghost" onClick={() => setWhatsapp(false)}>
                  Cancel
                </Button>
                <Button icon={MessageCircle} onClick={send}>
                  Preview delivery state
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
              <h3>Demo: queued</h3>
              <p>
                This illustrates a queued provider response; no message was
                sent.
              </p>
              <div className="status-track">
                <span className="done">Queued</span>
                <i />
                <span>Sent</span>
                <i />
                <span>Delivered</span>
              </div>
              <div className="modal-actions">
                <Button
                  variant="secondary"
                  onClick={() => setDelivery("failed")}
                >
                  Preview failure
                </Button>
                <Button onClick={() => setWhatsapp(false)}>Done</Button>
              </div>
            </div>
          )}
          {delivery === "failed" && (
            <div className="delivery-state">
              <span className="state-icon danger">
                <X size={25} />
              </span>
              <h3>Demo: delivery failure</h3>
              <p>
                This illustrates a provider error. No real delivery attempt
                occurred.
              </p>
              <div className="error-box">
                Example provider response: Destination temporarily unavailable.
              </div>
              <div className="modal-actions">
                <Button variant="ghost" onClick={() => setWhatsapp(false)}>
                  Close
                </Button>
                <Button icon={RefreshCw} onClick={send}>
                  Preview retry
                </Button>
              </div>
            </div>
          )}
        </Modal>
      )}
    </>
  )
}

export default PrescriptionPreview
