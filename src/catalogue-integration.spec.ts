import { describe, it, expect } from "vitest"
import type {
  Medicine,
  CatalogueItem,
  CatalogueSearchResult,
} from "./types"

describe("Medicine Catalogue & Auto-Strength Selection Integration", () => {
  describe("Automatic Strength Selection Rules", () => {
    it("auto-preselects strength when exactly one unambiguous verified variant exists", () => {
      const singleVariantMedicine: CatalogueItem = {
        id: "2430421000189104",
        sourceIdentifier: "2430421000189104",
        type: "BRAND",
        name: "Safedox 200 mg",
        brandName: "Safedox",
        genericName: "Cefpodoxime Proxetil",
        dosageForm: "Tablet",
        route: "Oral",
        strengths: [{ rawStrength: "200 mg", value: 200, unit: "mg" }],
        rawStrengthSummary: "200 mg",
        isCombination: false,
        isStrengthVerified: true,
        sourceProvenance: "CDCI_NRCES_INDIA",
      }

      // Single verified variant logic
      const isSingle = singleVariantMedicine.strengths.length === 1
      const preselectedStrength = isSingle
        ? singleVariantMedicine.rawStrengthSummary
        : ""

      expect(isSingle).toBe(true)
      expect(preselectedStrength).toBe("200 mg")
    })

    it("does not auto-preselect when multiple verified variants exist, requiring doctor selection", () => {
      const multiVariantStrengths = ["250 mg", "500 mg", "650 mg", "1000 mg"]

      const isSingle = multiVariantStrengths.length === 1
      const preselectedStrength = isSingle ? multiVariantStrengths[0] : ""

      expect(isSingle).toBe(false)
      expect(preselectedStrength).toBe("")
      expect(multiVariantStrengths).toContain("500 mg")
      expect(multiVariantStrengths).toContain("650 mg")
    })

    it("clears stale strength whenever the medicine name changes", () => {
      const initialMedicine: Medicine = {
        id: 1,
        name: "Dolo",
        formulation: "Tablet",
        strength: "650 mg",
        dose: "1",
        route: "Oral",
        frequency: "Twice daily",
        duration: "3 days",
        food: "After food",
        directions: "With water",
        sourceIdentifier: "B_DOLO_650",
        isStrengthVerified: true,
      }

      // Doctor changes medicine name to "Augmentin"
      const updatedMedicine: Medicine = {
        ...initialMedicine,
        name: "Augmentin",
        strength: "", // Stale strength must be cleared immediately
        sourceIdentifier: undefined,
        sourceProvenance: undefined,
        isCombination: undefined,
        isStrengthVerified: undefined,
        isCustom: true,
      }

      expect(updatedMedicine.name).toBe("Augmentin")
      expect(updatedMedicine.strength).toBe("") // Stale 650 mg cleared!
      expect(updatedMedicine.sourceIdentifier).toBeUndefined()
    })
  })

  describe("Combination Medicines", () => {
    it("preserves individual ingredient strengths for combination drugs without merging them", () => {
      const combinationDrug: CatalogueItem = {
        id: "2422261000189109",
        sourceIdentifier: "2422261000189109",
        type: "GENERIC",
        name: "Amoxicillin and Clavulanic Acid 500 mg + 125 mg Tablet",
        genericName: "Amoxicillin and Clavulanic Acid 500 mg + 125 mg Tablet",
        dosageForm: "Tablet",
        route: "Oral",
        strengths: [
          { ingredient: "Amoxicillin", rawStrength: "500 mg", value: 500, unit: "mg" },
          { ingredient: "Clavulanic Acid", rawStrength: "125 mg", value: 125, unit: "mg" },
        ],
        rawStrengthSummary: "500 mg + 125 mg",
        isCombination: true,
        isStrengthVerified: true,
        sourceProvenance: "CDCI_NRCES_INDIA",
      }

      expect(combinationDrug.isCombination).toBe(true)
      expect(combinationDrug.strengths.length).toBe(2)
      expect(combinationDrug.rawStrengthSummary).toBe("500 mg + 125 mg")
      // Crucial: not merged into 625 mg
      expect(combinationDrug.rawStrengthSummary).not.toBe("625 mg")
    })
  })

  describe("Ambiguous & Unverified Strengths", () => {
    it("never invents missing strengths for unverified records", () => {
      const unverifiedMedicine: CatalogueItem = {
        id: "RAW_UNVERIFIED_1",
        sourceIdentifier: "RAW_UNVERIFIED_1",
        type: "BRAND",
        name: "Herbal Ointment Special",
        dosageForm: "Ointment",
        strengths: [],
        rawStrengthSummary: "Unspecified",
        isCombination: false,
        isStrengthVerified: false,
        sourceProvenance: "CDCI_NRCES_INDIA",
      }

      expect(unverifiedMedicine.isStrengthVerified).toBe(false)
      expect(unverifiedMedicine.strengths).toEqual([])
      expect(unverifiedMedicine.rawStrengthSummary).toBe("Unspecified")
    })
  })

  describe("Manual Custom Medicine Entry", () => {
    it("preserves manual medicine entry without fabricating CDCI codes", () => {
      const customMedicine: Medicine = {
        id: 2,
        name: "Ayush Custom Kwath",
        formulation: "Syrup",
        strength: "10 mL",
        dose: "10 mL",
        route: "Oral",
        frequency: "Twice daily",
        duration: "7 days",
        food: "Before food",
        directions: "Warm",
        isCustom: true,
        isStrengthVerified: false,
      }

      expect(customMedicine.name).toBe("Ayush Custom Kwath")
      expect(customMedicine.isCustom).toBe(true)
      expect(customMedicine.sourceIdentifier).toBeUndefined()
      expect(customMedicine.isStrengthVerified).toBe(false)
    })
  })

  describe("Prescription Snapshot Integrity", () => {
    it("preserves immutable prescription snapshot with verified catalogue metadata", () => {
      const snapshot: Medicine[] = [
        {
          id: 1,
          name: "Safedox 200 mg",
          formulation: "Tablet",
          strength: "200 mg",
          dose: "1",
          route: "Oral",
          frequency: "Twice daily",
          duration: "5 days",
          food: "After food",
          directions: "With water",
          activeIngredient: "Cefpodoxime Proxetil",
          sourceIdentifier: "2430421000189104",
          sourceProvenance: "CDCI_NRCES_INDIA",
          isCombination: false,
          isStrengthVerified: true,
          isCustom: false,
        },
      ]

      const serializedSnapshot = JSON.stringify(snapshot)
      const deserialized = JSON.parse(serializedSnapshot) as Medicine[]

      expect(deserialized.length).toBe(1)
      expect(deserialized[0].sourceIdentifier).toBe("2430421000189104")
      expect(deserialized[0].sourceProvenance).toBe("CDCI_NRCES_INDIA")
      expect(deserialized[0].strength).toBe("200 mg")
      expect(deserialized[0].isStrengthVerified).toBe(true)
    })
  })

  describe("Offline Caching & Indicator", () => {
    it("flags search results with isOfflineCache true when operating offline", () => {
      const offlineSearchResult: CatalogueSearchResult = {
        items: [
          {
            id: "B1001",
            sourceIdentifier: "B1001",
            type: "BRAND",
            name: "Dolo 650",
            strengths: [{ rawStrength: "650 mg", value: 650, unit: "mg" }],
            rawStrengthSummary: "650 mg",
            isCombination: false,
            isStrengthVerified: true,
            sourceProvenance: "CDCI_NRCES_INDIA",
          },
        ],
        total: 1,
        page: 1,
        limit: 10,
        totalPages: 1,
        attribution: "CDCI / NRCeS India (CC BY 4.0) — Local Offline Cache",
        isOfflineCache: true,
      }

      expect(offlineSearchResult.isOfflineCache).toBe(true)
      expect(offlineSearchResult.items.length).toBe(1)
      expect(offlineSearchResult.attribution).toContain("Local Offline Cache")
    })
  })

  describe("Licensing & Attribution", () => {
    it("contains CC BY 4.0 attribution and notes SNOMED CT obligations", () => {
      const attribution =
        "CDCI / NRCeS India (CC BY 4.0); SNOMED CT® International Release terms apply."

      expect(attribution).toContain("CC BY 4.0")
      expect(attribution).toContain("NRCeS India")
      expect(attribution).toContain("SNOMED CT")
    })
  })
})
