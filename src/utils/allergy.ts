/**
 * Allergy entry normalization and classification utility for Cliniqo.
 *
 * Distinguishes between:
 * 1. Genuine allergies (e.g. "Penicillin", "Sulfa Drugs", "Aspirin") - preserved exactly as entered.
 * 2. Non-allergy entries (e.g. "NA", "N/A", "Nil", "None", "NKDA", "No known allergies", "-") - treated as No Known Allergies.
 * 3. Unknown entries (e.g. "Not known", "Not mentioned", "Not specified") - treated as Unknown (not allergy-free).
 */

export const NON_ALLERGY_TERMS = [
  "na",
  "n/a",
  "n.a.",
  "n.a",
  "nil",
  "none",
  "no",
  "nothing",
  "not applicable",
  "not-applicable",
  "nkda",
  "n.k.d.a.",
  "n.k.d.a",
  "nka",
  "n.k.a.",
  "n.k.a",
  "no known allergies",
  "no known drug allergies",
  "no allergy",
  "no allergies",
  "-",
  "–",
  "—",
] as const

export const UNKNOWN_ALLERGY_TERMS = [
  "not known",
  "not mentioned",
  "not specified",
  "unknown",
  "unspecified",
  "not recorded",
] as const

const NON_ALLERGY_SET = new Set<string>(NON_ALLERGY_TERMS)
const UNKNOWN_ALLERGY_SET = new Set<string>(UNKNOWN_ALLERGY_TERMS)

/**
 * Normalizes an allergy token for case-insensitive, whitespace-tolerant comparison.
 */
export function normalizeAllergyToken(token: string): string {
  if (!token) return ""
  return token
    .trim()
    .toLowerCase()
    .replace(/[\u2013\u2014]/g, "-") // en-dash, em-dash -> hyphen
    .replace(/\s*\/\s*/g, "/") // "n / a" -> "n/a"
    .replace(/\s*\.\s*/g, ".") // "n. a." -> "n.a."
    .replace(/\s+/g, " ") // multi-space -> single space
}

/**
 * Checks whether an entry is a recognized non-allergy entry (representing No Known Allergies).
 */
export function isNonAllergyEntry(entry: string): boolean {
  if (!entry) return false
  const norm = normalizeAllergyToken(entry)
  if (!norm) return false

  if (NON_ALLERGY_SET.has(norm)) return true

  // Strip trailing period if not already part of an abbreviation like "n.a."
  if (norm.endsWith(".") && !norm.endsWith("..") && norm !== "n.a." && norm !== "n.k.d.a." && norm !== "n.k.a.") {
    const stripped = norm.replace(/\.+$/, "").trim()
    if (NON_ALLERGY_SET.has(stripped)) return true
  }

  return false
}

/**
 * Checks whether an entry is a recognized unknown entry (representing Unknown, not allergy-free).
 */
export function isUnknownAllergyEntry(entry: string): boolean {
  if (!entry) return false
  const norm = normalizeAllergyToken(entry)
  if (!norm) return false

  if (UNKNOWN_ALLERGY_SET.has(norm)) return true

  if (norm.endsWith(".")) {
    const stripped = norm.replace(/\.+$/, "").trim()
    if (UNKNOWN_ALLERGY_SET.has(stripped)) return true
  }

  return false
}

/**
 * Checks whether an entry represents a genuine allergy name.
 */
export function isGenuineAllergyEntry(entry: string): boolean {
  if (!entry || !entry.trim()) return false
  return !isNonAllergyEntry(entry) && !isUnknownAllergyEntry(entry)
}

/**
 * Filters a list of allergy strings to return only genuine allergy entries (names unchanged).
 */
export function getGenuineAllergies(
  entries?: string[] | string | null,
): string[] {
  const list = parseAllergyEntries(entries)
  return list.filter((item) => isGenuineAllergyEntry(item))
}

/**
 * Checks if a patient or consultation has any genuine allergy records.
 */
export function hasGenuineAllergies(
  entries?: string[] | string | null,
): boolean {
  return getGenuineAllergies(entries).length > 0
}

/**
 * Helper to normalize raw allergy input (array or comma-delimited string) into an array of trimmed entries.
 */
export function parseAllergyEntries(
  entries?: string[] | string | null,
): string[] {
  if (!entries) return []
  if (Array.isArray(entries)) {
    return entries.flatMap((item) =>
      typeof item === "string"
        ? item
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    )
  }
  if (typeof entries === "string") {
    return entries
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return []
}

export type AllergyCategory =
  | "GENUINE"
  | "NO_KNOWN_ALLERGIES"
  | "UNKNOWN"
  | "NONE_RECORDED"

export interface AllergyAnalysis {
  category: AllergyCategory
  genuineAllergies: string[]
  hasGenuineAllergies: boolean
  isNoKnownAllergies: boolean
  isUnknown: boolean
  displayLabel: string
  alertLabel: string | null
  badgeTone: "danger" | "success" | "neutral" | "warning"
}

/**
 * Comprehensive analysis of a patient's allergy records or consultation allergy field.
 */
export function analyzeAllergies(
  entries?: string[] | string | null,
): AllergyAnalysis {
  const list = parseAllergyEntries(entries)

  if (list.length === 0) {
    return {
      category: "NONE_RECORDED",
      genuineAllergies: [],
      hasGenuineAllergies: false,
      isNoKnownAllergies: false,
      isUnknown: false,
      displayLabel: "None recorded",
      alertLabel: null,
      badgeTone: "neutral",
    }
  }

  const genuine = list.filter((item) => isGenuineAllergyEntry(item))
  if (genuine.length > 0) {
    const label = genuine.join(", ")
    return {
      category: "GENUINE",
      genuineAllergies: genuine,
      hasGenuineAllergies: true,
      isNoKnownAllergies: false,
      isUnknown: false,
      displayLabel: label,
      alertLabel: label,
      badgeTone: "danger",
    }
  }

  // If there are unknown entries (and no genuine allergies), treat as Unknown
  const hasUnknown = list.some((item) => isUnknownAllergyEntry(item))
  if (hasUnknown) {
    return {
      category: "UNKNOWN",
      genuineAllergies: [],
      hasGenuineAllergies: false,
      isNoKnownAllergies: false,
      isUnknown: true,
      displayLabel: "Unknown",
      alertLabel: null,
      badgeTone: "warning",
    }
  }

  // All entries are non-allergy entries
  return {
    category: "NO_KNOWN_ALLERGIES",
    genuineAllergies: [],
    hasGenuineAllergies: false,
    isNoKnownAllergies: true,
    isUnknown: false,
    displayLabel: "No known allergies",
    alertLabel: null,
    badgeTone: "success",
  }
}
