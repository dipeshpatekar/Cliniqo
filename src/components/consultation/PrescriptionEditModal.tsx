import React, { useState } from "react"
import {
  type Medicine,
  type ClinicalLibrary,
  getDoseConfig,
  topicalFormulations,
  defaultClinicalLibrary,
  emptyMedicine,
} from "../../types"
import { validateMedicineFormulation } from "../../utils/billing"
import {
  Button,
  IconButton,
  Field,
  TextInput,
  SelectInput,
  Modal,
} from "../common"
import { Plus, Trash2, AlertTriangle, ArrowRight, CheckCircle } from "lucide-react"

export interface PrescriptionEditModalProps {
  isOpen: boolean
  onClose: () => void
  prescriptionNumber: string
  currentRevisionNumber: number
  initialMedicines: Medicine[]
  clinicalLibrary?: ClinicalLibrary
  onSaveRevision: (medicines: Medicine[], reasonForRevision: string) => Promise<void>
}

export function PrescriptionEditModal({
  isOpen,
  onClose,
  prescriptionNumber,
  currentRevisionNumber,
  initialMedicines,
  clinicalLibrary,
  onSaveRevision,
}: PrescriptionEditModalProps) {
  const [medicines, setMedicines] = useState<Medicine[]>(() =>
    initialMedicines.length > 0 ? JSON.parse(JSON.stringify(initialMedicines)) : [emptyMedicine(1)],
  )
  const [reasonForRevision, setReasonForRevision] = useState("")
  const [step, setStep] = useState<"edit" | "confirm">("edit")
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!isOpen) return null

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

  const handleFormulationChange = (id: number, formulation: string) => {
    setMedicines((prev) =>
      prev.map((row) => {
        if (row.id !== id) return row
        return {
          ...row,
          formulation,
          route: formulation === "Injection" ? "Intravenous (IV)" : "",
          food: topicalFormulations.has(formulation) ? "Not applicable" : row.food,
        }
      }),
    )
  }

  const validationResults = medicines.map((m) => validateMedicineFormulation(m))
  const allMedicinesValid =
    medicines.length > 0 && validationResults.every((v) => v.valid)
  const isReasonValid = reasonForRevision.trim().length >= 5

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
    if (!isReasonValid) {
      setError("Please provide a valid reason for revision (at least 5 characters).")
      return
    }
    setStep("confirm")
  }

  const handleFinalSave = async () => {
    setError(null)
    setIsSubmitting(true)
    try {
      await onSaveRevision(medicines, reasonForRevision.trim())
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
          ? "Modify medicines or dosing terms. Finalizing will create an immutable new revision."
          : `Please confirm the changes for Revision ${currentRevisionNumber + 1}. Previous revisions remain unchanged.`
      }
      onClose={onClose}
      width="large"
    >
      <div className="space-y-4 max-h-[75vh] overflow-y-auto px-4 py-3">
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
            <div className="flex items-center justify-between pb-2 border-b border-slate-200 dark:border-slate-800">
              <span className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                Medicines list ({medicines.length})
              </span>
              <Button size="sm" variant="secondary" icon={Plus} onClick={addRow}>
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

                    <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
                      <div className="sm:col-span-4">
                        <Field label="Formulation *">
                          <SelectInput
                            value={medicine.formulation}
                            onChange={(e) =>
                              handleFormulationChange(medicine.id, e.target.value)
                            }
                          >
                            <option value="">Select</option>
                            {(clinicalLibrary?.Formulations || defaultClinicalLibrary.Formulations).map((f) => (
                              <option key={f} value={f}>
                                {f}
                              </option>
                            ))}
                          </SelectInput>
                        </Field>
                      </div>

                      <div className="sm:col-span-5">
                        <Field label="Medicine Name *">
                          <TextInput
                            value={medicine.name}
                            onChange={(e) =>
                              updateRow(medicine.id, "name", e.target.value)
                            }
                            placeholder="e.g. Paracetamol"
                          />
                        </Field>
                      </div>

                      <div className="sm:col-span-3">
                        <Field label="Strength *">
                          <TextInput
                            value={medicine.strength}
                            onChange={(e) =>
                              updateRow(medicine.id, "strength", e.target.value)
                            }
                            placeholder="e.g. 500 mg"
                          />
                        </Field>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <Field label={`Dose (${doseConfig.unit || "unit"}) *`}>
                        <TextInput
                          value={medicine.dose}
                          onChange={(e) =>
                            updateRow(medicine.id, "dose", e.target.value)
                          }
                          placeholder={doseConfig.placeholder || "1"}
                        />
                      </Field>

                      <Field label="Frequency *">
                        <SelectInput
                          value={medicine.frequency}
                          onChange={(e) =>
                            updateRow(medicine.id, "frequency", e.target.value)
                          }
                        >
                          <option value="">Select</option>
                          <option value="Once daily">Once daily</option>
                          <option value="Twice daily">Twice daily</option>
                          <option value="Three times daily">Three times</option>
                          <option value="Four times daily">Four times</option>
                          <option value="As needed">As needed (SOS)</option>
                        </SelectInput>
                      </Field>

                      <Field label="Duration *">
                        <TextInput
                          value={medicine.duration}
                          onChange={(e) =>
                            updateRow(medicine.id, "duration", e.target.value)
                          }
                          placeholder="e.g. 5 days"
                        />
                      </Field>

                      <Field label="Food timing">
                        <SelectInput
                          value={medicine.food}
                          onChange={(e) =>
                            updateRow(medicine.id, "food", e.target.value)
                          }
                        >
                          <option value="">Select</option>
                          <option value="After food">After food</option>
                          <option value="Before food">Before food</option>
                          <option value="With food">With food</option>
                          <option value="Not applicable">Not applicable</option>
                        </SelectInput>
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
                          <option value="Intravenous (IV)">Intravenous (IV)</option>
                          <option value="Intramuscular (IM)">Intramuscular (IM)</option>
                          <option value="Subcutaneous (SC)">Subcutaneous (SC)</option>
                        </SelectInput>
                      </Field>
                    )}

                    {topicalFormulations.has(medicine.formulation) && (
                      <Field label="Directions (Required for Topical)">
                        <TextInput
                          value={medicine.directions}
                          onChange={(e) =>
                            updateRow(medicine.id, "directions", e.target.value)
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
              <Button size="sm" variant="secondary" icon={Plus} onClick={addRow}>
                Add medicine
              </Button>
            </div>

            <div className="pt-2">
              <Field
                label="Reason for revision (Required, min 5 characters) *"
                className="w-full"
              >
                <TextInput
                  value={reasonForRevision}
                  onChange={(e) => setReasonForRevision(e.target.value)}
                  placeholder="e.g. Adjusted antibiotic duration due to persistent cough"
                  className="w-full"
                />
              </Field>
            </div>

            <div className="flex justify-end items-center gap-3 pt-3 border-t border-slate-200 dark:border-slate-800">
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button
                variant="primary"
                icon={ArrowRight}
                onClick={handleProceedToConfirm}
                disabled={!allMedicinesValid || !isReasonValid}
              >
                Review changes
              </Button>
            </div>
          </>
        ) : (
          <div className="space-y-4">
            <div className="p-3 rounded-lg bg-teal-50 dark:bg-teal-950/40 border border-teal-200 dark:border-teal-800 text-sm">
              <p className="font-semibold text-teal-900 dark:text-teal-200">
                Revision Details
              </p>
              <p className="text-teal-800 dark:text-teal-300 text-xs mt-1">
                Prescription: <strong>{prescriptionNumber}</strong> · Target Revision:{" "}
                <strong>Revision {currentRevisionNumber + 1}</strong>
              </p>
              <p className="text-teal-800 dark:text-teal-300 text-xs mt-1">
                Reason: <em>"{reasonForRevision}"</em>
              </p>
            </div>

            <div>
              <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">
                Medicines in Revision {currentRevisionNumber + 1} ({medicines.length})
              </p>
              <ul className="divide-y divide-slate-200 dark:divide-slate-800 border rounded-lg border-slate-200 dark:border-slate-800">
                {medicines.map((m, idx) => (
                  <li key={m.id} className="p-2.5 text-xs flex justify-between items-center">
                    <div>
                      <strong className="text-slate-800 dark:text-slate-200">
                        {idx + 1}. {m.name} ({m.formulation}) {m.strength}
                      </strong>
                      <p className="text-slate-500 mt-0.5">
                        Dose: {m.dose} · {m.frequency} · {m.duration}
                        {m.food ? ` · ${m.food}` : ""}
                        {m.route ? ` · ${m.route}` : ""}
                      </p>
                    </div>
                    <CheckCircle size={16} className="text-teal-600 shrink-0" />
                  </li>
                ))}
              </ul>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-slate-200 dark:border-slate-800">
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
