import { useState, useEffect } from "react"
import { Plus, ShieldCheck } from "lucide-react"
import type {
  ClinicalLibrary,
  ClinicalLibraryCategory,
  ClinicalMedicineDefinition,
} from "../../types"
import { clinicalLibraryCategories } from "../../types"
import { cn } from "../../utils/cn"
import { Button, Field, TextInput, SelectInput } from "../common"
import {
  isTauriDesktop,
  saveLocalFormularyItem,
  getLocalFormulary,
  type DesktopSessionContext,
} from "../../desktop/desktop-bridge"

export interface ClinicalLibrarySettingsProps {
  library: ClinicalLibrary
  onAdd: (category: ClinicalLibraryCategory, value: string) => void
  onAddMedicine: (medicine: ClinicalMedicineDefinition) => void
  desktopSession?: DesktopSessionContext | null
}

export function ClinicalLibrarySettings({
  library,
  onAdd,
  onAddMedicine,
  desktopSession,
}: ClinicalLibrarySettingsProps) {
  const [category, setCategory] = useState<ClinicalLibraryCategory>("Medicines")
  const [newItem, setNewItem] = useState("")
  const [medicineName, setMedicineName] = useState("")
  const [medicineFormulation, setMedicineFormulation] = useState("")
  const [medicineStrength, setMedicineStrength] = useState("")
  const [activeIngredient, setActiveIngredient] = useState("")
  const [defaultInstructions, setDefaultInstructions] = useState("")

  useEffect(() => {
    if (!isTauriDesktop() || !desktopSession?.clinic_id) return
    let mounted = true
    getLocalFormulary(desktopSession.clinic_id)
      .then((items) => {
        if (!mounted || !items) return
        for (const f of items) {
          onAddMedicine({
            id: f.id,
            name: f.name,
            formulation: f.formulation,
            strength: f.strength || "",
            activeIngredient: f.active_ingredient || undefined,
            defaultDosage: f.default_dosage || undefined,
            defaultRoute: f.default_route || undefined,
            defaultFrequency: f.default_frequency || undefined,
            defaultDuration: f.default_duration || undefined,
            defaultInstructions: f.default_instructions || undefined,
          })
        }
      })
      .catch((err) => {
        console.warn("Failed to load local formulary in Settings:", err)
      })
    return () => {
      mounted = false
    }
  }, [desktopSession?.clinic_id])

  const addItem = () => {
    const value = newItem.trim()
    if (
      !value ||
      library[category].some(
        (item) => item.toLowerCase() === value.toLowerCase(),
      )
    )
      return
    onAdd(category, value)
    setNewItem("")
  }

  const addMedicine = async () => {
    const name = medicineName.trim()
    if (!name || !medicineFormulation || !medicineStrength) return

    if (isTauriDesktop() && desktopSession?.clinic_id) {
      try {
        await saveLocalFormularyItem({
          clinic_id: desktopSession.clinic_id,
          name,
          formulation: medicineFormulation,
          strength: medicineStrength,
          active_ingredient: activeIngredient.trim() || null,
          default_instructions: defaultInstructions.trim() || null,
        })
      } catch (err) {
        console.error("Failed to save formulary item to SQLite:", err)
      }
    }

    onAddMedicine({
      name,
      formulation: medicineFormulation,
      strength: medicineStrength,
      activeIngredient: activeIngredient.trim() || undefined,
      defaultInstructions: defaultInstructions.trim() || undefined,
    })

    setMedicineName("")
    setMedicineFormulation("")
    setMedicineStrength("")
    setActiveIngredient("")
    setDefaultInstructions("")
  }

  return (
    <section className="settings-section">
      <div className="settings-title">
        <h2>Clinical formulary & library</h2>
        <p>
          Custom medicines and options are saved securely in local encrypted
          storage and synced.
        </p>
      </div>
      <div className="library-tabs" role="tablist">
        {clinicalLibraryCategories.map((item) => (
          <button
            key={item}
            role="tab"
            aria-selected={category === item}
            className={category === item ? "active" : ""}
            onClick={() => setCategory(item)}
          >
            {item}
            <span>{library[item].length}</span>
          </button>
        ))}
      </div>
      {category === "Medicines" ? (
        <div className="medicine-library-form">
          <div className="library-step">
            <span>1</span>
            <Field label="Formulation" required>
              <SelectInput
                id="library-formulation-select"
                value={medicineFormulation}
                onChange={(event) => setMedicineFormulation(event.target.value)}
              >
                <option value="">Select formulation</option>
                {library.Formulations.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </SelectInput>
            </Field>
          </div>
          <div
            className={cn("library-step", !medicineFormulation && "disabled")}
          >
            <span>2</span>
            <Field label="Medicine brand / name" required>
              <TextInput
                value={medicineName}
                onChange={(event) => setMedicineName(event.target.value)}
                disabled={!medicineFormulation}
                placeholder="e.g. Augmentin"
              />
            </Field>
          </div>
          <div
            className={cn("library-step", !medicineName.trim() && "disabled")}
          >
            <span>3</span>
            <Field label="Strength" required>
              <SelectInput
                id="library-strength-select"
                value={medicineStrength}
                onChange={(event) => setMedicineStrength(event.target.value)}
                disabled={!medicineName.trim()}
              >
                <option value="">Select strength</option>
                {library.Strengths.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </SelectInput>
            </Field>
          </div>
          <div
            className={cn("library-step", !medicineName.trim() && "disabled")}
          >
            <span>4</span>
            <Field label="Active ingredient (Generic)">
              <TextInput
                value={activeIngredient}
                onChange={(event) => setActiveIngredient(event.target.value)}
                disabled={!medicineName.trim()}
                placeholder="e.g. Amoxicillin + Clavulanate"
              />
            </Field>
          </div>
          <div className="library-medicine-action">
            <Button
              icon={Plus}
              onClick={addMedicine}
              disabled={
                !medicineName.trim() ||
                !medicineFormulation ||
                !medicineStrength
              }
            >
              Add to catalogue
            </Button>
          </div>
        </div>
      ) : (
        <div className="library-add">
          <TextInput
            value={newItem}
            onChange={(event) => setNewItem(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                addItem()
              }
            }}
            placeholder={`Add custom ${category
              .toLowerCase()
              .replace(/s$/, "")}`}
          />
          <Button icon={Plus} onClick={addItem} disabled={!newItem.trim()}>
            Add option
          </Button>
        </div>
      )}
      <div className="library-list">
        {category === "Medicines"
          ? library.MedicineDefinitions.map((item) => (
              <span key={`${item.name}-${item.formulation}-${item.strength}`}>
                <strong>{item.name}</strong>
                <small>
                  {item.formulation} · {item.strength}
                  {item.activeIngredient ? ` · (${item.activeIngredient})` : ""}
                </small>
              </span>
            ))
          : library[category].map((item) => <span key={item}>{item}</span>)}
      </div>
      <div className="info-callout">
        <ShieldCheck size={17} />
        <p>
          Formulary entries assist prescription auto-completion. Prescriptions
          preserve historical snapshots even if catalog entries are modified
          later.
        </p>
      </div>
      <div
        className="info-callout"
        style={{
          marginTop: "12px",
          borderLeftColor: "#0284c7",
          backgroundColor: "#f0f9ff",
          color: "#0369a1",
        }}
      >
        <div>
          <strong style={{ display: "block", marginBottom: "4px" }}>
            Common Drug Codes for India (CDCI) Reference Dataset
          </strong>
          <p style={{ fontSize: "12px", lineHeight: "1.5" }}>
            Reference drug terminology provided under{" "}
            <strong>
              Creative Commons Attribution 4.0 International (CC BY 4.0)
            </strong>{" "}
            by the National Resource Centre for EHR Standards (NRCeS), Centre
            for Development of Advanced Computing (C-DAC) Pune. Includes SNOMED
            CT® International Release terms; authorized territorial use in
            India. Raw master flat files remain strictly outside client
            distributions.
          </p>
        </div>
      </div>
    </section>
  )
}

export default ClinicalLibrarySettings
