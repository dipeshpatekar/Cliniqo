import { useState, useEffect, useMemo, useRef } from "react"
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  LockKeyhole,
  ExternalLink,
  CalendarDays,
  Activity,
  Stethoscope,
  Pill,
  Plus,
  Trash2,
  AlertCircle,
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
} from "../../types"
import { validateMedicineFormulation } from "../../utils/billing"
import {
  Button,
  IconButton,
  Field,
  TextInput,
  SelectInput,
  SearchableOptionSelect,
  type SearchOptionItem,
  Modal,
  FormSection,
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
}: ConsultationProps) {
  const [saved, setSaved] = useState(false)
  const [showFinalize, setShowFinalize] = useState(false)
  const [isFinalizing, setIsFinalizing] = useState(false)
  const [finalizeError, setFinalizeError] = useState<string | null>(null)
  const [localFormulary, setLocalFormulary] =
    useState<LocalFormularyItemRecord[]>([])
  const [catalogueSuggestions, setCatalogueSuggestions] = useState<
    Record<number, CatalogueItem[]>
  >({})
  const [catalogueStrengthsMap, setCatalogueStrengthsMap] = useState<
    Record<number, string[]>
  >({})
  const [isOfflineSearchActive, setIsOfflineSearchActive] = useState(false)
  const [catalogueSyncStatus, setCatalogueSyncStatus] =
    useState<CatalogueSyncStatus | null>(null)

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

  const searchDebounceTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({})

  useEffect(() => {
    return () => {
      Object.values(searchDebounceTimers.current).forEach((t) => clearTimeout(t))
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
              strength: "", // Stale strengths cleared immediately
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
        (catItem.dosageForm ? mapStockUnitToFormulation(catItem.dosageForm) : "") ||
        formulation ||
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
            route: catItem.route || row.route || (resolvedFormulation === "Injection" ? "" : "Oral"),
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
        getCatalogueStrengths(cleanName, desktopSession?.doctor_id, resolvedFormulation || formulation)
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
      }
    } else {
      const def = mergedDefinitions.find(
        (item) =>
          item.name.toLowerCase() === option.value.toLowerCase() &&
          (!formulation || item.formulation === formulation),
      ) || mergedDefinitions.find(
        (item) => item.name.toLowerCase() === option.value.toLowerCase(),
      )
      if (def) {
        updateData({
          medicines: data.medicines.map((row) => {
            if (row.id !== medicineId) return row
            return {
              ...row,
              name: def.name,
              formulation: def.formulation || row.formulation,
              strength: def.strength || row.strength || "",
              activeIngredient: def.activeIngredient || row.activeIngredient,
              dose: def.defaultDosage || row.dose,
              route: def.defaultRoute || row.route,
              frequency: def.defaultFrequency || row.frequency,
              duration: def.defaultDuration || row.duration,
              directions: def.defaultInstructions || row.directions,
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
    data.chiefComplaint.trim() &&
      data.diagnosis.trim() &&
      (data.medicines.length === 0 || medicinesValid),
  )

  const updateMedicine = (id: number, key: keyof Medicine, value: string) =>
    updateData({
      medicines: data.medicines.map((row) =>
        row.id === id ? { ...row, [key]: value } : row,
      ),
    })

  const addMedicine = () =>
    updateData({
      medicines: [
        ...data.medicines,
        emptyMedicine(Math.max(...data.medicines.map((row) => row.id), 0) + 1),
      ],
    })

  const removeMedicine = (id: number) =>
    updateData({
      medicines: data.medicines.filter((row) => row.id !== id),
    })

  const handleFinalize = async () => {
    setFinalizeError(null)
    if (isTauriDesktop() && desktopSession?.clinic_id) {
      setIsFinalizing(true)
      try {
        const consultationId = await saveLocalConsultation({
          clinic_id: desktopSession.clinic_id,
          patient_id: patient.id,
          consultation_date: data.date,
          chief_complaint: data.chiefComplaint,
          diagnosis: data.diagnosis,
          clinical_snapshot_json: JSON.stringify({
            vitals,
            symptomDuration: data.symptomDuration,
            followUpDate: data.followUpDate,
            followUpInstructions: data.followUpInstructions,
          }),
        })

        if (consultationId && data.medicines.length > 0) {
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
        setShowFinalize(false)
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
      setShowFinalize(false)
      go("preview")
    }
  }

  return (
    <>
      <AppHeader
        title="New consultation"
        subtitle={`${patient.name} · ${patient.displayId || patient.id}`}
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
          onClick={() => {
            setSaved(true)
            window.setTimeout(() => setSaved(false), 1800)
          }}
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
          disabled={!consultationComplete}
          onClick={() => setShowFinalize(true)}
        >
          Finalize prescription
        </Button>
      </AppHeader>

      <div className="consultation-shell">
        <main className="consultation-main">
          <div className="patient-strip">
            <span className="avatar">{patient.initials}</span>
            <div>
              <strong>{patient.name}</strong>
              <small>
                {patient.age} years · {patient.gender} · {patient.displayId || patient.id}
              </small>
            </div>
            {patient.allergies.length > 0 && (
              <span className="patient-allergy">
                <AlertCircle size={15} /> Allergy:{" "}
                {patient.allergies.join(", ")}
              </span>
            )}
            <button onClick={() => go("patient-profile")}>
              View profile <ExternalLink size={14} />
            </button>
          </div>

          <FormSection
            icon={CalendarDays}
            title="Consultation date and time"
            description="Recorded for this patient-linked visit"
          >
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

          <FormSection
            icon={Activity}
            title="Vitals"
            description="Record measurements for this visit"
          >
            <div className="vitals-grid">
              <CompactField
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

          <FormSection
            icon={Stethoscope}
            title="Clinical notes"
            description="Document findings for this consultation only"
          >
            <div className="form-grid two">
              <Field label="Chief complaints" required>
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
              <Field label="Diagnosis" required>
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

          <section className="form-section medicines-section">
            <div className="form-section-head medicines-head">
              <span>
                <Pill size={18} />
              </span>
              <div>
                <h2>Medicines</h2>
                <p>
                  Add only after clinical review. No medicine or dose is prefilled.
                </p>
              </div>
              <Button
                size="sm"
                variant="secondary"
                icon={Plus}
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
                  onClick={addMedicine}
                >
                  Add medicine
                </Button>
              </div>
            ) : (
              <div className="medicines-container">
                {data.medicines.map((medicine, index) => {
                  const doseConfig = getDoseConfig(medicine.formulation)
                  const availableStrengths = catalogueStrengthsMap[medicine.id] || []
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
                  const frequencyOptions = [
                    "Once daily",
                    "Twice daily",
                    "Three times daily",
                    "Four times daily",
                    "As needed",
                  ]
                  const validation = validateMedicineFormulation(medicine)

                  const rowSuggestions: SearchOptionItem[] = [
                    ...mergedDefinitions
                      .filter((item) => !medicine.formulation || item.formulation === medicine.formulation)
                      .map((item) => ({
                        value: item.name,
                        label: item.name,
                        badge: "Formulary",
                        subtitle: item.activeIngredient,
                      })),
                    ...(catalogueSuggestions[medicine.id] || []).map((cat) => {
                      const isStock = cat.sourceProvenance === "LOCAL_INVENTORY"
                      const cleanName = cat.productName || cat.brandName || cat.name
                      const releaseBadge =
                        cat.releaseType && cat.releaseType !== "IMMEDIATE_RELEASE"
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
                          : releaseBadge || (cat.isCombination ? "Combo" : cat.type)
                      const subtitleParts = [
                        cat.sourceProvenance === "CLINICAL_LIBRARY" ? "Custom Clinic Import" : null,
                        isStock ? `Manufacturer: ${cat.manufacturer || "Unknown"}` : cat.manufacturer,
                        isStock ? `In Stock: ${cat.rawStrengthSummary || ""}` : (cat.productName || cat.genericName),
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
                    <div className="medicine-card medicine-row" key={medicine.id}>
                      <div className="medicine-card-body">
                        <div className="medicine-badge medicine-number">{index + 1}</div>
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
                                value={medicine.formulation}
                                style={{ width: "100%", height: "40px" }}
                                onChange={(event) => {
                                  const formulation = event.target.value
                                  updateData({
                                    medicines: data.medicines.map((row) =>
                                      row.id === medicine.id
                                        ? {
                                            ...row,
                                            formulation,
                                            name: "",
                                            strength: "",
                                            dose: "",
                                            route: "",
                                            food: "",
                                            directions: "",
                                            activeIngredient: "",
                                            sourceIdentifier: undefined,
                                            sourceProvenance: undefined,
                                            isCombination: undefined,
                                            isStrengthVerified: undefined,
                                            isCustom: undefined,
                                          }
                                        : row,
                                    ),
                                  })
                                }}
                              >
                                <option value="">Select formulation</option>
                                {clinicalLibrary.Formulations.map((option) => (
                                  <option key={option}>{option}</option>
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
                                  (catalogueSyncStatus.downloadedCount ?? 0) === 0
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
                                    Verified Medicine ({medicine.sourceIdentifier})
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
                              {medicine.isCustom && medicine.name.trim() && !medicine.sourceIdentifier && (
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
                                      updateMedicine(medicine.id, "strength", value)
                                    }
                                    placeholder="Search strength"
                                    ariaLabel="Search and select strength"
                                    emptyMessage="No matching strength. Continue typing to use a custom value."
                                  />
                                </Field>

                                <Field
                                  label="Dose"
                                  className="med-col-dose"
                                  hint={doseConfig.unit ? `Unit: ${doseConfig.unit}` : undefined}
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
                                  onChange={(value) =>
                                    updateMedicine(medicine.id, "frequency", value)
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
                                    updateMedicine(medicine.id, "duration", value)
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

                              {topicalFormulations.has(medicine.formulation) && (
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

                      {!validation.valid && medicine.formulation && (
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

            {data.medicines.length > 0 && (
              <div className="medicine-add-footer">
                <Button
                  size="sm"
                  variant="secondary"
                  icon={Plus}
                  onClick={addMedicine}
                >
                  Add another medicine
                </Button>
              </div>
            )}
          </section>

          <FormSection
            icon={CalendarDays}
            title="Follow-up"
            description="Plan the next step in care"
          >
            <div className="form-grid two">
              <Field label="Follow-up date">
                <TextInput
                  type="date"
                  value={data.followUpDate}
                  onChange={(event) =>
                    updateData({ followUpDate: event.target.value })
                  }
                />
              </Field>
              <Field label="Follow-up instructions">
                <TextInput
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

      {showFinalize && (
        <Modal
          title="Finalize prescription?"
          description="Confirm that you have reviewed the diagnosis, medicines, doses, and instructions."
          onClose={() => {
            if (!isFinalizing) setShowFinalize(false)
          }}
        >
          <div className="review-checklist">
            <p>
              <CheckCircle2 size={18} /> Patient and allergy details reviewed
            </p>
            <p>
              <CheckCircle2 size={18} /> Clinical notes and diagnosis reviewed
            </p>
            <p>
              <CheckCircle2 size={18} /> Medicines and directions reviewed
            </p>
          </div>
          <div className="modal-warning">
            <LockKeyhole size={17} />
            <p>
              {isTauriDesktop() && desktopSession
                ? "Encrypted local SQLite storage and durable sync outbox are active for this clinic."
                : "This frontend can preview the finalized layout, but durable finalization and revision history require a backend."}
            </p>
          </div>
          {finalizeError && (
            <div
              className="error-box"
              style={{
                marginTop: "12px",
                padding: "10px",
                backgroundColor: "#fee2e2",
                color: "#b91c1c",
                borderRadius: "6px",
                fontSize: "13px",
              }}
            >
              <AlertCircle
                size={16}
                style={{ display: "inline", marginRight: "6px" }}
              />
              {finalizeError}
            </div>
          )}
          <div className="modal-actions">
            <Button
              variant="ghost"
              onClick={() => setShowFinalize(false)}
              disabled={isFinalizing}
            >
              Continue editing
            </Button>
            <Button
              onClick={handleFinalize}
              disabled={isFinalizing}
              loading={isFinalizing}
            >
              {isFinalizing
                ? "Saving to encrypted storage..."
                : "Finalize & view prescription"}
            </Button>
          </div>
        </Modal>
      )}
    </>
  )
}

export default Consultation
