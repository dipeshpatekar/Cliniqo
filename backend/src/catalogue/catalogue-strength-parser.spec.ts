import { describe, it, expect } from 'vitest';
import { extractStrengths } from './catalogue-strength-parser.js';

describe('CatalogueStrengthParser', () => {
  describe('Single-ingredient strengths', () => {
    it('extracts standard milligram tablet strengths', () => {
      const res = extractStrengths('Carbimazole 5 mg oral tablet');
      expect(res.isVerified).toBe(true);
      expect(res.isCombination).toBe(false);
      expect(res.strengths).toHaveLength(1);
      expect(res.strengths[0].rawStrength).toBe('5 mg');
      expect(res.strengths[0].value).toBe(5);
      expect(res.strengths[0].unit).toBe('mg');
      expect(res.rawSummary).toBe('5 mg');
    });

    it('extracts microgram lozenges and inhalers', () => {
      const res = extractStrengths(
        'Dequalinium chloride 250 microgram oromucosal lozenge',
      );
      expect(res.isVerified).toBe(true);
      expect(res.strengths[0].rawStrength).toBe('250 microgram');
      expect(res.strengths[0].value).toBe(250);
      expect(res.strengths[0].unit).toBe('microgram');
    });

    it('extracts concentration values such as mg/mL or g/100 mL', () => {
      const res1 = extractStrengths('Trakacin 250 mg/mL solution for injection');
      expect(res1.isVerified).toBe(true);
      expect(res1.strengths[0].rawStrength).toBe('250 mg/mL');
      expect(res1.strengths[0].value).toBe(250);

      const res2 = extractStrengths('Gypgesic 1 g/100 ml solution for infusion');
      expect(res2.isVerified).toBe(true);
      expect(res2.strengths[0].rawStrength).toBe('1 g/100 ml');
    });

    it('extracts biological units like million unit or miu/vial', () => {
      const res = extractStrengths(
        'Guficol Plus 2 miu/vial powder for solution for injection',
      );
      expect(res.isVerified).toBe(true);
      expect(res.strengths[0].rawStrength).toBe('2 miu/vial');
      expect(res.strengths[0].value).toBe(2);
    });

    it('extracts nanograms (ng)', () => {
      const res = extractStrengths('Calcilol 250 ng oral capsule');
      expect(res.isVerified).toBe(true);
      expect(res.strengths[0].rawStrength).toBe('250 ng');
      expect(res.strengths[0].value).toBe(250);
    });
  });

  describe('Combination / Multi-ingredient medicines', () => {
    it('preserves individual ingredient strengths joined with + (Brand style)', () => {
      const res = extractStrengths(
        'Flucret 30 mg + 4 mg + 500 mg + 10 mg oral tablet',
      );
      expect(res.isVerified).toBe(true);
      expect(res.isCombination).toBe(true);
      expect(res.strengths).toHaveLength(4);
      expect(res.strengths.map((s) => s.rawStrength)).toEqual([
        '30 mg',
        '4 mg',
        '500 mg',
        '10 mg',
      ]);
      expect(res.rawSummary).toBe('30 mg + 4 mg + 500 mg + 10 mg');
    });

    it('preserves individual ingredient strengths joined with and (Generic style)', () => {
      const res = extractStrengths(
        'Nimesulide 100 mg and Acetaminophen 500 mg oral tablet',
      );
      expect(res.isVerified).toBe(true);
      expect(res.isCombination).toBe(true);
      expect(res.strengths).toHaveLength(2);
      expect(res.strengths[0].ingredient).toBe('Nimesulide');
      expect(res.strengths[0].rawStrength).toBe('100 mg');
      expect(res.strengths[1].ingredient).toBe('Acetaminophen');
      expect(res.strengths[1].rawStrength).toBe('500 mg');
      expect(res.rawSummary).toBe('100 mg + 500 mg');
    });

    it('does not merge individual combination strengths into a single number', () => {
      const res = extractStrengths(
        'Rexonac MR 325 mg + 250 mg + 100 mg oral tablet',
      );
      expect(res.strengths).toHaveLength(3);
      // Ensure values are distinct
      expect(res.strengths[0].value).toBe(325);
      expect(res.strengths[1].value).toBe(250);
      expect(res.strengths[2].value).toBe(100);
      expect(res.rawSummary).not.toBe('675 mg');
      expect(res.rawSummary).toBe('325 mg + 250 mg + 100 mg');
    });
  });

  describe('Ambiguous and unverified medicine names', () => {
    it('flags names without clear strength as unverified without inventing values', () => {
      const res = extractStrengths('Surgical Spirit solution for skin');
      expect(res.isVerified).toBe(false);
      expect(res.strengths).toHaveLength(0);
      expect(res.rawSummary).toBe('Unverified / Not Specified');
    });

    it('handles null, undefined and empty strings safely', () => {
      const res1 = extractStrengths('');
      expect(res1.isVerified).toBe(false);
      expect(res1.strengths).toHaveLength(0);

      // @ts-expect-error test undefined runtime safety
      const res2 = extractStrengths(undefined);
      expect(res2.isVerified).toBe(false);
    });
  });
});
