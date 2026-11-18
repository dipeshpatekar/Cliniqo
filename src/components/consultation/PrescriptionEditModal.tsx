import React, { useState, useMemo, useEffect } from "react"
import {
  type Medicine,
  type ClinicalLibrary,
  type Vitals,
  type ConsultationData,
  type Patient,
  type PrescriptionRevisionData,
  getDoseConfig,
  topicalFormulations,
  defaultClinicalLibrary,
  emptyMedicine,
  mergeCustomLibraryValues,
  getChiefComplaintOptions,
  loadCustomChiefComplaints,
  getDiagnosisOptions,
  loadCustomDiagnoses,
  symptomDurationOptions,
  computeDefaultFollowUpDate,
  formatDateDDMMYYYY,
  normalizeMedicineList,
  loadClinicalLibrary,
} from "../../types"
import {
  getLocalFormulary,
  type LocalFormularyItemRecord,
  isTauriDesktop,
} from "../../desktop/desktop-bridge"
import { validateMedicineFormulation } from "../../utils/billing"
import {
  Button,
  IconButton,
  Field,
  TextInput,
  SelectInput,
  SearchableOptionSelect,
  Modal,
  StatusPill,
} from "../common"
import {
  Plus,
  Trash2,
  AlertTriangle,
  ArrowRight,
  CheckCircle,
  Activity,
  Stethoscope,
  Calendar,
  Clock,
  Heart,
  ShieldAlert,
  CalendarDays,
} from "lucide-react"

export interface PrescriptionEditModalProps {
  isOpen: boolean
  onClose: () => void
  prescriptionNumber: string
  currentRevisionNumber: number
  initialMedicines: Medicine[]
  initialVitals?: Vitals
  initialConsultationData?: ConsultationData
  patient?: Patient
  clinicalLibrary?: ClinicalLibrary
  customChiefComplaints?: string[]
  customDiagnoses?: string[]
  clinicId?: string
  onSaveRevision: (
    revisionData: PrescriptionRevisionData | Medicine[],
    reasonForRevision?: string,
  ) => Promise<void>
}

export function PrescriptionEditModal({
  isOpen,
  onClose,
  prescriptionNumber,
  currentRevisionNumber,
  initialMedicines,
  initialVitals,
  initialConsultationData,
  patient,
  clinicalLibrary,
  customChiefComplaints,
  customDiagnoses,
  clinicId,
  onSaveRevision,
}: PrescriptionEditModalProps) {
  // --- SECTION A: Vitals State ---
  const [vitals, setVitals] = useState<Vitals>(() => ({
    systolic: initialVitals?.systolic || "",
    diastolic: initialVitals?.diastolic || "",
    heartRate: initialVitals?.heartRate || "",
    spo2: initialVitals?.spo2 || "",
    temperature: initialVitals?.temperature || "",
    height: initialVitals?.height || "",
    weight: initialVitals?.weight || "",
  }))

  // --- SECTION B: Clinical Notes State ---
  const [chiefComplaint, setChiefComplaint] = useState(
    () => initialConsultationData?.chiefComplaint || "",
  )
  const [symptomDuration, setSymptomDuration] = useState(
    () => initialConsultationData?.symptomDuration || "",
  )
  const [diagnosis, setDiagnosis] = useState(
    () => initialConsultationData?.diagnosis || "",
  )

  // --- SECTION C: Medical Background State ---
  const [allergiesStr, setAllergiesStr] = useState(() =>
    (
      initialConsultationData?.allergies ??
      patient?.allergies ??
      []
    ).join(", "),
  )
  const [conditionsStr, setConditionsStr] = useState(() =>
    (
      initialConsultationData?.conditions ??
      patient?.conditions ??
      []
    ).join(", "),
  )

  // --- SECTION D: Consultation Information State ---
  const [consultationDate, setConsultationDate] = useState(() =>
    initialConsultationData?.date
      ? initialConsultationData.date.split("T")[0]
      : new Date().toISOString().slice(0, 10),
  )
  const [consultationTime, setConsultationTime] = useState(() =>
    initialConsultationData?.time
      ? initialConsultationData.time
      : new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }),
  )

  // --- SECTION E: Prescription Information State ---
  const [medicines, setMedicines] = useState<Medicine[]>(() =>
    initialMedicines.length > 0
      ? normalizeMedicineList(initialMedicines)
      : [emptyMedicine(1)],
  )
  const [followUpDate, setFollowUpDate] = useState(() =>
    initialConsultationData?.followUpDate
      ? initialConsultationData.followUpDate
      : computeDefaultFollowUpDate(consultationDate),
  )
  const [followUpInstructions, setFollowUpInstructions] = useState(
    () => initialConsultationData?.followUpInstructions || "",
  )

  // --- Revision Meta State ---
  const [step, setStep] = useState<"edit" | "confirm">("edit")
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // --- SQLite Local Formulary Items (Desktop) ---
  const [localFormulary, setLocalFormulary] = useState<LocalFormularyItemRecord[]>([])

  useEffect(() => {
    let mounted = true
    if (isTauriDesktop() && clinicId) {
      getLocalFormulary(clinicId)
        .then((items) => {
          if (mounted && items) {
            setLocalFormulary(items)
          }
        })
        .catch(() => {})
    }
    return () => {
      mounted = false
    }
  }, [clinicId])

  if (!isOpen) return null

  // --- Options & Suggestions (with Custom Clinical Library Values) ---
  const lib = useMemo(() => {
    return (
      clinicalLibrary ||
      (clinicId ? loadClinicalLibrary(clinicId) : loadClinicalLibrary()) ||
      defaultClinicalLibrary
    )
  }, [clinicalLibrary, clinicId])

  // Backfill missing fields in medicines if matched with local formulary or definitions
  useEffect(() => {
    if (
      localFormulary.length > 0 ||
      (lib.MedicineDefinitions && lib.MedicineDefinitions.length > 0)
    ) {
      setMedicines((prev) =>
        prev.map((m) => {
          if (!m.name?.trim()) return m
          const match =
            localFormulary.find(
              (f) => f.name.toLowerCase() === m.name.trim().toLowerCase(),
            ) ||
            lib.MedicineDefinitions?.find(
              (d) => d.name.toLowerCase() === m.name.trim().toLowerCase(),
            )
          if (!match) return m

          const strength =
            m.strength ||
            ("strength" in match ? match.strength : undefined) ||
            ""
          const dose =
            m.dose ||
            ("default_dosage" in match
              ? match.default_dosage
              : (match as any).defaultDosage) ||
            ""
          const route =
            m.route ||
            ("default_route" in match
              ? match.default_route
              : (match as any).defaultRoute) ||
            ""
          const frequency =
            m.frequency ||
            ("default_frequency" in match
              ? match.default_frequency
              : (match as any).defaultFrequency) ||
            ""
          const duration =
            m.duration ||
            ("default_duration" in match
              ? match.default_duration
              : (match as any).defaultDuration) ||
            ""

          if (
            (!m.strength && strength) ||
            (!m.dose && dose) ||
            (!m.route && route) ||
            (!m.frequency && frequency) ||
            (!m.duration && duration)
          ) {
            return {
              ...m,
              strength: m.strength || strength,
              dose: m.dose || dose,
              route: m.route || route,
              frequency: m.frequency || frequency,
              duration: m.duration || duration,
            }
          }
          return m
        }),
      )
    }
  }, [localFormulary, lib.MedicineDefinitions])

  const mergedFormulations = useMemo(() => {
    const fromMeds = medicines.map((m) => m.formulation).filter(Boolean)
    const fromInit = (initialMedicines || []).map((m) => m.formulation).filter(Boolean)
    const fromFormulary = localFormulary.map((f) => f.formulation).filter(Boolean)
    const fromDefs = (lib.MedicineDefinitions || [])
      .map((d) => d.formulation)
      .filter(Boolean)
    return mergeCustomLibraryValues(
      lib.Formulations || defaultClinicalLibrary.Formulations,
      [...fromMeds, ...fromInit, ...fromFormulary, ...fromDefs],
    )
  }, [lib.Formulations, lib.MedicineDefinitions, medicines, initialMedicines, localFormulary])

  const mergedMedicineNames = useMemo(() => {
    const fromMeds = medicines.map((m) => m.name).filter(Boolean)
    const fromInit = (initialMedicines || []).map((m) => m.name).filter(Boolean)
    const fromFormulary = localFormulary.map((f) => f.name).filter(Boolean)
    const fromDefs = (lib.MedicineDefinitions || [])
      .map((d) => d.name)
      .filter(Boolean)
    return mergeCustomLibraryValues(
      lib.Medicines || defaultClinicalLibrary.Medicines,
      [...fromMeds, ...fromInit, ...fromFormulary, ...fromDefs],
    )
  }, [lib.Medicines, lib.MedicineDefinitions, medicines, initialMedicines, localFormulary])

  const mergedStrengths = useMemo(() => {
    const fromMeds = medicines.map((m) => m.strength).filter(Boolean)
    const fromInit = (initialMedicines || []).map((m) => m.strength).filter(Boolean)
    const fromFormulary = localFormulary
      .map((f) => f.strength)
      .filter(Boolean) as string[]
    const fromDefs = (lib.MedicineDefinitions || [])
      .map((d) => d.strength)
      .filter(Boolean) as string[]
    return mergeCustomLibraryValues(
      lib.Strengths || defaultClinicalLibrary.Strengths,
      [...fromMeds, ...fromInit, ...fromFormulary, ...fromDefs],
    )
  }, [lib.Strengths, lib.MedicineDefinitions, medicines, initialMedicines, localFormulary])

  const mergedDoses = useMemo(() => {
    const fromMeds = medicines.map((m) => m.dose).filter(Boolean)
    const fromInit = (initialMedicines || []).map((m) => m.dose).filter(Boolean)
    const fromFormulary = localFormulary
      .map((f) => f.default_dosage)
      .filter(Boolean) as string[]
    const fromDefs = (lib.MedicineDefinitions || [])
      .map((d) => d.defaultDosage)
      .filter(Boolean) as string[]
    return mergeCustomLibraryValues(
      lib.Doses || defaultClinicalLibrary.Doses,
      [...fromMeds, ...fromInit, ...fromFormulary, ...fromDefs],
    )
  }, [lib.Doses, lib.MedicineDefinitions, medicines, initialMedicines, localFormulary])

  const mergedFrequencies = useMemo(() => {
    const fromMeds = medicines.map((m) => m.frequency).filter(Boolean)
    const fromInit = (initialMedicines || []).map((m) => m.frequency).filter(Boolean)
    const fromFormulary = localFormulary
      .map((f) => f.default_frequency)
      .filter(Boolean) as string[]
    const fromDefs = (lib.MedicineDefinitions || [])
      .map((d) => d.defaultFrequency)
      .filter(Boolean) as string[]
    return mergeCustomLibraryValues(
      lib.Frequencies || defaultClinicalLibrary.Frequencies,
      [...fromMeds, ...fromInit, ...fromFormulary, ...fromDefs],
    )
  }, [lib.Frequencies, lib.MedicineDefinitions, medicines, initialMedicines, localFormulary])

  const mergedDurations = useMemo(() => {
    const fromMeds = medicines.map((m) => m.duration).filter(Boolean)
    const fromInit = (initialMedicines || []).map((m) => m.duration).filter(Boolean)
    const fromFormulary = localFormulary
      .map((f) => f.default_duration)
      .filter(Boolean) as string[]
    const fromDefs = (lib.MedicineDefinitions || [])
      .map((d) => d.defaultDuration)
      .filter(Boolean) as string[]
    return mergeCustomLibraryValues(
      lib.Durations || defaultClinicalLibrary.Durations,
      [...fromMeds, ...fromInit, ...fromFormulary, ...fromDefs],
    )
  }, [lib.Durations, lib.MedicineDefinitions, medicines, initialMedicines, localFormulary])

  const mergedFoodInstructions = useMemo(() => {
    const fromMeds = medicines.map((m) => m.food).filter(Boolean)
    const fromInit = (initialMedicines || []).map((m) => m.food).filter(Boolean)
    return mergeCustomLibraryValues(
      lib.FoodInstructions || defaultClinicalLibrary.FoodInstructions,
      [...fromMeds, ...fromInit],
    )
  }, [lib.FoodInstructions, medicines, initialMedicines])

  const mergedChiefComplaints = useMemo(
    () =>
      getChiefComplaintOptions(
        customChiefComplaints !== undefined
          ? customChiefComplaints
          : loadCustomChiefComplaints(clinicId),
      ),
    [customChiefComplaints, clinicId],
  )

  const mergedDiagnoses = useMemo(
    () =>
      getDiagnosisOptions(
        customDiagnoses !== undefined
          ? customDiagnoses
          : loadCustomDiagnoses(clinicId),
      ),
    [customDiagnoses, clinicId],
  )

  // --- Handlers ---
  const updateVital = (key: keyof Vitals, val: string) => {
    setVitals((prev) => ({ ...prev, [key]: val }))
  }

  const addRow = () => {
    const nextId = Math.max(...medicines.map((m) => m.id), 0) + 1
    setMedicines([...medicines, emptyMedicine(nextId)])
  }

  const removeRow = (id: number) => {
    setMedicines(medicines.filter((m) => m.id !== id))
  }

  const updateRow = (id: number, key: keyof Medicine, value: string) => {
    setMedicines((prev) =>
      prev.map((row) => (row.id === id ? { ...row, [key]: value } : row)),
    )
  }

  const handleMedicineNameChange = (id: number, name: string) => {
    const trimmed = name.trim()
    const def =
      localFormulary.find(
        (f) => f.name.toLowerCase() === trimmed.toLowerCase(),
      ) ||
      lib.MedicineDefinitions?.find(
        (d) => d.name.toLowerCase() === trimmed.toLowerCase(),
      )

    setMedicines((prev) =>
      prev.map((row) => {
        if (row.id !== id) return row
        if (!def) return { ...row, name }

        const doseVal =
          ("default_dosage" in def
            ? def.default_dosage
            : (def as any).defaultDosage) || ""
        const freqVal =
          ("default_frequency" in def
            ? def.default_frequency
            : (def as any).defaultFrequency) || ""
        const durVal =
          ("default_duration" in def
            ? def.default_duration
            : (def as any).defaultDuration) || ""
        const dirVal =
          ("default_instructions" in def
            ? def.default_instructions
            : (def as any).defaultInstructions) || ""
        const routeVal =
          ("default_route" in def
            ? def.default_route
            : (def as any).defaultRoute) || ""

        return {
          ...row,
          name,
          formulation: row.formulation || def.formulation || "Tablet",
          strength: row.strength || def.strength || "",
          dose: row.dose || doseVal || "",
          frequency: row.frequency || freqVal || "",
          duration: row.duration || durVal || "",
          route: row.route || routeVal || "",
          directions: row.directions || dirVal || "",
        }
      }),
    )
  }

  const handleFormulationChange = (id: number, formulation: string) => {
    setMedicines((prev) =>
      prev.map((row) => {
        if (row.id !== id) return row
        return {
          ...row,
          formulation,
          route: formulation === "Injection" ? "Intravenous (IV)" : "",
          food: topicalFormulations.has(formulation)
            ? "Not applicable"
            : row.food,
        }
      }),
    )
  }

  const validationResults = medicines.map((m) => validateMedicineFormulation(m))
  const allMedicinesValid =
    medicines.length > 0 && validationResults.every((v) => v.valid)

  const handleProceedToConfirm = () => {
    setError(null)
    if (medicines.length === 0) {
      setError("At least one medicine is required")
      return
    }
    const invalidIndex = validationResults.findIndex((v) => !v.valid)
    if (invalidIndex !== -1) {
      setError(
        `Medicine #${invalidIndex + 1} (${medicines[invalidIndex].name || "Unnamed"}): ${validationResults[invalidIndex].error}`,
      )
      return
    }
    setStep("confirm")
  }

  const handleFinalSave = async () => {
    setError(null)
    setIsSubmitting(true)
    try {
      const parsedAllergies = allergiesStr
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
      const parsedConditions = conditionsStr
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)

      const revisionData: PrescriptionRevisionData = {
        medicines,
        vitals,
        chiefComplaint: chiefComplaint.trim(),
        symptomDuration: symptomDuration.trim(),
        diagnosis: diagnosis.trim(),
        allergies: parsedAllergies,
        conditions: parsedConditions,
        consultationDate,
        consultationTime,
        followUpDate,
        followUpInstructions: followUpInstructions.trim(),
        reasonForRevision: "Prescription revision",
      }

      await onSaveRevision(revisionData, "Prescription revision")
      onClose()
    } catch (err: any) {
      setError(err?.message || "Failed to save prescription revision.")
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Modal
      title={
        step === "edit"
          ? `Edit Prescription (${prescriptionNumber} · Rev ${currentRevisionNumber})`
          : `Review & Confirm Revision ${currentRevisionNumber + 1}`
      }
      description={
        step === "edit"
          ? "Modify clinical notes, vitals, consultation details or medicines. Finalizing creates an immutable new revision."
          : `Please confirm all changes for Revision ${currentRevisionNumber + 1}. Previous revisions remain unchanged.`
      }
      onClose={onClose}
      width="wide"
    >
      <div className="space-y-5 max-h-[80vh] overflow-y-auto px-4 py-3">
        {error && (
          <div
            className="p-3 bg-red-50 dark:bg-red-950/40 border border-red-300 dark:border-red-800 text-red-700 dark:text-red-300 rounded-lg text-sm flex items-start gap-2"
            role="alert"
          >
            <AlertTriangle size={18} className="shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {step === "edit" ? (
          <>
            {/* 1. CONSULTATION DETAILS SECTION */}
            <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/40 space-y-3">
              <div className="flex items-center gap-2 pb-1 border-b border-slate-200/80 dark:border-slate-800">
                <Calendar size={16} className="text-teal-600 dark:text-teal-400" />
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                  Consultation Information
                </h3>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <Field label="Consultation Date">
                  <TextInput
                    type="date"
                    value={consultationDate}
                    onChange={(e) => setConsultationDate(e.target.value)}
                  />
                </Field>
                <Field label="Consultation Time">
                  <TextInput
                    type="time"
                    value={consultationTime}
                    onChange={(e) => setConsultationTime(e.target.value)}
                  />
                </Field>
              </div>
            </div>

            {/* 2. CLINICAL NOTES SECTION */}
            <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/40 space-y-3">
              <div className="flex items-center gap-2 pb-1 border-b border-slate-200/80 dark:border-slate-800">
                <Stethoscope
                  size={16}
                  className="text-teal-600 dark:text-teal-400"
                />
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                  Clinical Notes
                </h3>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
                <Field label="Chief Complaints">
                  <SearchableOptionSelect
                    id="edit-chief-complaint"
                    value={chiefComplaint}
                    options={mergedChiefComplaints}
                    onChange={setChiefComplaint}
                    placeholder="Search or enter chief complaint"
                    ariaLabel="Search and select chief complaint"
                    emptyMessage="Type custom complaint"
                  />
                </Field>
                <Field label="Symptom Duration">
                  <SearchableOptionSelect
                    id="edit-symptom-duration"
                    value={symptomDuration}
                    options={symptomDurationOptions}
                    onChange={setSymptomDuration}
                    placeholder="Select or enter duration"
                    ariaLabel="Search and select symptom duration"
                    emptyMessage="Type custom duration"
                  />
                </Field>
                <Field label="Diagnosis">
                  <SearchableOptionSelect
                    id="edit-diagnosis"
                    value={diagnosis}
                    options={mergedDiagnoses}
                    onChange={setDiagnosis}
                    placeholder="Search or enter diagnosis"
                    ariaLabel="Search and select diagnosis"
                    emptyMessage="Type custom diagnosis"
                  />
                </Field>
              </div>
            </div>

            {/* 3. PATIENT VITALS SECTION */}
            <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/40 space-y-3">
              <div className="flex items-center gap-2 pb-1 border-b border-slate-200/80 dark:border-slate-800">
                <Activity size={16} className="text-teal-600 dark:text-teal-400" />
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                  Patient Vitals
                </h3>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3">
                <Field label="BP (Systolic)">
                  <TextInput
                    placeholder="120"
                    value={vitals.systolic}
                    onChange={(e) => updateVital("systolic", e.target.value)}
                  />
                </Field>
                <Field label="BP (Diastolic)">
                  <TextInput
                    placeholder="80"
                    value={vitals.diastolic}
                    onChange={(e) => updateVital("diastolic", e.target.value)}
                  />
                </Field>
                <Field label="Heart Rate (bpm)">
                  <TextInput
                    placeholder="72"
                    value={vitals.heartRate}
                    onChange={(e) => updateVital("heartRate", e.target.value)}
                  />
                </Field>
                <Field label="SpO₂ (%)">
                  <TextInput
                    placeholder="98"
                    value={vitals.spo2}
                    onChange={(e) => updateVital("spo2", e.target.value)}
                  />
                </Field>
                <Field label="Temp (°F)">
                  <TextInput
                    placeholder="98.6"
                    value={vitals.temperature}
                    onChange={(e) => updateVital("temperature", e.target.value)}
                  />
                </Field>
                <Field label="Weight (kg)">
                  <TextInput
                    placeholder="65"
                    value={vitals.weight}
                    onChange={(e) => updateVital("weight", e.target.value)}
                  />
                </Field>
              </div>
            </div>

            {/* 4. MEDICAL BACKGROUND SECTION */}
            <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/40 space-y-3">
              <div className="flex items-center gap-2 pb-1 border-b border-slate-200/80 dark:border-slate-800">
                <ShieldAlert
                  size={16}
                  className="text-teal-600 dark:text-teal-400"
                />
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                  Medical Background
                </h3>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <Field label="Known Allergies (comma-separated)">
                  <TextInput
                    value={allergiesStr}
                    onChange={(e) => setAllergiesStr(e.target.value)}
                    placeholder="e.g. Penicillin, Sulfa drugs"
                  />
                </Field>
                <Field label="Medical History (comma-separated)">
                  <TextInput
                    value={conditionsStr}
                    onChange={(e) => setConditionsStr(e.target.value)}
                    placeholder="e.g. Hypertension, Type 2 diabetes"
                  />
                </Field>
              </div>
            </div>

            {/* 5. MEDICINES LIST SECTION */}
            <div className="space-y-3">
              <div className="flex items-center justify-between pb-2 border-b border-slate-200 dark:border-slate-800">
                <div className="flex items-center gap-2">
                  <Heart
                    size={16}
                    className="text-teal-600 dark:text-teal-400"
                  />
                  <span className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                    Medicines List ({medicines.length})
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={Plus}
                  onClick={addRow}
                >
                  Add medicine
                </Button>
              </div>

              <div className="space-y-3.5">
                {medicines.map((medicine, idx) => {
                  const doseConfig = getDoseConfig(medicine.formulation)
                  const validation = validationResults[idx]
                  return (
                    <div
                      key={medicine.id}
                      className={`p-3.5 rounded-xl border ${
                        validation.valid
                          ? "border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60"
                          : "border-amber-300 dark:border-amber-800 bg-amber-50/30 dark:bg-amber-950/20"
                      } shadow-xs space-y-3`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-slate-400 dark:text-slate-500">
                          #{idx + 1}
                        </span>
                        <IconButton
                          label={`Remove medicine ${idx + 1}`}
                          onClick={() => removeRow(medicine.id)}
                          disabled={medicines.length <= 1}
                          className="text-red-400 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300 p-1"
                        >
                          <Trash2 size={16} />
                        </IconButton>
                      </div>

                      {/* Row 1: Formulation, Medicine Name, Strength, Dose */}
                      <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
                        <div className="sm:col-span-3">
                          <Field label="Formulation *">
                            <SelectInput
                              value={medicine.formulation}
                              onChange={(e) =>
                                handleFormulationChange(
                                  medicine.id,
                                  e.target.value,
                                )
                              }
                            >
                              <option value="">Select formulation</option>
                              {mergedFormulations.map((f) => (
                                <option key={f} value={f}>
                                  {f}
                                </option>
                              ))}
                            </SelectInput>
                          </Field>
                        </div>

                        <div className="sm:col-span-4">
                          <Field label="Medicine Name *">
                            <SearchableOptionSelect
                              id={`edit-med-name-${medicine.id}`}
                              value={medicine.name}
                              options={mergedMedicineNames}
                              onChange={(val) =>
                                handleMedicineNameChange(medicine.id, val)
                              }
                              placeholder="e.g. Paracetamol"
                              ariaLabel="Medicine name"
                              emptyMessage="Type custom medicine name"
                            />
                          </Field>
                        </div>

                        <div className="sm:col-span-3">
                          <Field label="Strength *">
                            <SearchableOptionSelect
                              id={`edit-med-strength-${medicine.id}`}
                              value={medicine.strength}
                              options={mergedStrengths}
                              onChange={(val) =>
                                updateRow(medicine.id, "strength", val)
                              }
                              placeholder="e.g. 500 mg"
                              ariaLabel="Medicine strength"
                              emptyMessage="Type custom strength"
                            />
                          </Field>
                        </div>

                        <div className="sm:col-span-2">
                          <Field
                            label={`Dose (${doseConfig.unit || "unit"}) *`}
                          >
                            <SearchableOptionSelect
                              id={`edit-med-dose-${medicine.id}`}
                              value={medicine.dose}
                              options={mergedDoses}
                              onChange={(val) =>
                                updateRow(medicine.id, "dose", val)
                              }
                              placeholder={doseConfig.placeholder || "1"}
                              ariaLabel="Medicine dose"
                              emptyMessage="Type custom dose"
                            />
                          </Field>
                        </div>
                      </div>

                      {/* Row 2: Frequency, Duration, Food timing */}
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <Field label="Frequency *">
                          <SearchableOptionSelect
                            id={`edit-med-frequency-${medicine.id}`}
                            value={medicine.frequency}
                            options={mergedFrequencies}
                            onChange={(val) =>
                              updateRow(medicine.id, "frequency", val)
                            }
                            placeholder="Select or enter frequency"
                            ariaLabel="Medicine frequency"
                            emptyMessage="Type custom frequency"
                          />
                        </Field>

                        <Field label="Duration *">
                          <SearchableOptionSelect
                            id={`edit-med-duration-${medicine.id}`}
                            value={medicine.duration}
                            options={mergedDurations}
                            onChange={(val) =>
                              updateRow(medicine.id, "duration", val)
                            }
                            placeholder="e.g. 5 days"
                            ariaLabel="Medicine duration"
                            emptyMessage="Type custom duration"
                          />
                        </Field>

                        <Field label="Food Timing">
                          <SearchableOptionSelect
                            id={`edit-med-food-${medicine.id}`}
                            value={medicine.food}
                            options={mergedFoodInstructions}
                            onChange={(val) =>
                              updateRow(medicine.id, "food", val)
                            }
                            placeholder="Select or enter food timing"
                            ariaLabel="Food timing"
                            emptyMessage="Type custom food timing"
                          />
                        </Field>
                      </div>

                      {medicine.formulation === "Injection" && (
                        <Field label="Route (Required for Injection)">
                          <SelectInput
                            value={medicine.route}
                            onChange={(e) =>
                              updateRow(medicine.id, "route", e.target.value)
                            }
                          >
                            <option value="">Select route</option>
                            <option value="Intravenous (IV)">
                              Intravenous (IV)
                            </option>
                            <option value="Intramuscular (IM)">
                              Intramuscular (IM)
                            </option>
                            <option value="Subcutaneous (SC)">
                              Subcutaneous (SC)
                            </option>
                          </SelectInput>
                        </Field>
                      )}

                      {topicalFormulations.has(medicine.formulation) && (
                        <Field label="Directions (Required for Topical)">
                          <TextInput
                            value={medicine.directions}
                            onChange={(e) =>
                              updateRow(
                                medicine.id,
                                "directions",
                                e.target.value,
                              )
                            }
                            placeholder="Apply to affected area twice daily"
                          />
                        </Field>
                      )}

                      {!validation.valid && (
                        <p className="text-xs text-amber-600 dark:text-amber-400 font-medium">
                          ⚠️ {validation.error}
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>

              <div className="flex justify-center pt-1">
                <Button
                  size="sm"
                  variant="secondary"
                  icon={Plus}
                  onClick={addRow}
                >
                  Add medicine
                </Button>
              </div>
            </div>

            {/* 6. FOLLOW-UP & ADDITIONAL ADVICE (ADV) SECTION */}
            <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/40 space-y-3">
              <div className="flex items-center gap-2 pb-1 border-b border-slate-200/80 dark:border-slate-800">
                <CalendarDays
                  size={16}
                  className="text-teal-600 dark:text-teal-400"
                />
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                  Follow-up & Additional Advice
                </h3>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <Field label="Follow-up Date">
                  <TextInput
                    type="date"
                    value={followUpDate}
                    onChange={(e) => setFollowUpDate(e.target.value)}
                  />
                </Field>
                <Field label="Additional Advice (ADV)">
                  <TextInput
                    value={followUpInstructions}
                    onChange={(e) => setFollowUpInstructions(e.target.value)}
                    placeholder="e.g. Review in clinic after 3 days with reports"
                  />
                </Field>
              </div>
            </div>

            {/* STICKY ACCESSIBLE FOOTER */}
            <div className="sticky -bottom-3 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 pt-3 pb-2 flex justify-end items-center gap-3 z-10">
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button
                variant="primary"
                icon={ArrowRight}
                onClick={handleProceedToConfirm}
                disabled={!allMedicinesValid}
              >
                Review changes
              </Button>
            </div>
          </>
        ) : (
          <div className="space-y-4">
            <div className="p-3.5 rounded-lg bg-teal-50 dark:bg-teal-950/40 border border-teal-200 dark:border-teal-800 text-sm space-y-1.5">
              <p className="font-semibold text-teal-900 dark:text-teal-200">
                Revision Details
              </p>
              <p className="text-teal-800 dark:text-teal-300 text-xs">
                Prescription: <strong>{prescriptionNumber}</strong> · Target:{" "}
                <strong>Revision {currentRevisionNumber + 1}</strong>
              </p>
            </div>

            {/* Revision Summary Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 space-y-1">
                <span className="font-bold uppercase tracking-wider text-slate-500">
                  Consultation Info
                </span>
                <p>
                  Date: {formatDateDDMMYYYY(consultationDate) || "N/A"} · Time:{" "}
                  {consultationTime || "N/A"}
                </p>
                <p>
                  Complaint: {chiefComplaint || "None"}
                  {symptomDuration ? ` (${symptomDuration})` : ""}
                </p>
                <p>Diagnosis: {diagnosis || "None"}</p>
              </div>

              <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 space-y-1">
                <span className="font-bold uppercase tracking-wider text-slate-500">
                  Vitals & Follow-up
                </span>
                <p>
                  BP:{" "}
                  {vitals.systolic && vitals.diastolic
                    ? `${vitals.systolic}/${vitals.diastolic} mmHg`
                    : "—"}{" "}
                  · HR: {vitals.heartRate ? `${vitals.heartRate} bpm` : "—"} ·
                  SpO₂: {vitals.spo2 ? `${vitals.spo2}%` : "—"}
                </p>
                <p>
                  Follow-up: {formatDateDDMMYYYY(followUpDate) || "N/A"} · ADV:{" "}
                  {followUpInstructions || "None"}
                </p>
                <p>
                  Allergies: {allergiesStr || "None"} · History:{" "}
                  {conditionsStr || "None"}
                </p>
              </div>
            </div>

            <div>
              <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">
                Medicines in Revision {currentRevisionNumber + 1} (
                {medicines.length})
              </p>
              <ul className="divide-y divide-slate-200 dark:divide-slate-800 border rounded-lg border-slate-200 dark:border-slate-800">
                {medicines.map((m, idx) => (
                  <li
                    key={m.id}
                    className="p-2.5 text-xs flex justify-between items-center"
                  >
                    <div>
                      <strong className="text-slate-800 dark:text-slate-200">
                        {idx + 1}. {m.name} ({m.formulation}) {m.strength}
                      </strong>
                      <p className="text-slate-500 mt-0.5">
                        Dose: {m.dose} · {m.frequency} · {m.duration}
                        {m.food ? ` · ${m.food}` : ""}
                        {m.route ? ` · ${m.route}` : ""}
                        {m.directions ? ` · ${m.directions}` : ""}
                      </p>
                    </div>
                    <CheckCircle
                      size={16}
                      className="text-teal-600 shrink-0"
                    />
                  </li>
                ))}
              </ul>
            </div>

            {/* STICKY ACCESSIBLE CONFIRM FOOTER */}
            <div className="sticky -bottom-3 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 pt-3 pb-2 flex justify-end gap-2 z-10">
              <Button
                variant="ghost"
                onClick={() => setStep("edit")}
                disabled={isSubmitting}
              >
                Back to edit
              </Button>
              <Button
                variant="primary"
                onClick={handleFinalSave}
                isLoading={isSubmitting}
              >
                Finalize Revision {currentRevisionNumber + 1}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}

export default PrescriptionEditModal
