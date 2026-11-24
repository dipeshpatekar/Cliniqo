import type { LocalPrescriptionRecord, LocalConsultationRecord } from "../desktop/desktop-bridge"
import { reviseLocalPrescription, getLocalPrescriptions } from "../desktop/desktop-bridge"
import type { Page, Patient, Vitals, ConsultationData, Medicine } from "../types"
import { normalizeMedicineList } from "../types"

export type PrescriptionPreviewReturnPage = "consultation" | "settings" | "patient-profile"
export type BillPreviewReturnPage = "bill-form" | "settings" | "patient-profile"

export interface ViewingHistoricalPrescriptionState {
  record: LocalPrescriptionRecord
  consultationData: ConsultationData
  vitals: Vitals
  itemsError?: string | null
}

/**
 * Resolves returnPage and navigation side-effects when navigating to "preview".
 * Ensures patient-profile returnPage is preserved when viewing historical prescriptions.
 */
export function resolvePrescriptionPreviewNavigation(
  currentPage: Page,
  previousReturnPage: PrescriptionPreviewReturnPage,
  isFinalized = false,
): {
  returnPage: PrescriptionPreviewReturnPage
  clearHistorical: boolean
  settingsTab?: string
} {
  if (currentPage === "settings") {
    return {
      returnPage: "settings",
      clearHistorical: true,
      settingsTab: "Prescription layout",
    }
  }

  if (currentPage === "patient-profile") {
    return {
      returnPage: "patient-profile",
      clearHistorical: false,
    }
  }

  if (currentPage === "consultation") {
    if (isFinalized) {
      return {
        returnPage: "patient-profile",
        clearHistorical: true,
      }
    }
    return {
      returnPage: "consultation",
      clearHistorical: true,
    }
  }

  // Fallback for transitions from other pages
  const preservedReturn =
    previousReturnPage === "patient-profile" || previousReturnPage === "settings"
      ? previousReturnPage
      : "consultation"

  return {
    returnPage: preservedReturn,
    clearHistorical: preservedReturn !== "patient-profile",
  }
}

/**
 * Resolves returnPage when navigating to "bill-preview".
 */
export function resolveBillPreviewNavigation(
  currentPage: Page,
  previousReturnPage: BillPreviewReturnPage,
  isFinalized = false,
): {
  returnPage: BillPreviewReturnPage
  settingsTab?: string
} {
  if (currentPage === "settings") {
    return {
      returnPage: "settings",
      settingsTab: "Bill layout",
    }
  }

  if (currentPage === "patient-profile" || isFinalized) {
    return {
      returnPage: "patient-profile",
    }
  }

  return {
    returnPage: previousReturnPage === "patient-profile" ? "patient-profile" : "bill-form",
  }
}

/**
 * Determines whether viewingHistoricalPrescription state should be cleared on page transition.
 * State must be retained when switching between "preview" and "patient-profile".
 */
export function shouldClearHistoricalPrescriptionOnNavigation(nextPage: Page): boolean {
  return nextPage !== "preview" && nextPage !== "patient-profile"
}

/**
 * Reconstructs ConsultationData and Vitals from a saved LocalPrescriptionRecord and its
 * associated consultation snapshot.
 */
export function reconstructHistoricalPrescription(
  rx: LocalPrescriptionRecord,
  matchedConsultation?: LocalConsultationRecord | null,
): {
  consultationData: ConsultationData
  vitals: Vitals
  itemsError: string | null
} {
  let parsedMedicines: Medicine[] = []
  let itemsError: string | null = null

  try {
    if (rx.items_json && rx.items_json.trim().length > 0) {
      const parsed = JSON.parse(rx.items_json)
      const list = normalizeMedicineList(parsed)
      if (list.length > 0) {
        parsedMedicines = list
      } else if (Array.isArray(parsed) && parsed.length === 0) {
        parsedMedicines = []
      } else if (Array.isArray(parsed)) {
        parsedMedicines = parsed
      } else {
        itemsError = `Prescription record ${rx.prescription_number || rx.id} contains invalid medicine structure (expected a list).`
      }
    } else {
      itemsError = `Prescription record ${rx.prescription_number || rx.id} has no medicine data recorded.`
    }
  } catch (e) {
    itemsError = `Failed to parse medicines for prescription ${rx.prescription_number || rx.id}: invalid JSON.`
  }

  let parsedVitals: Vitals = {
    systolic: "",
    diastolic: "",
    heartRate: "",
    spo2: "",
    temperature: "",
    height: "",
    weight: "",
  }
  let followUpDate = ""
  let followUpInstructions = ""
  let symptomDuration = ""
  let allergies: string[] = []
  let conditions: string[] = []
  let consultationDate = ""
  let consultationTime = ""

  if (matchedConsultation?.clinical_snapshot_json) {
    try {
      const snapshot = JSON.parse(matchedConsultation.clinical_snapshot_json)
      if (snapshot.vitals) {
        parsedVitals = { ...parsedVitals, ...snapshot.vitals }
      }
      if (snapshot.followUpDate) followUpDate = snapshot.followUpDate
      if (snapshot.followUpInstructions) followUpInstructions = snapshot.followUpInstructions
      if (snapshot.symptomDuration) symptomDuration = snapshot.symptomDuration
      if (Array.isArray(snapshot.allergies)) allergies = snapshot.allergies
      if (Array.isArray(snapshot.conditions)) conditions = snapshot.conditions
      if (snapshot.consultationDate) consultationDate = snapshot.consultationDate
      if (snapshot.consultationTime || snapshot.time) {
        consultationTime = snapshot.consultationTime || snapshot.time
      }
    } catch {}
  }

  const effectiveDate =
    consultationDate ||
    (matchedConsultation?.consultation_date
      ? matchedConsultation.consultation_date.split("T")[0]
      : rx.created_at
        ? rx.created_at.slice(0, 10)
        : new Date().toISOString().slice(0, 10))

  const effectiveTime =
    consultationTime ||
    (matchedConsultation?.consultation_date && matchedConsultation.consultation_date.includes("T")
      ? matchedConsultation.consultation_date.split("T")[1].slice(0, 5)
      : rx.created_at
        ? new Date(rx.created_at).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            hour12: true,
          })
        : "")

  const reconstructedConsultation: ConsultationData = {
    date: effectiveDate,
    time: effectiveTime,
    chiefComplaint: matchedConsultation?.chief_complaint || "",
    symptomDuration,
    diagnosis: matchedConsultation?.diagnosis || "",
    medicines: parsedMedicines,
    followUpDate,
    followUpInstructions,
    allergies,
    conditions,
  }

  return {
    consultationData: reconstructedConsultation,
    vitals: parsedVitals,
    itemsError,
  }
}

/**
 * Computes preview mode flags (sample vs historical vs live consultation).
 */
export function computePrescriptionPreviewState(
  returnPage: PrescriptionPreviewReturnPage,
  viewingHistorical: ViewingHistoricalPrescriptionState | null,
): {
  isSamplePreview: boolean
  isHistorical: boolean
} {
  const isSamplePreview = returnPage === "settings"
  const isHistorical = Boolean(viewingHistorical)
  return { isSamplePreview, isHistorical }
}

/**
 * Executes a prescription revision via the Tauri desktop bridge.
 * Validates active record status, performs SQLite mutation, and retrieves the new revision.
 */
export async function executePrescriptionRevision({
  currentRecord,
  clinicId,
  patientId,
  medicines,
  reasonForRevision,
  newConsultationId,
  reviseBridge = reviseLocalPrescription,
  fetchPrescriptionsBridge = getLocalPrescriptions,
}: {
  currentRecord: LocalPrescriptionRecord
  clinicId: string
  patientId: string
  medicines: Medicine[]
  reasonForRevision?: string
  newConsultationId?: string | null
  reviseBridge?: typeof reviseLocalPrescription
  fetchPrescriptionsBridge?: typeof getLocalPrescriptions
}): Promise<LocalPrescriptionRecord> {
  if (!currentRecord) {
    throw new Error("No active historical prescription selected.")
  }
  if (!clinicId) {
    throw new Error("Active clinic session is required to revise prescriptions.")
  }
  if (currentRecord.status !== "ACTIVE") {
    throw new Error(
      `Cannot revise prescription with status ${currentRecord.status}. Only ACTIVE prescriptions can be revised.`,
    )
  }

  const newPrescriptionId = await reviseBridge({
    clinic_id: clinicId,
    prescription_id: currentRecord.id,
    expected_revision_number: currentRecord.revision_number,
    items_json: JSON.stringify(medicines),
    reason_for_revision: reasonForRevision?.trim() || "Prescription revision",
    ...(newConsultationId ? { new_consultation_id: newConsultationId } : {}),
  })

  if (!newPrescriptionId) {
    throw new Error("Failed to revise prescription: no revision ID returned.")
  }

  const updatedList = await fetchPrescriptionsBridge(clinicId, patientId)
  const newRecord =
    updatedList.find((r) => r.id === newPrescriptionId) ||
    ({
      ...currentRecord,
      id: newPrescriptionId,
      revision_number: currentRecord.revision_number + 1,
      status: "ACTIVE" as const,
      consultation_id: newConsultationId || currentRecord.consultation_id,
      items_json: JSON.stringify(medicines),
    } as LocalPrescriptionRecord)

  return newRecord
}
