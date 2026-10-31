import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CatalogueService } from './catalogue.service.js';
import { CatalogueSearchType } from './dto/search-catalogue.dto.js';

describe('CatalogueService', () => {
  let service: CatalogueService;
  let mockGenericModel: any;
  let mockBrandModel: any;

  beforeEach(() => {
    mockGenericModel = {
      find: vi.fn(),
      countDocuments: vi.fn(),
    };
    mockBrandModel = {
      find: vi.fn(),
      countDocuments: vi.fn(),
    };

    service = new CatalogueService(mockGenericModel, mockBrandModel);
  });

  describe('search', () => {
    it('returns empty result with CC BY 4.0 attribution if query string is empty', async () => {
      const res = await service.search({ q: '' });
      expect(res.items).toEqual([]);
      expect(res.total).toBe(0);
      expect(res.attribution).toContain('CDCI / NRCeS India (CC BY 4.0)');
    });

    it('searches BRAND items when searchType is BRAND', async () => {
      const mockBrands = [
        {
          identifier: 'B101',
          brandName: 'Dolo 650',
          genericName: 'Paracetamol',
          productName: 'Dolo 650 Tablet',
          dosageForm: 'Tablet',
          route: 'Oral',
          strengths: [{ rawStrength: '650 mg', value: 650, unit: 'mg' }],
          rawStrengthSummary: '650 mg',
          isCombination: false,
          isStrengthVerified: true,
          sourceProvenance: 'CDCI_NRCES_INDIA',
        },
      ];

      mockBrandModel.countDocuments.mockReturnValue({
        exec: vi.fn().mockResolvedValue(1),
      });
      mockBrandModel.find.mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockReturnValue({
          exec: vi.fn().mockResolvedValue(mockBrands),
        }),
      });

      const res = await service.search({
        q: 'Dolo',
        type: CatalogueSearchType.BRAND,
        page: 1,
        limit: 10,
      });

      expect(res.total).toBe(1);
      expect(res.items.length).toBe(1);
      expect(res.items[0].name).toBe('Dolo 650');
      expect(res.items[0].type).toBe('BRAND');
      expect(res.items[0].rawStrengthSummary).toBe('650 mg');
    });

    it('searches GENERIC items when searchType is GENERIC', async () => {
      const mockGenerics = [
        {
          identifier: 'G202',
          genericName: 'Amoxicillin and Clavulanic Acid 500 mg + 125 mg Tablet',
          doseForm: 'Tablet',
          routes: ['Oral'],
          strengths: [
            { rawStrength: '500 mg', value: 500, unit: 'mg' },
            { rawStrength: '125 mg', value: 125, unit: 'mg' },
          ],
          rawStrengthSummary: '500 mg + 125 mg',
          isCombination: true,
          isStrengthVerified: true,
          sourceProvenance: 'CDCI_NRCES_INDIA',
        },
      ];

      mockGenericModel.countDocuments.mockReturnValue({
        exec: vi.fn().mockResolvedValue(1),
      });
      mockGenericModel.find.mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockReturnValue({
          exec: vi.fn().mockResolvedValue(mockGenerics),
        }),
      });

      const res = await service.search({
        q: 'Amoxicillin',
        type: CatalogueSearchType.GENERIC,
      });

      expect(res.total).toBe(1);
      expect(res.items.length).toBe(1);
      expect(res.items[0].name).toContain('Amoxicillin');
      expect(res.items[0].type).toBe('GENERIC');
      expect(res.items[0].isCombination).toBe(true);
      expect(res.items[0].rawStrengthSummary).toBe('500 mg + 125 mg');
    });

    it('merges both and prioritizes prefix matches when type is ALL', async () => {
      const mockBrands = [
        {
          identifier: 'B1',
          brandName: 'Calpol 500',
          genericName: 'Paracetamol',
          isStrengthVerified: true,
          sourceProvenance: 'CDCI_NRCES_INDIA',
        },
      ];
      const mockGenerics = [
        {
          identifier: 'G1',
          genericName: 'Paracetamol 500 mg Tablet',
          doseForm: 'Tablet',
          routes: ['Oral'],
          isStrengthVerified: true,
          sourceProvenance: 'CDCI_NRCES_INDIA',
        },
      ];

      mockBrandModel.countDocuments.mockReturnValue({
        exec: vi.fn().mockResolvedValue(1),
      });
      mockGenericModel.countDocuments.mockReturnValue({
        exec: vi.fn().mockResolvedValue(1),
      });

      mockBrandModel.find.mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockReturnValue({
          exec: vi.fn().mockResolvedValue(mockBrands),
        }),
      });
      mockGenericModel.find.mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockReturnValue({
          exec: vi.fn().mockResolvedValue(mockGenerics),
        }),
      });

      const res = await service.search({ q: 'Para' });
      expect(res.total).toBe(2);
      expect(res.items.length).toBe(2);
      // 'Paracetamol 500 mg Tablet' starts with 'Para', while 'Calpol 500' does not
      expect(res.items[0].name).toBe('Paracetamol 500 mg Tablet');
      expect(res.items[1].name).toBe('Calpol 500');
    });
  });

  describe('getStrengthsForMedicine', () => {
    it('returns empty array when query is empty', async () => {
      const res = await service.getStrengthsForMedicine({ name: '' });
      expect(res).toEqual({ strengths: [], variantsCount: 0, isSingleMatch: false });
    });

    it('returns single verified strength and flags isSingleMatch true', async () => {
      mockBrandModel.find.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        lean: vi.fn().mockReturnValue({
          exec: vi.fn().mockResolvedValue([
            {
              isStrengthVerified: true,
              rawStrengthSummary: '650 mg',
            },
          ]),
        }),
      });
      mockGenericModel.find.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        lean: vi.fn().mockReturnValue({
          exec: vi.fn().mockResolvedValue([]),
        }),
      });

      const res = await service.getStrengthsForMedicine({ name: 'Dolo' });
      expect(res.strengths).toEqual(['650 mg']);
      expect(res.variantsCount).toBe(1);
      expect(res.isSingleMatch).toBe(true);
    });

    it('returns multiple sorted verified strengths and flags isSingleMatch false', async () => {
      mockBrandModel.find.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        lean: vi.fn().mockReturnValue({
          exec: vi.fn().mockResolvedValue([
            { isStrengthVerified: true, rawStrengthSummary: '650 mg' },
            { isStrengthVerified: true, rawStrengthSummary: '500 mg' },
            { isStrengthVerified: true, rawStrengthSummary: '1000 mg' },
            { isStrengthVerified: false, rawStrengthSummary: 'Unspecified' },
          ]),
        }),
      });
      mockGenericModel.find.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        lean: vi.fn().mockReturnValue({
          exec: vi.fn().mockResolvedValue([
            { isStrengthVerified: true, rawStrengthSummary: '250 mg' },
          ]),
        }),
      });

      const res = await service.getStrengthsForMedicine({ name: 'Paracetamol' });
      expect(res.strengths).toEqual(['250 mg', '500 mg', '650 mg', '1000 mg']);
      expect(res.variantsCount).toBe(4);
      expect(res.isSingleMatch).toBe(false);
    });

    it('does not invent strengths when unverified', async () => {
      mockBrandModel.find.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        lean: vi.fn().mockReturnValue({
          exec: vi.fn().mockResolvedValue([
            { isStrengthVerified: false, rawStrengthSummary: 'Unspecified' },
          ]),
        }),
      });
      mockGenericModel.find.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        lean: vi.fn().mockReturnValue({
          exec: vi.fn().mockResolvedValue([]),
        }),
      });

      const res = await service.getStrengthsForMedicine({ name: 'Herbal Balm' });
      expect(res.strengths).toEqual([]);
      expect(res.variantsCount).toBe(0);
      expect(res.isSingleMatch).toBe(false);
    });
  });

  describe('getFeed', () => {
    it('returns batched feed items with nextCursor for pagination', async () => {
      const mockFeedItems = [
        {
          identifier: 'B1',
          brandName: 'Brand 1',
          supplierName: 'Pharma Corp',
          releaseType: 'SUSTAINED_RELEASE',
          strengths: [{ rawStrength: '100 mg' }],
          rawStrengthSummary: '100 mg',
          isStrengthVerified: true,
          sourceProvenance: 'CDCI_NRCES_INDIA',
        },
        {
          identifier: 'B2',
          brandName: 'Brand 2',
          releaseType: 'IMMEDIATE_RELEASE',
          strengths: [{ rawStrength: '50 mg' }],
          rawStrengthSummary: '50 mg',
          isStrengthVerified: true,
          sourceProvenance: 'CDCI_NRCES_INDIA',
        },
      ];

      mockBrandModel.countDocuments.mockReturnValue({
        exec: vi.fn().mockResolvedValue(2),
      });
      mockBrandModel.find.mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockReturnValue({
          exec: vi.fn().mockResolvedValue(mockFeedItems),
        }),
      });

      const res = await service.getFeed(undefined, 2);
      expect(res.items.length).toBe(2);
      expect(res.total).toBe(2);
      expect(res.nextCursor).toBe('B2');
      expect(res.items[0].releaseType).toBe('SUSTAINED_RELEASE');
      expect(res.items[0].manufacturer).toBe('Pharma Corp');
      expect(res.attribution).toContain('CDCI / NRCeS India (CC BY 4.0)');
    });
  });
});
