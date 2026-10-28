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
}

// Units supported across pharmaceuticals in India
const UNITS_REGEX =
  /(?:microgram|milliliter|million unit|nanogram|microliter|mcg|mg|kg|ml|iu|miu|ng|ul|g|l|%|mmol|meq|unit|w\/w|w\/v|v\/v)/i;

const STRENGTH_REGEX = new RegExp(
  String.raw`\b(\d+(?:\.\d+)?)\s*(` +
    UNITS_REGEX.source +
    String.raw`(?:\s*\/\s*(?:\d+(?:\.\d+)?)?\s*` +
    UNITS_REGEX.source +
    String.raw`|\/vial|\/dose|\/ampoule|\/actuation|\/drop|\/sachet)?)\b`,
  'gi',
);

/**
 * Parses strength information from generic and brand medicine names.
 * Preserves individual ingredient strengths for combination drugs.
 * Flags unverified/ambiguous descriptions without inventing values.
 */
export function extractStrengths(name: string): StrengthParseResult {
  if (!name || typeof name !== 'string') {
    return {
      strengths: [],
      isCombination: false,
      isVerified: false,
      rawSummary: 'Unspecified',
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
          String.raw`(\d+(?:\.\d+)?)\s*(` +
            UNITS_REGEX.source +
            String.raw`(?:\s*\/\s*(?:\d+(?:\.\d+)?)?\s*` +
            UNITS_REGEX.source +
            String.raw`|\/vial|\/dose|\/ampoule|\/actuation|\/drop|\/sachet)?)`,
          'i',
        ),
      );
      if (match) {
        const value = parseFloat(match[1]);
        const unit = match[2].trim();
        extracted.push({
          rawStrength: `${match[1]} ${unit}`,
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
          String.raw`([A-Za-z\s()-]+?)\s+(\d+(?:\.\d+)?)\s*(` +
            UNITS_REGEX.source +
            String.raw`(?:\s*\/\s*(?:\d+(?:\.\d+)?)?\s*` +
            UNITS_REGEX.source +
            String.raw`|\/vial|\/dose|\/ampoule|\/actuation|\/drop|\/sachet)?)\b`,
          'i',
        ),
      );
      if (match) {
        const ingredient = match[1].trim();
        const value = parseFloat(match[2]);
        const unit = match[3].trim();
        extracted.push({
          ingredient: ingredient.length > 1 ? ingredient : undefined,
          rawStrength: `${match[2]} ${unit}`,
          value: isNaN(value) ? undefined : value,
          unit,
        });
      } else {
        // Fallback: extract strength number without ingredient prefix
        const fallbackMatch = seg.match(
          new RegExp(
            String.raw`(\d+(?:\.\d+)?)\s*(` +
              UNITS_REGEX.source +
              String.raw`(?:\s*\/\s*(?:\d+(?:\.\d+)?)?\s*` +
              UNITS_REGEX.source +
              String.raw`|\/vial|\/dose|\/ampoule|\/actuation|\/drop|\/sachet)?)`,
            'i',
          ),
        );
        if (fallbackMatch) {
          const val = parseFloat(fallbackMatch[1]);
          const u = fallbackMatch[2].trim();
          extracted.push({
            rawStrength: `${fallbackMatch[1]} ${u}`,
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
      };
    }
  }

  // 3. Single strength pattern match
  const matches = Array.from(trimmed.matchAll(STRENGTH_REGEX));
  if (matches.length > 0) {
    const extracted: ExtractedStrength[] = matches.map((m) => {
      const value = parseFloat(m[1]);
      const unit = m[2].trim();
      return {
        rawStrength: `${m[1]} ${unit}`,
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
    };
  }

  // 4. Ambiguous / unverified
  return {
    strengths: [],
    isCombination: false,
    isVerified: false,
    rawSummary: 'Unverified / Not Specified',
  };
}
