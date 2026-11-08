import { describe, it, expect } from "vitest"
import {
  SHORTCUT_DEFINITIONS,
  FREQUENCY_NUMERIC_MAP,
  FORMULATION_SHORTCUTS,
  FORMULATION_LETTER_MAP,
  type ShortcutItem,
} from "./keyboardShortcuts"
import { defaultClinicalLibrary, loadClinicalLibrary } from "../types"

describe("Keyboard Shortcuts Registry & Specifications", () => {
  it("defines all required global shortcuts", () => {
    const globalShortcuts = SHORTCUT_DEFINITIONS.filter(
      (s) => s.category === "Global",
    )
    const displayKeys = globalShortcuts.map((s) => s.displayKeys)

    expect(displayKeys).toContain("Ctrl + K")
    expect(displayKeys).toContain("Ctrl + S")
    expect(displayKeys).toContain("Ctrl + P")
    expect(displayKeys).toContain("Ctrl + /")
    expect(displayKeys).toContain("Esc")
    expect(displayKeys).toContain("Alt + 1–8")
    expect(displayKeys).toContain("Ctrl + N")
    expect(displayKeys).toContain("Ctrl + E")
  })

  it("defines all required consultation and prescription shortcuts", () => {
    const rxShortcuts = SHORTCUT_DEFINITIONS.filter(
      (s) => s.category === "Consultation & Prescription",
    )
    const displayKeys = rxShortcuts.map((s) => s.displayKeys)

    expect(displayKeys).toContain("Ctrl + Shift + C")
    expect(displayKeys).toContain("Ctrl + Shift + M")
    expect(displayKeys).toContain("Ctrl + Shift + V")
    expect(displayKeys).toContain("Ctrl + Shift + D")
    expect(displayKeys).toContain("Ctrl + Shift + A")
    expect(displayKeys).toContain("Ctrl + F")
    expect(displayKeys).toContain("Ctrl + ↑ / ↓")
  })

  it("defines all required billing and medicine library shortcuts", () => {
    const billingShortcuts = SHORTCUT_DEFINITIONS.filter(
      (s) => s.category === "Billing & Medicine Library",
    )
    const displayKeys = billingShortcuts.map((s) => s.displayKeys)

    expect(displayKeys).toContain("Ctrl + Shift + B")
    expect(displayKeys).toContain("Ctrl + Shift + I")
    expect(displayKeys).toContain("Ctrl + Shift + L")
  })

  it("contains unique shortcut IDs without duplicate keys in the same context", () => {
    const ids = SHORTCUT_DEFINITIONS.map((s) => s.id)
    const uniqueIds = new Set(ids)
    expect(uniqueIds.size).toBe(ids.length)

    // Check display keys uniqueness across global and scoped categories
    const keys = SHORTCUT_DEFINITIONS.map((s) => s.displayKeys)
    const uniqueKeys = new Set(keys)
    expect(uniqueKeys.size).toBe(keys.length)
  })

  it("correctly maps frequency numbers 1 to 5 to clinical daily frequencies", () => {
    expect(FREQUENCY_NUMERIC_MAP["1"]).toBe("Once daily")
    expect(FREQUENCY_NUMERIC_MAP["2"]).toBe("Twice daily")
    expect(FREQUENCY_NUMERIC_MAP["3"]).toBe("Three times daily")
    expect(FREQUENCY_NUMERIC_MAP["4"]).toBe("Four times daily")
    expect(FREQUENCY_NUMERIC_MAP["5"]).toBe("As needed")
  })

  it("audits and defines all 16 formulations with their exact assigned letter shortcuts", () => {
    const expectedFormulations = [
      { name: "Tablet", letter: "T", key: "t" },
      { name: "Capsule", letter: "C", key: "c" },
      { name: "Syrup", letter: "S", key: "s" },
      { name: "Drops", letter: "D", key: "d" },
      { name: "Injection", letter: "I", key: "i" },
      { name: "Ointment", letter: "O", key: "o" },
      { name: "Cream", letter: "R", key: "r" },
      { name: "Gel", letter: "G", key: "g" },
      { name: "Powder", letter: "P", key: "p" },
      { name: "Lotion", letter: "L", key: "l" },
      { name: "Suspension", letter: "N", key: "n" },
      { name: "Mouthwash", letter: "M", key: "m" },
      { name: "Inhaler", letter: "H", key: "h" },
      { name: "Eye Drops", letter: "E", key: "e" },
      { name: "Ear Drops", letter: "U", key: "u" },
      { name: "Suppository", letter: "B", key: "b" },
    ]

    // 1. Verify defaultClinicalLibrary contains all 16 formulations
    for (const item of expectedFormulations) {
      expect(defaultClinicalLibrary.Formulations).toContain(item.name)
    }
    expect(defaultClinicalLibrary.Formulations.length).toBe(16)

    // 2. Verify FORMULATION_SHORTCUTS mapping (case-insensitive letter key to formulation name)
    for (const item of expectedFormulations) {
      expect(FORMULATION_SHORTCUTS[item.key]).toBe(item.name)
      expect(FORMULATION_LETTER_MAP[item.name]).toBe(item.letter)
    }

    // 3. Verify uniqueness of letter shortcuts
    const letters = expectedFormulations.map((f) => f.letter)
    const uniqueLetters = new Set(letters)
    expect(uniqueLetters.size).toBe(16)
  })

  it("loadClinicalLibrary merges missing default formulations into existing saved library", () => {
    const loaded = loadClinicalLibrary()
    expect(loaded.Formulations).toContain("Gel")
    expect(loaded.Formulations).toContain("Powder")
    expect(loaded.Formulations).toContain("Lotion")
    expect(loaded.Formulations).toContain("Mouthwash")
    expect(loaded.Formulations).toContain("Eye Drops")
    expect(loaded.Formulations).toContain("Ear Drops")
    expect(loaded.Formulations).toContain("Suppository")
  })
})
