import { describe, it, expect } from "vitest"
import {
  isNonAllergyEntry,
  isUnknownAllergyEntry,
  isGenuineAllergyEntry,
  getGenuineAllergies,
  hasGenuineAllergies,
  analyzeAllergies,
} from "./allergy"

describe("Allergy Entry Recognition and Classification", () => {
  describe("Non-Allergy Entries (No Known Allergies)", () => {
    const nonAllergyTerms = [
      "NA",
      "N/A",
      "N.A.",
      "Nil",
      "None",
      "No",
      "Nothing",
      "Not applicable",
      "NKDA",
      "NKA",
      "No known allergies",
      "No known drug allergies",
      "No allergy",
      "No allergies",
      "-",
    ]

    it.each(nonAllergyTerms)(
      "recognizes '%s' as a non-allergy entry",
      (term) => {
        expect(isNonAllergyEntry(term)).toBe(true)
        expect(isGenuineAllergyEntry(term)).toBe(false)
        expect(isUnknownAllergyEntry(term)).toBe(false)
      },
    )

    it("handles case-insensitivity and whitespace variations", () => {
      const variations = [
        "na",
        "n/a",
        "n.a.",
        "N/A",
        "n / a",
        " N / A ",
        "n. a.",
        "nil",
        "NIL",
        "  Nil  ",
        "none",
        "NONE",
        " None. ",
        "no",
        "NO",
        "nothing",
        "NOTHING",
        "not applicable",
        "Not  Applicable",
        "NOT APPLICABLE.",
        "nkda",
        "NKDA",
        "n.k.d.a.",
        "nka",
        "NKA",
        "no known allergies",
        "No  Known  Allergies",
        "NO KNOWN ALLERGIES",
        "no known drug allergies",
        "NO KNOWN DRUG ALLERGIES",
        "no allergy",
        "No Allergy",
        "no allergies",
        "No Allergies",
        "-",
        " - ",
        "—", // em-dash
        "–", // en-dash
      ]

      for (const v of variations) {
        expect(isNonAllergyEntry(v)).toBe(true)
        expect(hasGenuineAllergies([v])).toBe(false)
      }
    })

    it("treats non-allergy entries as No Known Allergies in analysis", () => {
      const res = analyzeAllergies(["None"])
      expect(res.category).toBe("NO_KNOWN_ALLERGIES")
      expect(res.isNoKnownAllergies).toBe(true)
      expect(res.hasGenuineAllergies).toBe(false)
      expect(res.displayLabel).toBe("No known allergies")
      expect(res.alertLabel).toBeNull()
      expect(res.badgeTone).toBe("success")
    })
  })

  describe("Unknown Entries (Unknown, not allergy-free)", () => {
    const unknownTerms = [
      "Not known",
      "Not mentioned",
      "Not specified",
    ]

    it.each(unknownTerms)(
      "recognizes '%s' as an unknown entry and NOT allergy-free",
      (term) => {
        expect(isUnknownAllergyEntry(term)).toBe(true)
        expect(isNonAllergyEntry(term)).toBe(false)
        expect(isGenuineAllergyEntry(term)).toBe(false)
      },
    )

    it("handles case-insensitivity and whitespace variations for unknown entries", () => {
      const variations = [
        "not known",
        "NOT KNOWN",
        " Not  Known ",
        "Not known.",
        "not mentioned",
        "NOT MENTIONED",
        "not specified",
        "NOT SPECIFIED",
        "unknown",
        "Unknown",
      ]

      for (const v of variations) {
        expect(isUnknownAllergyEntry(v)).toBe(true)
        const analysis = analyzeAllergies([v])
        expect(analysis.category).toBe("UNKNOWN")
        expect(analysis.isUnknown).toBe(true)
        expect(analysis.isNoKnownAllergies).toBe(false)
        expect(analysis.hasGenuineAllergies).toBe(false)
        expect(analysis.displayLabel).toBe("Unknown")
        expect(analysis.badgeTone).toBe("warning")
      }
    })
  })

  describe("Genuine Allergy Entries", () => {
    it("keeps genuine allergy names unchanged", () => {
      const allergies = ["Penicillin", "Sulfa Drugs", "Aspirin", "Peanuts"]
      for (const a of allergies) {
        expect(isGenuineAllergyEntry(a)).toBe(true)
        expect(isNonAllergyEntry(a)).toBe(false)
        expect(isUnknownAllergyEntry(a)).toBe(false)
      }

      const genuine = getGenuineAllergies(allergies)
      expect(genuine).toEqual(["Penicillin", "Sulfa Drugs", "Aspirin", "Peanuts"])

      const analysis = analyzeAllergies(allergies)
      expect(analysis.category).toBe("GENUINE")
      expect(analysis.hasGenuineAllergies).toBe(true)
      expect(analysis.genuineAllergies).toEqual([
        "Penicillin",
        "Sulfa Drugs",
        "Aspirin",
        "Peanuts",
      ])
      expect(analysis.displayLabel).toBe("Penicillin, Sulfa Drugs, Aspirin, Peanuts")
      expect(analysis.alertLabel).toBe("Penicillin, Sulfa Drugs, Aspirin, Peanuts")
      expect(analysis.badgeTone).toBe("danger")
    })

    it("filters out non-allergy tokens when combined with genuine allergies", () => {
      const mixed = ["Penicillin", "None", "NKDA"]
      const genuine = getGenuineAllergies(mixed)
      expect(genuine).toEqual(["Penicillin"])

      const analysis = analyzeAllergies(mixed)
      expect(analysis.category).toBe("GENUINE")
      expect(analysis.hasGenuineAllergies).toBe(true)
      expect(analysis.genuineAllergies).toEqual(["Penicillin"])
      expect(analysis.displayLabel).toBe("Penicillin")
    })
  })

  describe("Empty and Default States", () => {
    it("handles empty arrays, undefined, and null gracefully", () => {
      expect(analyzeAllergies([]).category).toBe("NONE_RECORDED")
      expect(analyzeAllergies(null).category).toBe("NONE_RECORDED")
      expect(analyzeAllergies(undefined).category).toBe("NONE_RECORDED")
      expect(analyzeAllergies("").category).toBe("NONE_RECORDED")
      expect(analyzeAllergies("   ").category).toBe("NONE_RECORDED")
    })

    it("parses comma-separated strings correctly", () => {
      const res = analyzeAllergies("Aspirin, Amoxicillin")
      expect(res.genuineAllergies).toEqual(["Aspirin", "Amoxicillin"])

      const nonAllergyRes = analyzeAllergies("NKDA, None")
      expect(nonAllergyRes.category).toBe("NO_KNOWN_ALLERGIES")
    })
  })
})
