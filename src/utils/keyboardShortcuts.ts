export type ShortcutCategory =
  | "Global"
  | "Consultation & Prescription"
  | "Billing & Medicine Library"

export interface ShortcutItem {
  id: string
  keys: string[]
  displayKeys: string
  label: string
  description: string
  category: ShortcutCategory
  context?: string
}

export const SHORTCUT_DEFINITIONS: ShortcutItem[] = [
  // Global
  {
    id: "patient-search",
    keys: ["ctrl", "k"],
    displayKeys: "Ctrl + K",
    label: "Global patient search",
    description: "Search patients by name, ID, or phone number from anywhere",
    category: "Global",
  },
  {
    id: "save-draft",
    keys: ["ctrl", "s"],
    displayKeys: "Ctrl + S",
    label: "Save current draft",
    description: "Save active consultation, invoice, or form draft",
    category: "Global",
  },
  {
    id: "print",
    keys: ["ctrl", "p"],
    displayKeys: "Ctrl + P",
    label: "Print current prescription/bill",
    description: "Print or preview the current prescription or invoice",
    category: "Global",
  },
  {
    id: "shortcut-guide",
    keys: ["ctrl", "/"],
    displayKeys: "Ctrl + /",
    label: "Show shortcut reference",
    description: "Open this searchable keyboard shortcut guide",
    category: "Global",
  },
  {
    id: "escape",
    keys: ["escape"],
    displayKeys: "Esc",
    label: "Close modal/dropdown",
    description: "Dismiss open dialogs, dropdowns, and overlays",
    category: "Global",
  },
  {
    id: "navigate-sections",
    keys: ["alt", "1-8"],
    displayKeys: "Alt + 1–8",
    label: "Navigate main sections",
    description:
      "1: Dashboard, 2: Patients, 3: Consultation, 4: Billing, 5: Medicine Library, 6: Settings, 7: Patient Profile, 8: Add Patient",
    category: "Global",
  },
  {
    id: "add-patient",
    keys: ["ctrl", "n"],
    displayKeys: "Ctrl + N",
    label: "Add patient",
    description: "Open the patient registration form",
    category: "Global",
  },
  {
    id: "edit-patient",
    keys: ["ctrl", "e"],
    displayKeys: "Ctrl + E",
    label: "Edit selected patient",
    description: "Edit the currently selected patient's demographic details",
    category: "Global",
  },

  // Consultation & Prescription
  {
    id: "start-consultation",
    keys: ["ctrl", "shift", "c"],
    displayKeys: "Ctrl + Shift + C",
    label: "Save & start consultation",
    description:
      "Save patient form and start consultation, or start consultation from patient profile",
    category: "Consultation & Prescription",
    context: "Add Patient & Patient Profile",
  },
  {
    id: "add-medicine",
    keys: ["ctrl", "shift", "m"],
    displayKeys: "Ctrl + Shift + M",
    label: "Add medicine",
    description: "Add a new medication row and focus formulation",
    category: "Consultation & Prescription",
    context: "Consultation",
  },
  {
    id: "formulation-quick-select",
    keys: ["t", "c", "s", "d", "i", "o", "r", "g", "p", "l", "n", "m", "h", "e", "u", "b"],
    displayKeys: "T / C / S / D / I / O / R / G / P / L / N / M / H / E / U / B",
    label: "Formulation quick-select letters",
    description:
      "When formulation dropdown is focused: T: Tablet, C: Capsule, S: Syrup, D: Drops, I: Injection, O: Ointment, R: Cream, G: Gel, P: Powder, L: Lotion, N: Suspension, M: Mouthwash, H: Inhaler, E: Eye Drops, U: Ear Drops, B: Suppository",
    category: "Consultation & Prescription",
    context: "Consultation",
  },
  {
    id: "focus-vitals",
    keys: ["ctrl", "shift", "v"],
    displayKeys: "Ctrl + Shift + V",
    label: "Focus vitals",
    description: "Focus the vitals entry section",
    category: "Consultation & Prescription",
    context: "Consultation",
  },
  {
    id: "focus-diagnosis",
    keys: ["ctrl", "shift", "d"],
    displayKeys: "Ctrl + Shift + D",
    label: "Focus diagnosis",
    description: "Focus the diagnosis search input",
    category: "Consultation & Prescription",
    context: "Consultation",
  },
  {
    id: "focus-advice",
    keys: ["ctrl", "shift", "a"],
    displayKeys: "Ctrl + Shift + A",
    label: "Focus advice",
    description: "Focus the advice and clinical notes input",
    category: "Consultation & Prescription",
    context: "Consultation",
  },
  {
    id: "finalize-prescription",
    keys: ["ctrl", "f"],
    displayKeys: "Ctrl + F",
    label: "Finalize prescription",
    description: "Open the prescription finalization confirmation modal",
    category: "Consultation & Prescription",
    context: "Consultation",
  },
  {
    id: "navigate-medicine-rows",
    keys: ["ctrl", "up/down"],
    displayKeys: "Ctrl + ↑ / ↓",
    label: "Navigate medicine rows",
    description: "Move focus between medication rows in the prescription list",
    category: "Consultation & Prescription",
    context: "Consultation",
  },

  // Billing & Medicine Library
  {
    id: "open-billing",
    keys: ["ctrl", "shift", "b"],
    displayKeys: "Ctrl + Shift + B",
    label: "Open billing",
    description: "Open the billing and invoice creation interface",
    category: "Billing & Medicine Library",
  },
  {
    id: "add-bill-item",
    keys: ["ctrl", "shift", "i"],
    displayKeys: "Ctrl + Shift + I",
    label: "Add bill item",
    description: "Add a new line item in the billing invoice",
    category: "Billing & Medicine Library",
    context: "Billing",
  },
  {
    id: "open-medicine-library",
    keys: ["ctrl", "shift", "l"],
    displayKeys: "Ctrl + Shift + L",
    label: "Open Medicine Library",
    description: "Open the Medicine Library and clinical catalog settings",
    category: "Billing & Medicine Library",
  },
]

export const FREQUENCY_NUMERIC_MAP: Record<string, string> = {
  "1": "Once daily",
  "2": "Twice daily",
  "3": "Three times daily",
  "4": "Four times daily",
  "5": "As needed",
}

export { FORMULATION_SHORTCUTS, FORMULATION_LETTER_MAP } from "../types"

/**
 * Dispatches a custom Cliniqo shortcut action event.
 */
export function dispatchShortcutEvent(action: string, detail: any = {}) {
  const event = new CustomEvent("cliniqo-shortcut", {
    detail: { action, ...detail },
  })
  window.dispatchEvent(event)
}
