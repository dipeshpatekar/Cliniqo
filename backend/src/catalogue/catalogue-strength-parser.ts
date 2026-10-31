export type ReleaseType =
  | 'IMMEDIATE_RELEASE'
  | 'SUSTAINED_RELEASE'
  | 'EXTENDED_RELEASE'
  | 'CONTROLLED_RELEASE'
  | 'MODIFIED_RELEASE'
  | 'PROLONGED_RELEASE'
  | 'DELAYED_RELEASE'
  | 'GASTRO_RESISTANT';

export interface ExtractedStrength {
  ingredient?: string;
  rawStrength: string;
  value?: number;
  unit?: string;
}

export interface StrengthParseResult {
  strengths: ExtractedStrength[];
  isCombination: boolean;
  isVerified: boolean;
  rawSummary: string;
  releaseType: ReleaseType;
}

// Units supported across pharmaceuticals in India
const BASE_UNITS_REGEX =
  /(?:microgram|milliliter|million unit|nanogram|microliter|mcg|mg|kg|ml|iu|miu|ng|ul|g|l|mmol|meq|unit|%)/i;

const EXTENDED_CONTAINER_REGEX =
  /(?:\s*\/\s*(?:\d+(?:\.\d+)?)?\s*(?:microgram|milliliter|nanogram|microliter|mcg|mg|kg|ml|iu|miu|ng|ul|g|l|mmol|meq|puff|actuation|drop|dose|sachet|vial|ampoule)|(?:\s*%\s*(?:w\/v|w\/w|v\/v)?)|(?:\s*(?:w\/v|w\/w|v\/v)))/i;

const STRENGTH_REGEX = new RegExp(
  String.raw`\b((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(` +
    BASE_UNITS_REGEX.source +
    EXTENDED_CONTAINER_REGEX.source +
    String.raw`?)\b`,
  'gi',
);

/**
 * Extracts pharmaceutical release mechanism type from medicine names or dosage forms.
 * Classifies into standard CDCI / pharmacopeial categories:
 * IR, SR, ER, CR, MR, PR, DR, EC/GR.
 */
export function extractReleaseType(name: string): ReleaseType {
  if (!name || typeof name !== 'string') {
    return 'IMMEDIATE_RELEASE';
  }

  const upper = name.toUpperCase();

  // Gastro-resistant / Enteric-coated
  if (
    /GASTRO-RESISTANT/i.test(name) ||
    /ENTERIC[- ]COATED/i.test(name) ||
    /\bEC\b/.test(upper) ||
    /\bGR\b/.test(upper)
  ) {
    return 'GASTRO_RESISTANT';
  }

  // Prolonged-release
  if (/PROLONGED[- ]RELEASE/i.test(name) || /\bPR\b/.test(upper)) {
    return 'PROLONGED_RELEASE';
  }

  // Sustained-release
  if (/SUSTAINED[- ]RELEASE/i.test(name) || /\bSR\b/.test(upper)) {
    return 'SUSTAINED_RELEASE';
  }

  // Extended-release
  if (
    /EXTENDED[- ]RELEASE/i.test(name) ||
    /\bER\b/.test(upper) ||
    /\bXR\b/.test(upper) ||
    /\bXL\b/.test(upper)
  ) {
    return 'EXTENDED_RELEASE';
  }

  // Controlled-release
  if (/CONTROLLED[- ]RELEASE/i.test(name) || /\bCR\b/.test(upper)) {
    return 'CONTROLLED_RELEASE';
  }

  // Modified-release
  if (/MODIFIED[- ]RELEASE/i.test(name) || /\bMR\b/.test(upper)) {
    return 'MODIFIED_RELEASE';
  }

  // Delayed-release
  if (/DELAYED[- ]RELEASE/i.test(name) || /\bDR\b/.test(upper)) {
    return 'DELAYED_RELEASE';
  }

  return 'IMMEDIATE_RELEASE';
}

/**
 * Parses strength information from generic and brand medicine names.
 * Preserves individual ingredient strengths for combination drugs.
 * Flags unverified/ambiguous descriptions without inventing values.
 */
export function extractStrengths(name: string): StrengthParseResult {
  const releaseType = extractReleaseType(name);

  if (!name || typeof name !== 'string') {
    return {
      strengths: [],
      isCombination: false,
      isVerified: false,
      rawSummary: 'Unspecified',
      releaseType,
    };
  }

  const trimmed = name.trim();

  // 1. Check for combination joined by ' + ' (common in BrandMaster)
  if (trimmed.includes(' + ')) {
    const parts = trimmed.split(' + ');
    const extracted: ExtractedStrength[] = [];

    for (const part of parts) {
      const match = part.match(
        new RegExp(
          String.raw`((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(` +
            BASE_UNITS_REGEX.source +
            EXTENDED_CONTAINER_REGEX.source +
            String.raw`?)`,
          'i',
        ),
      );
      if (match) {
        const cleanNumStr = match[1].replace(/,/g, '');
        const value = parseFloat(cleanNumStr);
        const unit = match[2].trim();
        extracted.push({
          rawStrength: `${match[1]} ${unit}`.trim(),
          value: isNaN(value) ? undefined : value,
          unit,
        });
      }
    }

    if (extracted.length > 0) {
      return {
        strengths: extracted,
        isCombination: true,
        isVerified: true,
        rawSummary: extracted.map((s) => s.rawStrength).join(' + '),
        releaseType,
      };
    }
  }

  // 2. Check for multi-ingredient joined by ' and ' (common in GenericMaster)
  if (/\s+and\s+/i.test(trimmed)) {
    const segments = trimmed.split(/\s+and\s+/i);
    const extracted: ExtractedStrength[] = [];

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i].trim();
      const match = seg.match(
        new RegExp(
          String.raw`([A-Za-z\s()-]+?)\s+((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(` +
            BASE_UNITS_REGEX.source +
            EXTENDED_CONTAINER_REGEX.source +
            String.raw`?)\b`,
          'i',
        ),
      );
      if (match) {
        const ingredient = match[1].trim();
        const cleanNumStr = match[2].replace(/,/g, '');
        const value = parseFloat(cleanNumStr);
        const unit = match[3].trim();
        extracted.push({
          ingredient: ingredient.length > 1 ? ingredient : undefined,
          rawStrength: `${match[2]} ${unit}`.trim(),
          value: isNaN(value) ? undefined : value,
          unit,
        });
      } else {
        // Fallback: extract strength number without ingredient prefix
        const fallbackMatch = seg.match(
          new RegExp(
            String.raw`((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(` +
              BASE_UNITS_REGEX.source +
              EXTENDED_CONTAINER_REGEX.source +
              String.raw`?)`,
            'i',
          ),
        );
        if (fallbackMatch) {
          const cleanNumStr = fallbackMatch[1].replace(/,/g, '');
          const val = parseFloat(cleanNumStr);
          const u = fallbackMatch[2].trim();
          extracted.push({
            rawStrength: `${fallbackMatch[1]} ${u}`.trim(),
            value: isNaN(val) ? undefined : val,
            unit: u,
          });
        }
      }
    }

    if (extracted.length > 1) {
      return {
        strengths: extracted,
        isCombination: true,
        isVerified: true,
        rawSummary: extracted.map((s) => s.rawStrength).join(' + '),
        releaseType,
      };
    }
  }

  // 3. Single strength pattern match
  const matches = Array.from(trimmed.matchAll(STRENGTH_REGEX));
  if (matches.length > 0) {
    const extracted: ExtractedStrength[] = matches.map((m) => {
      const cleanNumStr = m[1].replace(/,/g, '');
      const value = parseFloat(cleanNumStr);
      const unit = m[2].trim();
      return {
        rawStrength: `${m[1]} ${unit}`.trim(),
        value: isNaN(value) ? undefined : value,
        unit,
      };
    });

    const isCombination = extracted.length > 1;
    return {
      strengths: extracted,
      isCombination,
      isVerified: true,
      rawSummary: extracted.map((s) => s.rawStrength).join(' + '),
      releaseType,
    };
  }

  // 4. Ambiguous / unverified
  return {
    strengths: [],
    isCombination: false,
    isVerified: false,
    rawSummary: 'Unverified / Not Specified',
    releaseType,
  };
}
