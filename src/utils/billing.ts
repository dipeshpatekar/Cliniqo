import type { Medicine } from "../types"

export function computeBillTotals(
  items: Array<{ quantity: number; rate: number }>,
  discountRupees: number = 0,
  taxRatePercent: number = 0,
) {
  const subtotalPaise = items.reduce((sum, item) => {
    const qty = Math.max(1, Math.floor(Number(item.quantity) || 1))
    const ratePaise = Math.max(0, Math.round((Number(item.rate) || 0) * 100))
    return sum + qty * ratePaise
  }, 0)

  const rawDiscountPaise = Math.max(
    0,
    Math.round((Number(discountRupees) || 0) * 100),
  )
  const discountPaise = Math.min(subtotalPaise, rawDiscountPaise)
  const taxablePaise = subtotalPaise - discountPaise
  const ratePct = Math.max(0, Math.min(100, Number(taxRatePercent) || 0))
  const taxPaise = Math.round((taxablePaise * ratePct) / 100)
  const totalPaise = taxablePaise + taxPaise

  return {
    subtotalPaise,
    discountPaise,
    taxRatePercent: ratePct,
    taxPaise,
    totalPaise,
    subtotalRupees: subtotalPaise / 100,
    discountRupees: discountPaise / 100,
    taxRupees: taxPaise / 100,
    totalRupees: totalPaise / 100,
  }
}

export function validateMedicineFormulation(
  med: Partial<Medicine>,
): { valid: boolean; error?: string } {
  if (!med.formulation) {
    return { valid: false, error: "Formulation is required" }
  }
  if (!med.name || !med.name.trim()) {
    return { valid: false, error: "Medicine name is required" }
  }

  const f = med.formulation.toLowerCase()

  if (f.includes("injection")) {
    if (!med.route || !med.route.trim()) {
      return {
        valid: false,
        error: "Route (IV, IM, SC, ID) required for injection",
      }
    }
    if (!med.dose || !med.dose.trim()) {
      return { valid: false, error: "Dose required for injection" }
    }
  } else if (
    f.includes("cream") ||
    f.includes("ointment") ||
    f.includes("gel") ||
    f.includes("lotion") ||
    f.includes("topical")
  ) {
    if (!med.directions || !med.directions.trim()) {
      return {
        valid: false,
        error: "Application instructions required for topical",
      }
    }
    if (!med.frequency || !med.frequency.trim()) {
      return { valid: false, error: "Frequency required for topical" }
    }
    if (!med.duration || !med.duration.trim()) {
      return { valid: false, error: "Duration required for topical" }
    }
  } else if (f.includes("drop")) {
    if (!med.dose || !med.dose.trim()) {
      return { valid: false, error: "Dose (drops) required" }
    }
    if (!med.frequency || !med.frequency.trim()) {
      return { valid: false, error: "Frequency required" }
    }
    if (!med.duration || !med.duration.trim()) {
      return { valid: false, error: "Duration required" }
    }
  } else if (f.includes("inhaler")) {
    if (!med.dose || !med.dose.trim()) {
      return { valid: false, error: "Dose (puffs) required" }
    }
    if (!med.frequency || !med.frequency.trim()) {
      return { valid: false, error: "Frequency required" }
    }
    if (!med.duration || !med.duration.trim()) {
      return { valid: false, error: "Duration required" }
    }
  } else {
    // Tablets, Capsules, Syrups, Suspensions
    if (!med.dose || !med.dose.trim()) {
      return { valid: false, error: "Dose required" }
    }
    if (!med.frequency || !med.frequency.trim()) {
      return { valid: false, error: "Frequency required" }
    }
    if (!med.duration || !med.duration.trim()) {
      return { valid: false, error: "Duration required" }
    }
  }

  return { valid: true }
}
