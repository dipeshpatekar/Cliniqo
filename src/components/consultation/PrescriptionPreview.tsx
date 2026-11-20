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
  UserRoundPlus,
} from "lucide-react"
import {
  formatDateDDMMYYYY,
  formatMedicineDose,
  formatPatientAgeGender,
  formatPrescriptionDateWithTime,
  getPublicPatientId,
  type Page,
  type Patient,
  type Vitals,
  type ConsultationData,
  type Medicine,
  type ClinicalLibrary,
} from "../../types"
import { cn } from "../../utils/cn"
import { getGenuineAllergies } from "../../utils/allergy"
import { Button, IconButton, Modal } from "../common"
import { AppHeader } from "../layout"
import {
  getClinicProfile,
  getDoctorProfile,
  type ClinicProfile,
  type DoctorProfile,
  type DesktopSessionContext,
  type LocalPrescriptionRecord,
} from "../../desktop/desktop-bridge"
import { PrescriptionEditModal } from "./PrescriptionEditModal"

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
  returnPage: "consultation" | "settings" | "patient-profile"
  desktopSession?: DesktopSessionContext | null
  prescriptionRecord?: LocalPrescriptionRecord | null
  isHistorical?: boolean
  onRevisePrescription?: (
    medicinesOrData: any,
    reasonForRevision?: string,
  ) => Promise<void>
  itemsError?: string | null
  topSpacingMm?: number
  onAddPatient?: () => void
  clinicalLibrary?: ClinicalLibrary
  customChiefComplaints?: string[]
  customDiagnoses?: string[]
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
  prescriptionRecord,
  isHistorical,
  onRevisePrescription,
  itemsError,
  topSpacingMm = 0,
  onAddPatient,
  clinicalLibrary,
  customChiefComplaints,
  customDiagnoses,
}: PrescriptionPreviewProps) {
  const [whatsapp, setWhatsapp] = useState(false)
  const [delivery, setDelivery] =
    useState<"confirm" | "sending" | "queued" | "failed">("confirm")
  const [showEditModal, setShowEditModal] = useState(false)

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
          window.localStorage.getItem(
            `cliniqo_clinic_logo_${desktopSession.clinic_id}`,
          ) || window.localStorage.getItem("cliniqo_clinic_logo")
        if (storedLogo) setClinicLogo(storedLogo)
      }
    }
    if (desktopSession?.doctor_id) {
      getDoctorProfile(desktopSession.doctor_id).then((doc) => {
        if (doc) setDoctorProfile(doc)
      })
    }
  }, [desktopSession?.clinic_id, desktopSession?.doctor_id])

  useEffect(() => {
    if (typeof window === "undefined") return
    const handleProfileUpdate = (e: Event) => {
      const customEvent = e as CustomEvent
      const detail = customEvent.detail
      if (!detail) return
      if (detail.type === "doctor") {
        setDoctorProfile(detail.profile)
      } else if (detail.type === "clinic") {
        setClinicProfile(detail.profile)
      } else if (detail.type === "clinic-logo") {
        setClinicLogo(detail.logo ?? null)
      }
    }

    window.addEventListener("cliniqo:profile-updated", handleProfileUpdate)
    return () => {
      window.removeEventListener("cliniqo:profile-updated", handleProfileUpdate)
    }
  }, [])

  const handlePrint = (e?: React.MouseEvent) => {
    e?.preventDefault()
    if (typeof window !== "undefined") {
      window.print()
    }
  }

  useEffect(() => {
    const handleShortcut = (e: Event) => {
      const customEvent = e as CustomEvent<{ action?: string }>
      const { action } = customEvent.detail || {}
      if (action === "print" || action === "print-prescription") {
        handlePrint()
      }
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        e.key.toLowerCase() === "p" &&
        !e.shiftKey
      ) {
        if (!e.defaultPrevented) {
          e.preventDefault()
          handlePrint()
        }
      }
    }

    window.addEventListener("cliniqo-shortcut", handleShortcut)
    window.addEventListener("keydown", handleKeyDown)
    return () => {
      window.removeEventListener("cliniqo-shortcut", handleShortcut)
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [])

  const send = () => {
    setDelivery("sending")
    window.setTimeout(() => setDelivery("queued"), 1000)
  }

  return (
    <>
      <AppHeader
        title={
          returnPage === "settings"
            ? "Prescription layout preview"
            : prescriptionRecord
              ? `Prescription ${prescriptionRecord.prescription_number}`
              : "Prescription preview"
        }
        subtitle={
          returnPage === "settings"
            ? "Sample preview · Layout changes apply to all future prescriptions"
            : prescriptionRecord
              ? returnPage === "patient-profile"
                ? `${
                    prescriptionRecord.revision_number > 1
                      ? `Revision ${prescriptionRecord.revision_number}`
                      : "Original"
                  } · Finalized ${formatDateDDMMYYYY(prescriptionRecord.created_at)} · Read-only historical record`
                : `${prescriptionRecord.prescription_number} · Finalized ${formatDateDDMMYYYY(prescriptionRecord.created_at || new Date().toISOString())}`
              : "Local session preview · Not persisted"
        }
      >
        <IconButton
          className="topbar-back"
          label={
            returnPage === "settings"
              ? "Back to prescription settings"
              : returnPage === "patient-profile"
                ? "Back to patient profile"
                : "Back to consultation"
          }
          onClick={() => go(returnPage)}
        >
          <ArrowLeft size={18} />
        </IconButton>
        {prescriptionRecord &&
          prescriptionRecord.status === "ACTIVE" &&
          onRevisePrescription && (
            <Button
              type="button"
              variant="primary"
              icon={Edit3}
              onClick={() => setShowEditModal(true)}
            >
              Edit prescription
            </Button>
          )}
        <Button
          type="button"
          variant="secondary"
          icon={Printer}
          title="Print prescription (Ctrl+P)"
          onClick={handlePrint}
        >
          Print prescription
        </Button>
        <Button
          type="button"
          variant="secondary"
          icon={UserRoundPlus}
          title="Add patient (Ctrl+N)"
          onClick={() => {
            if (onAddPatient) {
              onAddPatient()
            } else {
              go("patient-form")
            }
          }}
        >
          Add Patient
        </Button>
        <Button
          icon={MessageCircle}
          disabled
          className="opacity-50 cursor-not-allowed"
        >
          Send on WhatsApp
        </Button>
      </AppHeader>

      <div className="preview-page">
        {itemsError && (
          <div
            className="no-print"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "10px",
              padding: "12px 16px",
              marginBottom: "16px",
              backgroundColor: "#fef2f2",
              border: "1px solid #f87171",
              borderRadius: "8px",
              color: "#991b1b",
              fontSize: "0.875rem",
            }}
          >
            <AlertCircle
              size={18}
              style={{ flexShrink: 0, color: "#dc2626" }}
            />
            <div>
              <strong>Prescription Data Warning:</strong> {itemsError}
            </div>
          </div>
        )}
        {prescriptionRecord ? (
          <div className="preview-note">
            <AlertCircle size={17} />
            <span>
              {returnPage === "patient-profile" ? (
                <>
                  Viewing finalized historical prescription{" "}
                  <strong>{prescriptionRecord.prescription_number}</strong> (
                  {prescriptionRecord.revision_number > 1
                    ? `Revision ${prescriptionRecord.revision_number}`
                    : "Original"}
                  , {prescriptionRecord.status}).
                  {prescriptionRecord.status === "ACTIVE"
                    ? " Click 'Edit prescription' to append an immutable revision."
                    : " Historical revisions are read-only."}
                </>
              ) : (
                <>
                  Finalized prescription{" "}
                  <strong>{prescriptionRecord.prescription_number}</strong>.
                  Persisted to local encrypted storage.
                </>
              )}
            </span>
            {returnPage === "patient-profile" &&
              prescriptionRecord.status === "ACTIVE" &&
              onRevisePrescription && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowEditModal(true)}
                  icon={Edit3}
                >
                  Edit prescription
                </Button>
              )}
          </div>
        ) : (
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
        )}

        <article
          className="prescription-paper"
          id="printable-prescription"
          style={{
            paddingTop: topSpacingMm
              ? `calc(44px + ${topSpacingMm}mm)`
              : undefined,
            ["--rx-top-spacing" as any]: `${topSpacingMm || 0}mm`,
          }}
        >
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
                        style={{
                          width: "100%",
                          height: "100%",
                          objectFit: "contain",
                          borderRadius: "4px",
                        }}
                      />
                    ) : (
                      <HeartPulse size={24} />
                    )}
                  </span>
                  <div>
                    <h2>
                      {clinicProfile?.name ||
                        (desktopSession?.clinic_id
                          ? `Clinic ${desktopSession.clinic_id}`
                          : "Medical Clinic")}
                    </h2>
                    <p>
                      {[
                        clinicProfile?.street,
                        clinicProfile?.city,
                        clinicProfile?.state,
                        clinicProfile?.postal_code,
                      ]
                        .filter(Boolean)
                        .join(", ") ||
                        (desktopSession?.clinic_id
                          ? "Registered Healthcare Facility"
                          : "Local Clinic Workspace")}
                    </p>
                    {clinicProfile?.phone && (
                      <p
                        style={{
                          fontSize: "12px",
                          color: "#1e293b",
                        }}
                      >
                        Ph: {clinicProfile.phone}
                      </p>
                    )}
                    {(clinicProfile?.email || desktopSession?.doctor_email) && (
                      <p>
                        <span
                          className={cn(
                            !showClinicEmail && "rx-content-hidden",
                          )}
                        >
                          {clinicProfile?.email || desktopSession?.doctor_email}
                        </span>
                      </p>
                    )}
                  </div>
                </div>
                <div className="rx-doctor">
                  <strong>
                    {doctorProfile?.full_name ||
                      desktopSession?.doctor_name ||
                      "Doctor"}
                  </strong>
                  <span>
                    {doctorProfile?.qualification ||
                      "Registered Medical Practitioner"}
                  </span>
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

          {/* Patient Info Row: PATIENT NAME · AGE · GENDER | PATIENT ID | RX NO. | DATE */}
          <section className="rx-patient">
            <div>
              <span>PATIENT NAME · AGE · GENDER</span>
              <strong className="rx-patient-info-val">
                <span className="rx-patient-name rx-patient-name-val">
                  {patient.name ? patient.name.toUpperCase() : ""}
                </span>
                {formatPatientAgeGender(
                  patient.age,
                  patient.gender,
                  "yrs",
                  patient.ageMonths,
                ) &&
                  formatPatientAgeGender(
                    patient.age,
                    patient.gender,
                    "yrs",
                    patient.ageMonths,
                  ) !== "— · —" && (
                    <span className="rx-patient-demographics rx-patient-age-gender">
                      {" "}
                      (
                      {formatPatientAgeGender(
                        patient.age,
                        patient.gender,
                        "yrs",
                        patient.ageMonths,
                      )}
                      )
                    </span>
                  )}
              </strong>
            </div>
            <div>
              <span>PATIENT ID</span>
              <strong>{getPublicPatientId(patient)}</strong>
            </div>
            <div>
              <span>RX NO.</span>
              <strong>
                {prescriptionRecord
                  ? prescriptionRecord.revision_number > 1
                    ? `${prescriptionRecord.prescription_number} (Rev ${prescriptionRecord.revision_number})`
                    : prescriptionRecord.prescription_number
                  : data.prescriptionNumber || "RX-PREVIEW"}
              </strong>
            </div>
            <div>
              <span>DATE</span>
              <strong>
                {formatPrescriptionDateWithTime(data.date, data.time)}
              </strong>
            </div>
          </section>

          {/* Vitals Row (no section heading; hidden completely if all empty) */}
          {Boolean(
            (vitals.systolic && vitals.diastolic) ||
              vitals.heartRate ||
              vitals.spo2 ||
              vitals.temperature ||
              vitals.height ||
              vitals.weight,
          ) && (
            <section className="rx-vitals">
              <div>
                <span>BLOOD PRESSURE</span>
                <strong>
                  {vitals.systolic && vitals.diastolic
                    ? `${vitals.systolic}/${vitals.diastolic} mmHg`
                    : "—"}
                </strong>
              </div>
              <div>
                <span>HEART RATE</span>
                <strong>
                  {vitals.heartRate ? `${vitals.heartRate} bpm` : "—"}
                </strong>
              </div>
              <div>
                <span>SPO₂</span>
                <strong>{vitals.spo2 ? `${vitals.spo2}%` : "—"}</strong>
              </div>
              <div>
                <span>TEMPERATURE</span>
                <strong>
                  {vitals.temperature ? `${vitals.temperature} °F` : "—"}
                </strong>
              </div>
              <div>
                <span>HEIGHT</span>
                <strong>{vitals.height ? `${vitals.height} cm` : "—"}</strong>
              </div>
              <div>
                <span>WEIGHT</span>
                <strong>{vitals.weight ? `${vitals.weight} kg` : "—"}</strong>
              </div>
            </section>
          )}

          {/* Clinical Information Row (Chief Complaints, Medical History, Diagnosis; dynamic visibility) */}
          {(() => {
            const chiefComplaintText = data.chiefComplaint?.trim()
              ? `${data.chiefComplaint.trim()}${
                  data.symptomDuration?.trim()
                    ? ` · Duration: ${data.symptomDuration.trim()}`
                    : ""
                }`
              : null
            const medicalHistoryList = (data.conditions || []).filter(
              (c) => c && c.trim(),
            )
            const medicalHistoryText =
              medicalHistoryList.length > 0
                ? medicalHistoryList.join(", ")
                : (patient as any).medical_conditions?.trim() || null
            const diagnosisText = data.diagnosis?.trim() || null

            if (!chiefComplaintText && !medicalHistoryText && !diagnosisText) {
              return null
            }

            return (
              <section className="rx-clinical-info">
                {chiefComplaintText && (
                  <div className="rx-clinical-item">
                    <span>CHIEF COMPLAINTS</span>
                    <p>{chiefComplaintText}</p>
                  </div>
                )}
                {medicalHistoryText && (
                  <div className="rx-clinical-item">
                    <span>MEDICAL HISTORY</span>
                    <p>{medicalHistoryText}</p>
                  </div>
                )}
                {diagnosisText && (
                  <div className="rx-clinical-item">
                    <span>DIAGNOSIS</span>
                    <p>{diagnosisText}</p>
                  </div>
                )}
              </section>
            )
          })()}

          {/* Medicines Table (℞ symbol, columns: MEDICINE | DOSE & FREQUENCY | INSTRUCTIONS | DURATION) */}
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
                  <th>MEDICINE</th>
                  <th>DOSE & FREQUENCY</th>
                  <th>INSTRUCTIONS</th>
                  <th>DURATION</th>
                </tr>
              </thead>
              <tbody>
                {itemsError ? (
                  <tr>
                    <td colSpan={4}>
                      <div
                        className="rx-empty"
                        style={{
                          border: "1px dashed var(--danger, #ef4444)",
                          backgroundColor: "#fef2f2",
                          color: "#991b1b",
                          padding: "16px",
                          borderRadius: "8px",
                        }}
                      >
                        <strong
                          style={{
                            display: "block",
                            color: "#b91c1c",
                            marginBottom: "4px",
                          }}
                        >
                          Unable to load medicines
                        </strong>
                        <span style={{ color: "#7f1d1d" }}>{itemsError}</span>
                      </div>
                    </td>
                  </tr>
                ) : data.medicines.length > 0 ? (
                  data.medicines.map((medicine) => (
                    <tr key={medicine.id}>
                      <td>
                        <strong className="rx-med-name">
                          {medicine.formulation
                            ? `${medicine.formulation} · `
                            : ""}
                          {medicine.name || "Unnamed medicine"}
                        </strong>
                        {medicine.strength && (
                          <span className="rx-med-strength">
                            {medicine.strength}
                          </span>
                        )}
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
                      <td>
                        {[medicine.food, medicine.directions]
                          .filter(Boolean)
                          .join(" · ") || "—"}
                      </td>
                      <td>{medicine.duration || "—"}</td>
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

          {/* Footer: Allergy & Follow-up (left) | Doctor's signature & Page (right) */}
          <footer className="rx-footer">
            <div className="rx-footer-left">
              {showAllergyWarning &&
                (() => {
                  const genuine = getGenuineAllergies(patient.allergies)
                  if (genuine.length === 0) return null
                  return (
                    <div className="rx-allergy">
                      <span
                        className="rx-allergy-label"
                        aria-label="Allergy alert"
                      >
                        ALLERGY
                      </span>
                      <strong className="rx-allergy-val">
                        {genuine.join(", ")}
                      </strong>
                    </div>
                  )
                })()}
              {(data.followUpDate || data.followUpInstructions) && (
                <div className="rx-follow-up">
                  <strong className="rx-follow-up-label">follow up : </strong>
                  <span className="rx-follow-up-val">
                    {formatDateDDMMYYYY(data.followUpDate) || "N/A"}
                  </span>
                  <span className="rx-follow-up-sep"> · </span>
                  <strong className="rx-adv-label">adv : </strong>
                  <span className="rx-adv-val">
                    {data.followUpInstructions || "N/A"}
                  </span>
                </div>
              )}
            </div>
            <div className="rx-footer-right">
              <div className="signature">
                {signatureImage && (
                  <img
                    src={signatureImage.src}
                    alt={`${doctorProfile?.full_name || desktopSession?.doctor_name || "Doctor"}’s signature`}
                  />
                )}
                <span>Doctor’s signature</span>
                <strong>
                  {doctorProfile?.full_name ||
                    desktopSession?.doctor_name ||
                    "Doctor"}
                </strong>
              </div>
              <div className="rx-page-number">1/1</div>
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
                    Prescription preview ·{" "}
                    {formatDateDDMMYYYY(data.date) || "No date"}
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

      {prescriptionRecord && showEditModal && onRevisePrescription && (
        <PrescriptionEditModal
          isOpen={showEditModal}
          onClose={() => setShowEditModal(false)}
          prescriptionNumber={prescriptionRecord.prescription_number}
          currentRevisionNumber={prescriptionRecord.revision_number}
          isRevision={Boolean(isHistorical ?? (returnPage === "patient-profile"))}
          initialMedicines={data.medicines}
          initialVitals={vitals}
          initialConsultationData={data}
          patient={patient}
          clinicalLibrary={clinicalLibrary}
          customChiefComplaints={customChiefComplaints}
          customDiagnoses={customDiagnoses}
          clinicId={desktopSession?.clinic_id}
          desktopSession={desktopSession}
          onSaveRevision={onRevisePrescription as any}
        />
      )}
    </>
  )
}

export default PrescriptionPreview
