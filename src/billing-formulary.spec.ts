import { describe, expect, it } from "vitest"
import { computeBillTotals, validateMedicineFormulation } from "./App"

describe("computeBillTotals", () => {
  it("computes subtotal, tax, and total accurately in minor units", () => {
    const items = [
      { quantity: 2, rate: 250 }, // 500.00 => 50000 paise
      { quantity: 1, rate: 100 }, // 100.00 => 10000 paise
    ]
    const totals = computeBillTotals(items, 50, 18) // Discount 50.00 => 5000 paise, Taxable 55000 paise, 18% tax => 9900 paise

    expect(totals.subtotalPaise).toBe(60000)
    expect(totals.discountPaise).toBe(5000)
    expect(totals.taxRatePercent).toBe(18)
    expect(totals.taxPaise).toBe(9900)
    expect(totals.totalPaise).toBe(64900)

    expect(totals.subtotalRupees).toBe(600)
    expect(totals.discountRupees).toBe(50)
    expect(totals.taxRupees).toBe(99)
    expect(totals.totalRupees).toBe(649)
  })

  it("handles empty item list", () => {
    const totals = computeBillTotals([], 0, 0)
    expect(totals.subtotalPaise).toBe(0)
    expect(totals.discountPaise).toBe(0)
    expect(totals.taxPaise).toBe(0)
    expect(totals.totalPaise).toBe(0)
  })

  it("clamps discount so it cannot exceed subtotal", () => {
    const items = [{ quantity: 1, rate: 100 }] // 10000 paise
    const totals = computeBillTotals(items, 500, 0) // Discount 500 > 100

    expect(totals.subtotalPaise).toBe(10000)
    expect(totals.discountPaise).toBe(10000)
    expect(totals.totalPaise).toBe(0)
  })

  it("handles negative discount safely by treating as zero", () => {
    const items = [{ quantity: 1, rate: 100 }]
    const totals = computeBillTotals(items, -50, 0)

    expect(totals.discountPaise).toBe(0)
    expect(totals.totalPaise).toBe(10000)
  })

  it("handles standard GST tax rates (0%, 5%, 12%, 18%) with round-half-up integer minor unit rounding", () => {
    const items = [{ quantity: 1, rate: 105.5 }] // 10550 paise

    // 0%
    const zero = computeBillTotals(items, 0, 0)
    expect(zero.taxPaise).toBe(0)
    expect(zero.totalPaise).toBe(10550)

    // 5%: 10550 * 0.05 = 527.5 => rounds to 528
    const five = computeBillTotals(items, 0, 5)
    expect(five.taxPaise).toBe(528)
    expect(five.totalPaise).toBe(11078)

    // 12%: 10550 * 0.12 = 1266
    const twelve = computeBillTotals(items, 0, 12)
    expect(twelve.taxPaise).toBe(1266)
    expect(twelve.totalPaise).toBe(11816)

    // 18%: 10550 * 0.18 = 1899
    const eighteen = computeBillTotals(items, 0, 18)
    expect(eighteen.taxPaise).toBe(1899)
    expect(eighteen.totalPaise).toBe(12449)
  })

  it("clamps tax rate between 0% and 100%", () => {
    const items = [{ quantity: 1, rate: 100 }]
    const negativeTax = computeBillTotals(items, 0, -10)
    expect(negativeTax.taxRatePercent).toBe(0)

    const excessiveTax = computeBillTotals(items, 0, 150)
    expect(excessiveTax.taxRatePercent).toBe(100)
  })
})

describe("validateMedicineFormulation", () => {
  it("fails if formulation is missing", () => {
    const res = validateMedicineFormulation({ name: "Paracetamol" })
    expect(res.valid).toBe(false)
    expect(res.error).toMatch(/Formulation is required/i)
  })

  it("fails if medicine name is missing", () => {
    const res = validateMedicineFormulation({ formulation: "Tablet" })
    expect(res.valid).toBe(false)
    expect(res.error).toMatch(/Medicine name is required/i)
  })

  describe("Tablets / Capsules / Syrups", () => {
    it("validates when dose, frequency, and duration are provided", () => {
      const res = validateMedicineFormulation({
        name: "Amoxicillin",
        formulation: "Capsule",
        dose: "500 mg",
        frequency: "1-0-1",
        duration: "5 days",
      })
      expect(res.valid).toBe(true)
      expect(res.error).toBeUndefined()
    })

    it("fails when dose is missing", () => {
      const res = validateMedicineFormulation({
        name: "Amoxicillin",
        formulation: "Capsule",
        frequency: "1-0-1",
        duration: "5 days",
      })
      expect(res.valid).toBe(false)
      expect(res.error).toMatch(/Dose required/i)
    })

    it("fails when frequency is missing", () => {
      const res = validateMedicineFormulation({
        name: "Amoxicillin",
        formulation: "Capsule",
        dose: "500 mg",
        duration: "5 days",
      })
      expect(res.valid).toBe(false)
      expect(res.error).toMatch(/Frequency required/i)
    })

    it("fails when duration is missing", () => {
      const res = validateMedicineFormulation({
        name: "Amoxicillin",
        formulation: "Capsule",
        dose: "500 mg",
        frequency: "1-0-1",
      })
      expect(res.valid).toBe(false)
      expect(res.error).toMatch(/Duration required/i)
    })
  })

  describe("Injections", () => {
    it("validates when route and dose are provided", () => {
      const res = validateMedicineFormulation({
        name: "Ceftriaxone",
        formulation: "Injection",
        route: "IV",
        dose: "1 g",
      })
      expect(res.valid).toBe(true)
      expect(res.error).toBeUndefined()
    })

    it("fails when route is missing", () => {
      const res = validateMedicineFormulation({
        name: "Ceftriaxone",
        formulation: "Injection",
        dose: "1 g",
      })
      expect(res.valid).toBe(false)
      expect(res.error).toMatch(/Route .* required/i)
    })

    it("fails when dose is missing", () => {
      const res = validateMedicineFormulation({
        name: "Ceftriaxone",
        formulation: "Injection",
        route: "IV",
      })
      expect(res.valid).toBe(false)
      expect(res.error).toMatch(/Dose required/i)
    })
  })

  describe("Topical Formulations (Creams, Ointments, Gels)", () => {
    it("validates when directions, frequency, and duration are provided", () => {
      const res = validateMedicineFormulation({
        name: "Betamethasone",
        formulation: "Cream",
        directions: "Apply thin layer to affected area",
        frequency: "Twice daily",
        duration: "7 days",
      })
      expect(res.valid).toBe(true)
      expect(res.error).toBeUndefined()
    })

    it("fails when application instructions/directions are missing", () => {
      const res = validateMedicineFormulation({
        name: "Betamethasone",
        formulation: "Cream",
        frequency: "Twice daily",
        duration: "7 days",
      })
      expect(res.valid).toBe(false)
      expect(res.error).toMatch(/Application instructions required/i)
    })

    it("fails when frequency is missing", () => {
      const res = validateMedicineFormulation({
        name: "Betamethasone",
        formulation: "Ointment",
        directions: "Apply on clean skin",
        duration: "7 days",
      })
      expect(res.valid).toBe(false)
      expect(res.error).toMatch(/Frequency required/i)
    })
  })

  describe("Drops and Inhalers", () => {
    it("validates eye/ear drops", () => {
      const res = validateMedicineFormulation({
        name: "Ciprofloxacin Eye Drops",
        formulation: "Drops",
        dose: "2 drops each eye",
        frequency: "TDS",
        duration: "5 days",
      })
      expect(res.valid).toBe(true)
    })

    it("fails eye drops when dose is missing", () => {
      const res = validateMedicineFormulation({
        name: "Ciprofloxacin Eye Drops",
        formulation: "Drops",
        frequency: "TDS",
        duration: "5 days",
      })
      expect(res.valid).toBe(false)
      expect(res.error).toMatch(/Dose \(drops\) required/i)
    })

    it("validates inhaler puffs", () => {
      const res = validateMedicineFormulation({
        name: "Salbutamol Inhaler",
        formulation: "Inhaler",
        dose: "2 puffs",
        frequency: "SOS",
        duration: "As needed",
      })
      expect(res.valid).toBe(true)
    })
  })
})
