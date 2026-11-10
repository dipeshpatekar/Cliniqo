import { useState, useEffect, useMemo, useRef } from "react"
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  ExternalLink,
  CalendarDays,
  Activity,
  Stethoscope,
  Pill,
  Plus,
  Trash2,
  AlertCircle,
  HelpCircle,
  RefreshCw,
} from "lucide-react"
import type {
  Page,
  Patient,
  ClinicalLibrary,
  Vitals,
  ConsultationData,
  Medicine,
  ClinicalMedicineDefinition,
  CatalogueItem,
} from "../../types"
import {
  emptyMedicine,
  getDoseConfig,
  oralFormulations,
  topicalFormulations,
  medicineOptions,
  complaintOptions,
  symptomDurationOptions,
  diagnosisOptions,
  formatPatientAgeGender,
  getPublicPatientId,
  FORMULATION_SHORTCUTS,
  FORMULATION_LETTER_MAP,
} from "../../types"
import { validateMedicineFormulation } from "../../utils/billing"
import { analyzeAllergies } from "../../utils/allergy"
import { FREQUENCY_NUMERIC_MAP } from "../../utils/keyboardShortcuts"
import {
  Button,
  IconButton,
  Field,
  TextInput,
  SelectInput,
  SearchableOptionSelect,
  type SearchOptionItem,
  FormSection,
  TextArea,
} from "../common"
import { AppHeader } from "../layout"
import { CompactField } from "./CompactField"
import {
  isTauriDesktop,
  getLocalFormulary,
  saveLocalFormularyItem,
  saveLocalConsultation,
  saveLocalPrescription,
  searchCatalogue,
  getCatalogueStrengths,
  getCatalogueSyncStatus,
  mapStockUnitToFormulation,
  type CatalogueSyncStatus,
  type LocalFormularyItemRecord,
  type DesktopSessionContext,
} from "../../desktop/desktop-bridge"

export interface ConsultationProps {
  go: (page: Page) => void
  patient: Patient
  clinicalLibrary: ClinicalLibrary
  vitals: Vitals
  onVitalsChange: (key: keyof Vitals, value: string) => void
  data: ConsultationData
  onDataChange: (data: ConsultationData) => void
  onAddMedicine?: (medicine: ClinicalMedicineDefinition) => void
  desktopSession?: DesktopSessionContext | null
  onFinalized?: (
    consultationId?: string | null,
    finalizedTimestamp?: string,
  ) => void
  onUpdatePatientMedicalInfo?: (
    allergies: string[],
    conditions: string[],
  ) => void
}

export function Consultation({
  go,
  patient,
  clinicalLibrary,
  vitals,
  onVitalsChange,
  data,
  onDataChange,
  onAddMedicine,
  desktopSession,
  onFinalized,
  onUpdatePatientMedicalInfo,
}: ConsultationProps) {
  const [saved, setSaved] = useState(false)
  const [hasAttemptedSubmit, setHasAttemptedSubmit] = useState(false)
  const [isFinalizing, setIsFinalizing] = useState(false)
  const [finalizeError, setFinalizeError] = useState<string | null>(null)
  const [localFormulary, setLocalFormulary] =
    useState<LocalFormularyItemRecord[]>([])
  const [catalogueSuggestions, setCatalogueSuggestions] =
    useState<Record<number, CatalogueItem[]>>({})
  const [catalogueStrengthsMap, setCatalogueStrengthsMap] =
    useState<Record<number, string[]>>({})
  const [isOfflineSearchActive, setIsOfflineSearchActive] = useState(false)
  const [catalogueSyncStatus, setCatalogueSyncStatus] =
    useState<CatalogueSyncStatus | null>(null)

  const currentAllergies = useMemo(
    () =>
      data.allergies !== undefined ? data.allergies : patient.allergies || [],
    [data.allergies, patient.allergies],
  )
  const currentConditions = useMemo(
    () =>
      data.conditions !== undefined
        ? data.conditions
        : patient.conditions || [],
    [data.conditions, patient.conditions],
  )
  const [allergiesInput, setAllergiesInput] = useState(
    currentAllergies.join(", "),
  )
  const [conditionsInput, setConditionsInput] = useState(
    currentConditions.join(", "),
  )

  const allergyAnalysis = useMemo(
    () => analyzeAllergies(allergiesInput),
    [allergiesInput],
  )

  useEffect(() => {
    setAllergiesInput(currentAllergies.join(", "))
  }, [currentAllergies])

  useEffect(() => {
    setConditionsInput(currentConditions.join(", "))
  }, [currentConditions])

  const handleAllergiesChange = (val: string) => {
    setAllergiesInput(val)
    const list = val
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    updateData({ allergies: list })
    onUpdatePatientMedicalInfo?.(list, currentConditions)
  }

  const handleConditionsChange = (val: string) => {
    setConditionsInput(val)
    const list = val
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    updateData({ conditions: list })
    onUpdatePatientMedicalInfo?.(currentAllergies, list)
  }

  useEffect(() => {
    let mounted = true
    if (isTauriDesktop()) {
      getCatalogueSyncStatus()
        .then((status) => {
          if (mounted && status) setCatalogueSyncStatus(status)
        })
        .catch(() => {})
    }
    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    if (!isTauriDesktop()) return
    if (catalogueSyncStatus?.status !== "SYNCING") return

    const interval = setInterval(() => {
      getCatalogueSyncStatus()
        .then((status) => {
          if (status) setCatalogueSyncStatus(status)
        })
        .catch(() => {})
    }, 2000)

    return () => clearInterval(interval)
  }, [catalogueSyncStatus?.status])

  useEffect(() => {
    let mounted = true
    if (isTauriDesktop() && desktopSession?.clinic_id) {
      getLocalFormulary(desktopSession.clinic_id)
        .then((items) => {
          if (mounted) setLocalFormulary(items)
        })
        .catch((err) => {
          console.error("Failed to load local formulary in consultation:", err)
        })
    }
    return () => {
      mounted = false
    }
  }, [desktopSession?.clinic_id])

  const searchDebounceTimers =
    useRef<Record<number, ReturnType<typeof setTimeout>>>({})

  useEffect(() => {
    return () => {
      Object.values(searchDebounceTimers.current).forEach((t) =>
        clearTimeout(t),
      )
    }
  }, [])

  const handleMedicineSearch = (
    medicineId: number,
    query: string,
    formulation?: string,
  ) => {
    // 1. Immediately update medicine name in state for instant typing responsiveness
    updateData({
      medicines: data.medicines.map((row) =>
        row.id === medicineId
          ? {
              ...row,
              name: query,
              sourceIdentifier: undefined,
              sourceProvenance: undefined,
              isCombination: undefined,
              isStrengthVerified: undefined,
              isCustom: true,
            }
          : row,
      ),
    })

    const trimmed = query.trim()
    if (!trimmed) {
      setCatalogueSuggestions((prev) => ({ ...prev, [medicineId]: [] }))
      setCatalogueStrengthsMap((prev) => ({ ...prev, [medicineId]: [] }))
      return
    }

    if (searchDebounceTimers.current[medicineId]) {
      clearTimeout(searchDebounceTimers.current[medicineId])
    }

    searchDebounceTimers.current[medicineId] = setTimeout(() => {
      // 2. Fetch catalogue suggestions (SQLite offline cache or bundled pharmacy stock report)
      searchCatalogue(trimmed, undefined, 20, formulation)
        .then((res) => {
          setCatalogueSuggestions((prev) => ({
            ...prev,
            [medicineId]: res.items || [],
          }))
          if (res.isOfflineCache && res.items && res.items.length > 0) {
            setIsOfflineSearchActive(true)
          }
        })
        .catch(() => {})

      // 3. Automatic strength lookup
      getCatalogueStrengths(trimmed, undefined, formulation)
        .then((res) => {
          setCatalogueStrengthsMap((prev) => ({
            ...prev,
            [medicineId]: res.strengths || [],
          }))
          if (res.isOfflineCache && res.strengths && res.strengths.length > 0) {
            setIsOfflineSearchActive(true)
          }
          if (res.strengths && res.strengths.length === 1) {
            updateMedicine(medicineId, "strength", res.strengths[0])
          }
        })
        .catch(() => {})
    }, 100)
  }

  const handleSelectMedicineOption = (
    medicineId: number,
    option: SearchOptionItem,
    formulation?: string,
  ) => {
    const catItem = option.meta as CatalogueItem | undefined

    if (catItem) {
      const isStock = catItem.sourceProvenance === "LOCAL_INVENTORY"
      const cleanName = catItem.productName || catItem.brandName || option.value
      const resolvedFormulation =
        formulation ||
        (catItem.dosageForm
          ? mapStockUnitToFormulation(catItem.dosageForm)
          : "") ||
        ""

      const singleStrength = isStock
        ? "" // Do not treat packaging unit (e.g. TAB) as chemical strength
        : catItem.strengths && catItem.strengths.length === 1
          ? catItem.rawStrengthSummary
          : catItem.rawStrengthSummary || ""

      const defaultDose =
        resolvedFormulation === "Tablet"
          ? "1 tablet"
          : resolvedFormulation === "Capsule"
            ? "1 capsule"
            : resolvedFormulation === "Syrup"
              ? "5 mL"
              : ""

      updateData({
        medicines: data.medicines.map((row) => {
          if (row.id !== medicineId) return row
          return {
            ...row,
            name: cleanName,
            formulation: resolvedFormulation || row.formulation,
            strength: singleStrength || row.strength,
            dose: row.dose || defaultDose,
            activeIngredient: catItem.genericName || row.activeIngredient,
            route:
              catItem.route ||
              row.route ||
              (resolvedFormulation === "Injection" ? "" : "Oral"),
            sourceIdentifier: catItem.sourceIdentifier,
            sourceProvenance: catItem.sourceProvenance,
            isCombination: catItem.isCombination,
            isStrengthVerified: catItem.isStrengthVerified ?? true,
            brandName: catItem.brandName || cleanName,
            genericName: catItem.genericName,
            productName: cleanName,
            releaseType: catItem.releaseType,
            manufacturer: catItem.manufacturer,
            isCustom: false,
          }
        }),
      })

      if (!isStock) {
        getCatalogueStrengths(
          cleanName,
          desktopSession?.doctor_id,
          resolvedFormulation || formulation,
        )
          .then((res) => {
            setCatalogueStrengthsMap((prev) => ({
              ...prev,
              [medicineId]: res.strengths || [],
            }))
            if (
              res.isOfflineCache &&
              res.strengths &&
              res.strengths.length > 0
            ) {
              setIsOfflineSearchActive(true)
            }
            if (res.strengths && res.strengths.length === 1) {
              updateMedicine(medicineId, "strength", res.strengths[0])
            }
          })
          .catch(() => {})
      }
    } else {
      const def =
        mergedDefinitions.find(
          (item) =>
            item.name.toLowerCase() === option.value.toLowerCase() &&
            (!formulation || item.formulation === formulation),
        ) ||
        mergedDefinitions.find(
          (item) => item.name.toLowerCase() === option.value.toLowerCase(),
        )
      if (def) {
        updateData({
          medicines: data.medicines.map((row) => {
            if (row.id !== medicineId) return row
            return {
              ...row,
              name: def.name,
              formulation: row.formulation || def.formulation,
              strength: row.strength || def.strength || "",
              activeIngredient: row.activeIngredient || def.activeIngredient,
              dose: row.dose || def.defaultDosage || "",
              route: row.route || def.defaultRoute || "",
              frequency: row.frequency || def.defaultFrequency || "",
              duration: row.duration || def.defaultDuration || "",
              directions: row.directions || def.defaultInstructions || "",
              isCustom: false,
            }
          }),
        })
      } else {
        updateData({
          medicines: data.medicines.map((row) =>
            row.id === medicineId
              ? {
                  ...row,
                  name: option.value,
                  isCustom: true,
                  isStrengthVerified: false,
                }
              : row,
          ),
        })
      }
    }
  }

  const mergedDefinitions: ClinicalMedicineDefinition[] = useMemo(() => {
    const list = [...clinicalLibrary.MedicineDefinitions]
    for (const item of localFormulary) {
      if (
        !list.some(
          (existing) =>
            existing.name.toLowerCase() === item.name.toLowerCase() &&
            existing.formulation === item.formulation,
        )
      ) {
        list.push({
          id: item.id,
          name: item.name,
          formulation: item.formulation,
          strength: item.strength || "",
          activeIngredient: item.active_ingredient || undefined,
          defaultDosage: item.default_dosage || undefined,
          defaultRoute: item.default_route || undefined,
          defaultFrequency: item.default_frequency || undefined,
          defaultDuration: item.default_duration || undefined,
          defaultInstructions: item.default_instructions || undefined,
        })
      }
    }
    return list
  }, [clinicalLibrary.MedicineDefinitions, localFormulary])

  const updateData = (updates: Partial<ConsultationData>) =>
    onDataChange({ ...data, ...updates })

  const medicinesValid = data.medicines.every(
    (m) => validateMedicineFormulation(m).valid,
  )
  const consultationComplete = Boolean(
    data.medicines.length === 0 || medicinesValid,
  )

  const updateMedicine = (id: number, key: keyof Medicine, value: string) =>
    updateData({
      medicines: data.medicines.map((row) =>
        row.id === id ? { ...row, [key]: value } : row,
      ),
    })

  const handleFormulationChange = (
    medicineId: number,
    newFormulation: string,
  ) => {
    setCatalogueSuggestions((prev) => ({ ...prev, [medicineId]: [] }))
    setCatalogueStrengthsMap((prev) => ({ ...prev, [medicineId]: [] }))

    const isNewOral = oralFormulations.has(newFormulation)
    const isNewInjection = newFormulation === "Injection"
    const isNewTopical = topicalFormulations.has(newFormulation)

    updateData({
      medicines: data.medicines.map((row) => {
        if (row.id !== medicineId) return row

        return {
          id: row.id,
          formulation: newFormulation,
          name: "",
          strength: "",
          dose: "",
          frequency: row.frequency,
          duration: row.duration,
          food: isNewOral ? row.food : "",
          route: isNewInjection ? row.route : "",
          directions: isNewTopical ? row.directions : "",
          activeIngredient: "",
          sourceIdentifier: undefined,
          sourceProvenance: undefined,
          isCombination: undefined,
          isStrengthVerified: undefined,
          isCustom: undefined,
          brandName: undefined,
          genericName: undefined,
          productName: undefined,
          releaseType: undefined,
          manufacturer: undefined,
        }
      }),
    })

    if (newFormulation) {
      window.setTimeout(() => {
        const medInput = document.getElementById(`medicine-${medicineId}`)
        medInput?.focus()
      }, 50)
    }
  }

  const addMedicine = () => {
    const nextId = Math.max(...data.medicines.map((row) => row.id), 0) + 1
    updateData({
      medicines: [
        ...data.medicines,
        emptyMedicine(nextId),
      ],
    })
    window.setTimeout(() => {
      const el = document.getElementById(`formulation-${nextId}`)
      el?.focus()
    }, 60)
  }

  const removeMedicine = (id: number) =>
    updateData({
      medicines: data.medicines.filter((row) => row.id !== id),
    })

  const handleFinalize = async () => {
    setFinalizeError(null)
    const finalizedDate = new Date()
    const finalizedDateStr = finalizedDate.toISOString().slice(0, 10)
    const finalizedTimeStr = finalizedDate.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    })
    const finalizedTimestamp = finalizedDate.toISOString()

    const updatedData: ConsultationData = {
      ...data,
      date: data.date || finalizedDateStr,
      time: data.time || finalizedTimeStr,
    }
    onDataChange(updatedData)

    if (isTauriDesktop() && desktopSession?.clinic_id) {
      setIsFinalizing(true)
      try {
        const consultationId = await saveLocalConsultation({
          clinic_id: desktopSession.clinic_id,
          patient_id: patient.id,
          consultation_date: updatedData.date,
          chief_complaint: data.chiefComplaint,
          diagnosis: data.diagnosis,
          clinical_snapshot_json: JSON.stringify({
            vitals,
            symptomDuration: data.symptomDuration,
            followUpDate: data.followUpDate,
            followUpInstructions: data.followUpInstructions,
            allergies: data.allergies ?? patient.allergies,
            conditions: data.conditions ?? patient.conditions,
          }),
        })

        if (consultationId) {
          const rxNumber = `RX-${Date.now().toString().slice(-6)}`
          await saveLocalPrescription({
            clinic_id: desktopSession.clinic_id,
            consultation_id: consultationId,
            patient_id: patient.id,
            prescription_number: rxNumber,
            items_json: JSON.stringify(data.medicines),
          })

          // Auto-add valid custom medicines to Clinical Medicine Library (local_formulary_v2)
          let addedCustom = false
          for (const m of data.medicines) {
            const isCustomMed = m.isCustom || !m.sourceIdentifier
            if (
              isCustomMed &&
              m.name.trim() &&
              m.formulation.trim() &&
              validateMedicineFormulation(m).valid
            ) {
              const medDef: ClinicalMedicineDefinition = {
                name: m.name.trim(),
                formulation: m.formulation.trim(),
                strength: m.strength?.trim() || "",
                activeIngredient: m.activeIngredient?.trim() || undefined,
                defaultDosage: m.dose?.trim() || undefined,
                defaultRoute: m.route?.trim() || undefined,
                defaultFrequency: m.frequency?.trim() || undefined,
                defaultDuration: m.duration?.trim() || undefined,
                defaultInstructions: m.directions?.trim() || undefined,
              }
              onAddMedicine?.(medDef)

              if (desktopSession?.clinic_id) {
                try {
                  await saveLocalFormularyItem({
                    clinic_id: desktopSession.clinic_id,
                    name: medDef.name,
                    formulation: medDef.formulation,
                    strength: medDef.strength,
                    active_ingredient: medDef.activeIngredient || null,
                    default_dosage: medDef.defaultDosage || null,
                    default_route: medDef.defaultRoute || null,
                    default_frequency: medDef.defaultFrequency || null,
                    default_duration: medDef.defaultDuration || null,
                    default_instructions: medDef.defaultInstructions || null,
                  })
                  addedCustom = true
                } catch (formularyErr) {
                  console.warn(
                    "[Cliniqo Desktop] Failed to auto-save custom medicine to formulary:",
                    formularyErr,
                  )
                }
              }
            }
          }

          if (addedCustom) {
            getLocalFormulary(desktopSession.clinic_id)
              .then((items) => setLocalFormulary(items))
              .catch(() => {})
          }
        }
        onFinalized?.(consultationId, finalizedTimestamp)
        go("preview")
      } catch (err: unknown) {
        console.error(
          "[Cliniqo Desktop] Failed to save consultation/prescription to SQLite:",
          err,
        )
        setFinalizeError(
          err instanceof Error
            ? err.message
            : "Failed to persist consultation to local encrypted storage. Your inputs are preserved.",
        )
      } finally {
        setIsFinalizing(false)
      }
    } else {
      onFinalized?.(null, finalizedTimestamp)
      go("preview")
    }
  }

  const handleSaveDraft = () => {
    setHasAttemptedSubmit(true)
    setSaved(true)
    window.setTimeout(() => setSaved(false), 1800)
  }

  const handleTriggerFinalize = async () => {
    setHasAttemptedSubmit(true)
    if (!consultationComplete) return
    await handleFinalize()
  }

  useEffect(() => {
    const handleShortcut = (event: Event) => {
      const customEvent = event as CustomEvent<{
        action: string
        direction?: "up" | "down"
      }>
      const { action, direction } = customEvent.detail || {}
      if (action === "save-draft") {
        handleSaveDraft()
      } else if (action === "finalize-prescription") {
        handleTriggerFinalize()
      } else if (action === "add-medicine") {
        addMedicine()
      } else if (action === "focus-vitals") {
        const systolicInput = document.getElementById("vital-systolic")
        systolicInput?.focus()
      } else if (action === "focus-diagnosis") {
        const diagInput = document.getElementById("diagnosis")
        diagInput?.focus()
      } else if (action === "focus-advice") {
        const adviceInput = document.getElementById("advice-instructions")
        adviceInput?.focus()
      } else if (action === "navigate-medicine-rows") {
        const meds = data.medicines
        if (meds.length === 0) return
        const activeEl = document.activeElement
        let currentIdx = -1
        let isOnFormulation = false
        for (let i = 0; i < meds.length; i++) {
          const medInput = document.getElementById(`medicine-${meds[i].id}`)
          const formInput = document.getElementById(`formulation-${meds[i].id}`)
          if (
            medInput &&
            (medInput === activeEl || medInput.contains(activeEl))
          ) {
            currentIdx = i
            isOnFormulation = false
            break
          }
          if (
            formInput &&
            (formInput === activeEl || formInput.contains(activeEl))
          ) {
            currentIdx = i
            isOnFormulation = true
            break
          }
        }
        let targetIdx = 0
        if (direction === "up") {
          targetIdx = currentIdx > 0 ? currentIdx - 1 : meds.length - 1
        } else {
          targetIdx =
            currentIdx >= 0 && currentIdx < meds.length - 1
              ? currentIdx + 1
              : 0
        }
        const targetInput = document.getElementById(
          isOnFormulation
            ? `formulation-${meds[targetIdx].id}`
            : `medicine-${meds[targetIdx].id}`,
        )
        targetInput?.focus()
      }
    }

    window.addEventListener("cliniqo-shortcut", handleShortcut)
    return () => {
      window.removeEventListener("cliniqo-shortcut", handleShortcut)
    }
  }, [consultationComplete, data.medicines])

  return (
    <>
      <AppHeader
        title="New consultation"
        subtitle={`${patient.name} · ${getPublicPatientId(patient)}`}
      >
        <IconButton
          className="topbar-back"
          label="Back to patient profile"
          onClick={() => go("patient-profile")}
        >
          <ArrowLeft size={18} />
        </IconButton>
        <Button
          variant="secondary"
          aria-live="polite"
          title="Save draft (Ctrl+S)"
          onClick={handleSaveDraft}
        >
          {saved ? (
            <>
              <Check size={16} /> Session draft updated
            </>
          ) : (
            "Update local draft"
          )}
        </Button>
        <Button
          className="consultation-finalize-action"
          aria-label="Finalize prescription"
          title="Finalize prescription (Ctrl+F)"
          onClick={handleTriggerFinalize}
          disabled={isFinalizing}
          loading={isFinalizing}
        >
          {isFinalizing ? "Finalizing..." : "Finalize prescription"}
        </Button>
      </AppHeader>

      <div className="consultation-shell">
        {finalizeError && (
          <div
            role="alert"
            className="consultation-error-banner"
            style={{
              margin: "16px 24px 0",
              padding: "12px 16px",
              backgroundColor: "var(--danger-soft, #fee2e2)",
              color: "var(--danger, #b91c1c)",
              border: "1px solid var(--danger-line, #fca5a5)",
              borderRadius: "8px",
              fontSize: "13px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "12px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <AlertCircle size={16} />
              <span>{finalizeError}</span>
            </div>
            <button
              type="button"
              onClick={() => setFinalizeError(null)}
              style={{
                background: "transparent",
                border: "none",
                cursor: "pointer",
                color: "inherit",
                fontSize: "16px",
                lineHeight: 1,
                padding: "2px 4px",
              }}
              aria-label="Dismiss error"
            >
              ×
            </button>
          </div>
        )}
        <main className="consultation-main">
          <div className="patient-strip">
            <span className="avatar">{patient.initials}</span>
            <div className="patient-strip-identity">
              <strong className="patient-strip-name">{patient.name}</strong>
              <span className="patient-strip-details">
                · {[
                  formatPatientAgeGender(patient.age, patient.gender, "years"),
                  getPublicPatientId(patient),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </div>
            {allergyAnalysis.hasGenuineAllergies && (
              <span className="patient-allergy danger">
                <AlertCircle size={15} /> Allergy: {allergyAnalysis.displayLabel}
              </span>
            )}
            {allergyAnalysis.isNoKnownAllergies && (
              <span className="patient-allergy safe">
                <Check size={14} /> No Known Allergies
              </span>
            )}
            {allergyAnalysis.isUnknown && (
              <span className="patient-allergy warning">
                <AlertCircle size={14} /> Allergies: Unknown
              </span>
            )}
            <button onClick={() => go("patient-profile")}>
              View profile <ExternalLink size={14} />
            </button>
          </div>

          <FormSection icon={CalendarDays} title="Consultation date and time">
            <div className="form-grid two">
              <Field label="Consultation date" required>
                <TextInput
                  type="date"
                  required
                  value={data.date}
                  onChange={(event) => updateData({ date: event.target.value })}
                />
              </Field>
              <Field label="Consultation time" required>
                <TextInput
                  type="time"
                  required
                  value={data.time}
                  onChange={(event) => updateData({ time: event.target.value })}
                />
              </Field>
            </div>
          </FormSection>

          <FormSection icon={Activity} title="Vitals">
            <div className="vitals-grid">
              <CompactField
                id="vital-systolic"
                label="Blood pressure"
                suffix="mmHg"
                placeholder="120"
                secondaryPlaceholder="80"
                value={vitals.systolic}
                secondaryValue={vitals.diastolic}
                onChange={(value) => onVitalsChange("systolic", value)}
                onSecondaryChange={(value) =>
                  onVitalsChange("diastolic", value)
                }
                wide
              />
              <CompactField
                label="Heart rate"
                suffix="bpm"
                placeholder="72"
                value={vitals.heartRate}
                onChange={(value) => onVitalsChange("heartRate", value)}
              />
              <CompactField
                label="SpO₂"
                suffix="%"
                placeholder="98"
                value={vitals.spo2}
                onChange={(value) => onVitalsChange("spo2", value)}
              />
              <CompactField
                label="Temperature"
                suffix="°F"
                placeholder="98.6"
                value={vitals.temperature}
                onChange={(value) => onVitalsChange("temperature", value)}
                step="0.1"
              />
              <CompactField
                label="Height"
                suffix="cm"
                placeholder="165"
                value={vitals.height}
                onChange={(value) => onVitalsChange("height", value)}
                step="0.1"
              />
              <CompactField
                label="Weight"
                suffix="kg"
                placeholder="60"
                value={vitals.weight}
                onChange={(value) => onVitalsChange("weight", value)}
                step="0.1"
              />
            </div>
          </FormSection>

          <FormSection icon={Stethoscope} title="Clinical notes">
            <div className="form-grid three">
              <Field label="Chief complaints">
                <SearchableOptionSelect
                  id="chief-complaint"
                  value={data.chiefComplaint}
                  options={complaintOptions}
                  onChange={(value) => updateData({ chiefComplaint: value })}
                  placeholder="Select or search a common complaint"
                  ariaLabel="Search and select chief complaint"
                  emptyMessage="No matching complaint. Continue typing to use a custom value."
                />
              </Field>
              <Field label="Symptom duration">
                <SearchableOptionSelect
                  id="symptom-duration"
                  value={data.symptomDuration}
                  options={symptomDurationOptions}
                  onChange={(value) => updateData({ symptomDuration: value })}
                  placeholder="Select or search symptom duration"
                  ariaLabel="Search and select symptom duration"
                  emptyMessage="No matching duration. Continue typing to use a custom value."
                />
              </Field>
              <Field label="Diagnosis">
                <SearchableOptionSelect
                  id="diagnosis"
                  value={data.diagnosis}
                  options={diagnosisOptions}
                  onChange={(value) => updateData({ diagnosis: value })}
                  placeholder="Select or search a diagnosis"
                  ariaLabel="Search and select diagnosis"
                  emptyMessage="No matching diagnosis. Continue typing to use a custom value."
                />
              </Field>
            </div>
          </FormSection>

          <FormSection icon={Activity} title="Medical background">
            <div className="form-grid two">
              <Field
                label="Known allergies"
                hint="Optional, comma-separated (e.g. Penicillin, or 'None' / 'NKDA')"
              >
                <TextArea
                  value={allergiesInput}
                  onChange={(e) => handleAllergiesChange(e.target.value)}
                  rows={2}
                  placeholder="e.g. Drug, food, or environmental allergies (or 'NKDA' / 'None')"
                />
                {allergiesInput.trim() && (
                  <div
                    style={{
                      fontSize: "12px",
                      marginTop: "5px",
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                      fontWeight: 500,
                      color: allergyAnalysis.hasGenuineAllergies
                        ? "var(--danger, #ba3d3d)"
                        : allergyAnalysis.isNoKnownAllergies
                          ? "var(--success, #237653)"
                          : allergyAnalysis.isUnknown
                            ? "var(--warning, #97691c)"
                            : "var(--muted)",
                    }}
                  >
                    {allergyAnalysis.hasGenuineAllergies && (
                      <>
                        <AlertCircle size={13} />
                        <span>Recorded allergy: {allergyAnalysis.displayLabel}</span>
                      </>
                    )}
                    {allergyAnalysis.isNoKnownAllergies && (
                      <>
                        <Check size={13} />
                        <span>No Known Allergies (non-allergy entry recognized)</span>
                      </>
                    )}
                    {allergyAnalysis.isUnknown && (
                      <>
                        <AlertCircle size={13} />
                        <span>Unknown (status unconfirmed, not allergy-free)</span>
                      </>
                    )}
                  </div>
                )}
              </Field>
              <Field
                label="Medical conditions"
                hint="Optional, comma-separated"
              >
                <TextArea
                  value={conditionsInput}
                  onChange={(e) => handleConditionsChange(e.target.value)}
                  rows={2}
                  placeholder="Existing or chronic conditions"
                />
              </Field>
            </div>
          </FormSection>

          <section className="form-section medicines-section">
            <div className="form-section-head medicines-head">
              <span>
                <Pill size={18} />
              </span>
              <div>
                <h2>Medicines</h2>
              </div>
              <Button
                size="sm"
                variant="secondary"
                icon={Plus}
                title="Add medicine (Ctrl+Shift+M)"
                onClick={addMedicine}
              >
                Add medicine
              </Button>
            </div>

            {data.medicines.length === 0 ? (
              <div className="medicine-empty">
                <Pill size={22} />
                <p>No medicines added</p>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={Plus}
                  title="Add medicine (Ctrl+Shift+M)"
                  onClick={addMedicine}
                >
                  Add medicine
                </Button>
              </div>
            ) : (
              <div className="medicines-container">
                {data.medicines.map((medicine, index) => {
                  const doseConfig = getDoseConfig(medicine.formulation)
                  const availableStrengths =
                    catalogueStrengthsMap[medicine.id] || []
                  const strengthOptions = [
                    ...new Set([
                      ...availableStrengths,
                      ...clinicalLibrary.Strengths,
                      ...(["Syrup", "Suspension"].includes(medicine.formulation)
                        ? ["125 mg/5 mL", "250 mg/5 mL"]
                        : []),
                    ]),
                  ]
                  const doseOptions = [
                    ...new Set([
                      ...clinicalLibrary.Doses,
                      ...(doseConfig.unit === "mL"
                        ? ["2.5", "5", "10", "15"]
                        : doseConfig.step === "0.5"
                          ? ["0.5", "1", "1.5", "2"]
                          : ["1", "2", "3", "4"]),
                    ]),
                  ]
                  const frequencyOptions: SearchOptionItem[] = [
                    { value: "Once daily", label: "Once daily", badge: "1" },
                    { value: "Twice daily", label: "Twice daily", badge: "2" },
                    {
                      value: "Three times daily",
                      label: "Three times daily",
                      badge: "3",
                    },
                    {
                      value: "Four times daily",
                      label: "Four times daily",
                      badge: "4",
                    },
                    { value: "As needed", label: "As needed", badge: "5" },
                  ]
                  const validation = validateMedicineFormulation(medicine)

                  const rowSuggestions: SearchOptionItem[] = [
                    ...mergedDefinitions
                      .filter(
                        (item) =>
                          !medicine.formulation ||
                          item.formulation.trim().toLowerCase() ===
                            medicine.formulation.trim().toLowerCase(),
                      )
                      .map((item) => ({
                        value: item.name,
                        label: item.name,
                        badge: "Formulary",
                        subtitle: item.activeIngredient,
                      })),
                    ...(catalogueSuggestions[medicine.id] || [])
                      .filter((cat) => {
                        if (!medicine.formulation) return true
                        const mapped = cat.dosageForm
                          ? mapStockUnitToFormulation(cat.dosageForm) ||
                            cat.dosageForm
                          : ""
                        if (!mapped) return true
                        return (
                          mapped.trim().toLowerCase() ===
                          medicine.formulation.trim().toLowerCase()
                        )
                      })
                      .map((cat) => {
                      const isStock = cat.sourceProvenance === "LOCAL_INVENTORY"
                      const cleanName =
                        cat.productName || cat.brandName || cat.name
                      const releaseBadge =
                        cat.releaseType &&
                        cat.releaseType !== "IMMEDIATE_RELEASE"
                          ? cat.releaseType
                              .replace("_RELEASE", "")
                              .replace("GASTRO_RESISTANT", "EC")
                              .replace("_", " ")
                          : null
                      const badgeText =
                        cat.sourceProvenance === "CLINICAL_LIBRARY"
                          ? "Clinic Library"
                          : isStock
                            ? "Pharmacy Stock"
                            : releaseBadge ||
                              (cat.isCombination ? "Combo" : cat.type)
                      const subtitleParts = [
                        cat.sourceProvenance === "CLINICAL_LIBRARY"
                          ? "Custom Clinic Import"
                          : null,
                        isStock
                          ? `Manufacturer: ${cat.manufacturer || "Unknown"}`
                          : cat.manufacturer,
                        isStock
                          ? `In Stock: ${cat.rawStrengthSummary || ""}`
                          : cat.productName || cat.genericName,
                      ].filter(Boolean)

                      return {
                        value: cleanName,
                        label: isStock ? cat.name : cleanName,
                        badge: badgeText || undefined,
                        subtitle: subtitleParts.join(" • ") || undefined,
                        meta: cat,
                      }
                    }),
                  ]

                  return (
                    <div
                      className="medicine-card medicine-row"
                      key={medicine.id}
                    >
                      <div className="medicine-card-body">
                        <div className="medicine-badge medicine-number">
                          {index + 1}
                        </div>
                        <div className="medicine-card-content">
                          {/* Row 1: Formulation, Medicine name, Strength, Dose */}
                          <div className="medicine-row-primary">
                            <Field
                              label="Formulation"
                              hint={
                                !medicine.formulation
                                  ? "Select a formulation to continue"
                                  : undefined
                              }
                              className="med-col-formulation"
                            >
                              <SelectInput
                                id={`formulation-${medicine.id}`}
                                value={medicine.formulation}
                                style={{ width: "100%", height: "40px" }}
                                onChange={(event) => {
                                  handleFormulationChange(
                                    medicine.id,
                                    event.target.value,
                                  )
                                }}
                                onKeyDown={(e) => {
                                  if (!e.ctrlKey && !e.altKey && !e.metaKey) {
                                    const shortcutKey = e.key.toLowerCase()
                                    if (FORMULATION_SHORTCUTS[shortcutKey]) {
                                      e.preventDefault()
                                      handleFormulationChange(
                                        medicine.id,
                                        FORMULATION_SHORTCUTS[shortcutKey],
                                      )
                                    }
                                  }
                                }}
                              >
                                <option value="">Select formulation</option>
                                {clinicalLibrary.Formulations.map((option) => (
                                  <option key={option} value={option}>
                                    {FORMULATION_LETTER_MAP[option]
                                      ? `${option} (${FORMULATION_LETTER_MAP[option]})`
                                      : option}
                                  </option>
                                ))}
                              </SelectInput>
                            </Field>

                            <Field
                              label="Medicine name"
                              required
                              className="med-col-name"
                            >
                              <SearchableOptionSelect
                                id={`medicine-${medicine.id}`}
                                value={medicine.name}
                                options={rowSuggestions}
                                onChange={(value) =>
                                  handleMedicineSearch(
                                    medicine.id,
                                    value,
                                    medicine.formulation,
                                  )
                                }
                                onSelectOption={(option) =>
                                  handleSelectMedicineOption(
                                    medicine.id,
                                    option,
                                    medicine.formulation,
                                  )
                                }
                                placeholder="Search medicine"
                                ariaLabel="Search and select medicine"
                                emptyMessage={
                                  catalogueSyncStatus?.status === "SYNCING" &&
                                  (catalogueSyncStatus.downloadedCount ?? 0) ===
                                    0
                                    ? "Catalogue is syncing in background... Continue typing to use custom name."
                                    : "No matching medicine. Continue typing to use a custom name."
                                }
                              />
                              {medicine.sourceIdentifier && (
                                <div
                                  style={{
                                    display: "flex",
                                    gap: "6px",
                                    alignItems: "center",
                                    marginTop: "4px",
                                    fontSize: "11px",
                                    color: "#0284c7",
                                  }}
                                >
                                  <CheckCircle2 size={13} />
                                  <span>
                                    Verified Medicine (
                                    {medicine.sourceIdentifier})
                                  </span>
                                  {medicine.isCombination && (
                                    <span
                                      style={{
                                        backgroundColor: "#fef3c7",
                                        color: "#92400e",
                                        padding: "1px 5px",
                                        borderRadius: "3px",
                                        fontWeight: 600,
                                      }}
                                    >
                                      Combination
                                    </span>
                                  )}
                                </div>
                              )}
                              {medicine.isCustom &&
                                medicine.name.trim() &&
                                !medicine.sourceIdentifier && (
                                  <div
                                    style={{
                                      display: "flex",
                                      gap: "4px",
                                      alignItems: "center",
                                      marginTop: "4px",
                                      fontSize: "11px",
                                      color: "#64748b",
                                    }}
                                  >
                                    <span>Custom uncatalogued medicine</span>
                                  </div>
                                )}
                              {medicine.activeIngredient && (
                                <span className="med-active-ingredient">
                                  Active: {medicine.activeIngredient}
                                </span>
                              )}
                            </Field>

                            {medicine.formulation ? (
                              <>
                                <Field
                                  label="Strength"
                                  className="med-col-strength"
                                  hint={
                                    availableStrengths.length > 1
                                      ? `${availableStrengths.length} verified strengths available`
                                      : availableStrengths.length === 1
                                        ? "Auto-selected verified strength"
                                        : undefined
                                  }
                                >
                                  <SearchableOptionSelect
                                    id={`strength-${medicine.id}`}
                                    value={medicine.strength}
                                    options={strengthOptions}
                                    onChange={(value) =>
                                      updateMedicine(
                                        medicine.id,
                                        "strength",
                                        value,
                                      )
                                    }
                                    placeholder="Search strength"
                                    ariaLabel="Search and select strength"
                                    emptyMessage="No matching strength. Continue typing to use a custom value."
                                  />
                                </Field>

                                <Field
                                  label="Dose"
                                  className="med-col-dose"
                                  hint={
                                    doseConfig.unit
                                      ? `Unit: ${doseConfig.unit}`
                                      : undefined
                                  }
                                >
                                  <SearchableOptionSelect
                                    id={`dose-${medicine.id}`}
                                    value={medicine.dose}
                                    options={doseOptions}
                                    onChange={(value) =>
                                      updateMedicine(medicine.id, "dose", value)
                                    }
                                    placeholder="Search dose"
                                    ariaLabel="Search and select dose"
                                    emptyMessage="No matching dose. Continue typing to use a custom value."
                                  />
                                </Field>
                              </>
                            ) : null}
                          </div>

                          {/* Row 2: Frequency, Duration, Food instruction / Route / Directions */}
                          {medicine.formulation && (
                            <div className="medicine-row-secondary">
                              <Field label="Frequency">
                                <SearchableOptionSelect
                                  id={`frequency-${medicine.id}`}
                                  value={medicine.frequency}
                                  options={frequencyOptions}
                                  numericShortcuts={FREQUENCY_NUMERIC_MAP}
                                  onChange={(value) =>
                                    updateMedicine(
                                      medicine.id,
                                      "frequency",
                                      value,
                                    )
                                  }
                                  placeholder="Search frequency"
                                  ariaLabel="Search and select frequency"
                                  emptyMessage="No matching frequency. Continue typing to use a custom value."
                                />
                              </Field>

                              <Field label="Duration">
                                <SearchableOptionSelect
                                  id={`duration-${medicine.id}`}
                                  value={medicine.duration}
                                  options={clinicalLibrary.Durations}
                                  onChange={(value) =>
                                    updateMedicine(
                                      medicine.id,
                                      "duration",
                                      value,
                                    )
                                  }
                                  placeholder="Search duration"
                                  ariaLabel="Search and select duration"
                                  emptyMessage="No matching duration. Continue typing to use a custom value."
                                />
                              </Field>

                              {oralFormulations.has(medicine.formulation) && (
                                <Field label="Food instruction">
                                  <SelectInput
                                    value={medicine.food}
                                    style={{ height: "40px" }}
                                    onChange={(e) =>
                                      updateMedicine(
                                        medicine.id,
                                        "food",
                                        e.target.value,
                                      )
                                    }
                                  >
                                    <option value="">Select</option>
                                    <option>Before food</option>
                                    <option>After food</option>
                                    <option>With food</option>
                                    <option>Not applicable</option>
                                  </SelectInput>
                                </Field>
                              )}

                              {medicine.formulation === "Injection" && (
                                <Field label="Route (Required)">
                                  <SelectInput
                                    value={medicine.route}
                                    style={{ height: "40px" }}
                                    onChange={(e) =>
                                      updateMedicine(
                                        medicine.id,
                                        "route",
                                        e.target.value,
                                      )
                                    }
                                  >
                                    <option value="">Select route</option>
                                    <option>Intravenous (IV)</option>
                                    <option>Intramuscular (IM)</option>
                                    <option>Subcutaneous (SC)</option>
                                    <option>Intradermal (ID)</option>
                                  </SelectInput>
                                </Field>
                              )}

                              {topicalFormulations.has(
                                medicine.formulation,
                              ) && (
                                <Field
                                  label="Application instructions (Required)"
                                  className="med-directions"
                                >
                                  <TextInput
                                    value={medicine.directions}
                                    onChange={(e) =>
                                      updateMedicine(
                                        medicine.id,
                                        "directions",
                                        e.target.value,
                                      )
                                    }
                                    placeholder="Site, amount, and method of application"
                                  />
                                </Field>
                              )}
                            </div>
                          )}
                        </div>

                        <IconButton
                          label={`Remove medicine ${index + 1}`}
                          onClick={() => removeMedicine(medicine.id)}
                          className="medicine-remove-btn"
                        >
                          <Trash2 size={17} />
                        </IconButton>
                      </div>

                      {hasAttemptedSubmit &&
                        !validation.valid &&
                        medicine.formulation && (
                          <div className="med-validation-warning">
                            <AlertCircle size={13} />
                            <span>{validation.error}</span>
                          </div>
                        )}
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          <FormSection icon={CalendarDays} title="Adv.">
            <div className="form-grid two">
              <Field label="Adv. date">
                <TextInput
                  type="date"
                  value={data.followUpDate}
                  onChange={(event) =>
                    updateData({ followUpDate: event.target.value })
                  }
                />
              </Field>
              <Field label="Adv. instructions">
                <TextInput
                  id="advice-instructions"
                  value={data.followUpInstructions}
                  onChange={(event) =>
                    updateData({ followUpInstructions: event.target.value })
                  }
                  placeholder="Reason or tests to bring"
                />
              </Field>
            </div>
          </FormSection>
        </main>
      </div>
    </>
  )
}

export default Consultation
