import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  CatalogueGeneric,
  CatalogueGenericDocument,
} from './schemas/catalogue-generic.schema.js';
import {
  CatalogueBrand,
  CatalogueBrandDocument,
} from './schemas/catalogue-brand.schema.js';
import {
  SearchCatalogueDto,
  CatalogueSearchType,
  GetStrengthsQueryDto,
} from './dto/search-catalogue.dto.js';

export interface CatalogueSearchItem {
  id: string;
  sourceIdentifier: string;
  type: 'BRAND' | 'GENERIC';
  name: string;
  brandName?: string;
  genericName?: string;
  productName?: string;
  dosageForm?: string;
  route?: string;
  strengths: Array<{
    ingredient?: string;
    rawStrength: string;
    value?: number;
    unit?: string;
  }>;
  rawStrengthSummary: string;
  releaseType?: string;
  manufacturer?: string;
  isCombination: boolean;
  isStrengthVerified: boolean;
  sourceProvenance: string;
}

export interface CatalogueSearchResult {
  items: CatalogueSearchItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  attribution: string;
}

export interface CatalogueFeedResult {
  items: CatalogueSearchItem[];
  nextCursor: string | null;
  total: number;
  attribution: string;
}

@Injectable()
export class CatalogueService {
  private readonly logger = new Logger(CatalogueService.name);

  constructor(
    @InjectModel(CatalogueGeneric.name)
    private readonly genericModel: Model<CatalogueGenericDocument>,
    @InjectModel(CatalogueBrand.name)
    private readonly brandModel: Model<CatalogueBrandDocument>,
  ) {}

  /**
   * Searches the reference catalogue across Brand, Product, Generic, and Active Ingredients.
   * Deterministic sorting prioritizes exact prefix matches, followed by alphabetical order.
   */
  async search(dto: SearchCatalogueDto): Promise<CatalogueSearchResult> {
    const rawQuery = dto.q ? dto.q.trim() : '';
    if (!rawQuery) {
      return {
        items: [],
        total: 0,
        page: dto.page || 1,
        limit: dto.limit || 20,
        totalPages: 0,
        attribution:
          'CDCI / NRCeS India (CC BY 4.0); SNOMED CT® International Release terms apply.',
      };
    }

    const page = Math.max(1, dto.page || 1);
    const limit = Math.min(100, Math.max(1, dto.limit || 20));
    const skip = (page - 1) * limit;

    // Safe escaped regex for matching
    const escaped = rawQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'i');
    const searchType = dto.type || CatalogueSearchType.ALL;

    const brandFilter: any = {
      $or: [
        { brandName: regex },
        { productName: regex },
        { genericName: regex },
        { identifier: rawQuery },
      ],
    };
    if (dto.formulation) {
      const formRegex = new RegExp(dto.formulation, 'i');
      brandFilter.$and = [
        {
          $or: [{ dosageForm: formRegex }, { brandName: formRegex }],
        },
      ];
    }
    if (dto.releaseType) {
      brandFilter.releaseType = dto.releaseType;
    }

    const genericFilter: any = {
      $or: [
        { genericName: regex },
        { substances: regex },
        { identifier: rawQuery },
      ],
    };
    if (dto.formulation) {
      const formRegex = new RegExp(dto.formulation, 'i');
      genericFilter.$and = [
        {
          $or: [{ doseForm: formRegex }, { genericName: formRegex }],
        },
      ];
    }
    if (dto.releaseType) {
      genericFilter.releaseType = dto.releaseType;
    }

    let items: CatalogueSearchItem[] = [];
    let total = 0;

    if (searchType === CatalogueSearchType.BRAND) {
      total = await this.brandModel.countDocuments(brandFilter).exec();
      const brands = await this.brandModel
        .find(brandFilter)
        .sort({ brandName: 1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec();

      items = brands.map((b) => ({
        id: b.identifier,
        sourceIdentifier: b.identifier,
        type: 'BRAND',
        name: b.brandName,
        brandName: b.brandName,
        genericName: b.genericName || undefined,
        productName: b.productName || undefined,
        dosageForm: b.dosageForm || undefined,
        route: b.route || undefined,
        strengths: b.strengths || [],
        rawStrengthSummary: b.rawStrengthSummary,
        releaseType: b.releaseType || 'IMMEDIATE_RELEASE',
        manufacturer: b.supplierName || undefined,
        isCombination: b.isCombination,
        isStrengthVerified: b.isStrengthVerified,
        sourceProvenance: b.sourceProvenance,
      }));
    } else if (searchType === CatalogueSearchType.GENERIC) {
      total = await this.genericModel.countDocuments(genericFilter).exec();
      const generics = await this.genericModel
        .find(genericFilter)
        .sort({ genericName: 1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec();

      items = generics.map((g) => ({
        id: g.identifier,
        sourceIdentifier: g.identifier,
        type: 'GENERIC',
        name: g.genericName,
        genericName: g.genericName,
        dosageForm: g.doseForm || undefined,
        route: g.routes && g.routes.length > 0 ? g.routes[0] : undefined,
        strengths: g.strengths || [],
        rawStrengthSummary: g.rawStrengthSummary,
        releaseType: g.releaseType || 'IMMEDIATE_RELEASE',
        manufacturer: undefined,
        isCombination: g.isCombination,
        isStrengthVerified: g.isStrengthVerified,
        sourceProvenance: g.sourceProvenance,
      }));
    } else {
      // ALL: query both and merge with deterministic prefix relevance
      const [brandCount, genericCount] = await Promise.all([
        this.brandModel.countDocuments(brandFilter).exec(),
        this.genericModel.countDocuments(genericFilter).exec(),
      ]);
      total = brandCount + genericCount;

      const [brands, generics] = await Promise.all([
        this.brandModel
          .find(brandFilter)
          .sort({ brandName: 1 })
          .limit(limit)
          .lean()
          .exec(),
        this.genericModel
          .find(genericFilter)
          .sort({ genericName: 1 })
          .limit(limit)
          .lean()
          .exec(),
      ]);

      const merged: CatalogueSearchItem[] = [
        ...brands.map((b) => ({
          id: b.identifier,
          sourceIdentifier: b.identifier,
          type: 'BRAND' as const,
          name: b.brandName,
          brandName: b.brandName,
          genericName: b.genericName || undefined,
          productName: b.productName || undefined,
          dosageForm: b.dosageForm || undefined,
          route: b.route || undefined,
          strengths: b.strengths || [],
          rawStrengthSummary: b.rawStrengthSummary,
          releaseType: b.releaseType || 'IMMEDIATE_RELEASE',
          manufacturer: b.supplierName || undefined,
          isCombination: b.isCombination,
          isStrengthVerified: b.isStrengthVerified,
          sourceProvenance: b.sourceProvenance,
        })),
        ...generics.map((g) => ({
          id: g.identifier,
          sourceIdentifier: g.identifier,
          type: 'GENERIC' as const,
          name: g.genericName,
          genericName: g.genericName,
          dosageForm: g.doseForm || undefined,
          route: g.routes && g.routes.length > 0 ? g.routes[0] : undefined,
          strengths: g.strengths || [],
          rawStrengthSummary: g.rawStrengthSummary,
          releaseType: g.releaseType || 'IMMEDIATE_RELEASE',
          manufacturer: undefined,
          isCombination: g.isCombination,
          isStrengthVerified: g.isStrengthVerified,
          sourceProvenance: g.sourceProvenance,
        })),
      ];

      // Sort: exact prefix matches first, then alphabetical
      const lowerQ = rawQuery.toLowerCase();
      merged.sort((a, b) => {
        const aPrefix = a.name.toLowerCase().startsWith(lowerQ);
        const bPrefix = b.name.toLowerCase().startsWith(lowerQ);
        if (aPrefix && !bPrefix) return -1;
        if (!aPrefix && bPrefix) return 1;
        return a.name.localeCompare(b.name);
      });

      items = merged.slice(0, limit);
    }

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      attribution:
        'CDCI / NRCeS India (CC BY 4.0); SNOMED CT® International Release terms apply.',
    };
  }

  /**
   * Retrieves verified strengths available for a medicine name and formulation.
   * Powers the automatic strength selection in the prescription UI.
   */
  async getStrengthsForMedicine(
    dto: GetStrengthsQueryDto,
  ): Promise<{ strengths: string[]; variantsCount: number; isSingleMatch: boolean }> {
    const rawName = dto.name ? dto.name.trim() : '';
    if (!rawName) {
      return { strengths: [], variantsCount: 0, isSingleMatch: false };
    }

    const escaped = rawName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`^${escaped}$`, 'i');
    const partialRegex = new RegExp(escaped, 'i');

    const brandFilter: any = {
      $or: [{ brandName: partialRegex }, { productName: regex }, { genericName: regex }],
    };
    if (dto.formulation) {
      const formRegex = new RegExp(dto.formulation, 'i');
      brandFilter.$and = [
        {
          $or: [{ dosageForm: formRegex }, { brandName: formRegex }, { productName: formRegex }],
        },
      ];
    }

    const genericFilter: any = {
      $or: [{ genericName: partialRegex }, { substances: regex }],
    };
    if (dto.formulation) {
      const formRegex = new RegExp(dto.formulation, 'i');
      genericFilter.$and = [
        {
          $or: [{ doseForm: formRegex }, { genericName: formRegex }],
        },
      ];
    }

    const [brands, generics] = await Promise.all([
      this.brandModel.find(brandFilter).select('strengths rawStrengthSummary isStrengthVerified').lean().exec(),
      this.genericModel.find(genericFilter).select('strengths rawStrengthSummary isStrengthVerified').lean().exec(),
    ]);

    const set = new Set<string>();

    for (const b of brands) {
      if (b.isStrengthVerified && b.rawStrengthSummary && b.rawStrengthSummary !== 'Unspecified') {
        set.add(b.rawStrengthSummary);
      }
    }
    for (const g of generics) {
      if (g.isStrengthVerified && g.rawStrengthSummary && g.rawStrengthSummary !== 'Unspecified') {
        set.add(g.rawStrengthSummary);
      }
    }

    const strengths = Array.from(set).sort((a, b) => {
      const numA = parseFloat(a) || 0;
      const numB = parseFloat(b) || 0;
      return numA - numB;
    });

    return {
      strengths,
      variantsCount: strengths.length,
      isSingleMatch: strengths.length === 1,
    };
  }

  /**
   * Provides an incremental, cursor-paginated batched feed of catalogue records.
   * Designed for efficient local offline cache population in desktop clients.
   * Feeds generics first (with G_ cursor prefix), then brands (with B_ cursor prefix).
   */
  async getFeed(
    cursor?: string,
    limit = 100,
  ): Promise<CatalogueFeedResult> {
    const safeLimit = Math.min(500, Math.max(1, limit || 100));
    const [genericCount, brandCount] = await Promise.all([
      this.genericModel.countDocuments().exec(),
      this.brandModel.countDocuments().exec(),
    ]);
    const total = genericCount + brandCount;

    const items: CatalogueSearchItem[] = [];
    const trimmedCursor = cursor ? cursor.trim() : '';

    if (!trimmedCursor || trimmedCursor.startsWith('G_')) {
      const genericCursorId = trimmedCursor.startsWith('G_')
        ? trimmedCursor.slice(2)
        : '';
      const genericFilter = genericCursorId ? { identifier: { $gt: genericCursorId } } : {};

      const generics = await this.genericModel
        .find(genericFilter)
        .sort({ identifier: 1 })
        .limit(safeLimit)
        .lean()
        .exec();

      for (const g of generics) {
        items.push({
          id: g.identifier,
          sourceIdentifier: g.identifier,
          type: 'GENERIC',
          name: g.genericName,
          genericName: g.genericName,
          dosageForm: g.doseForm || undefined,
          route: g.routes && g.routes.length > 0 ? g.routes[0] : undefined,
          strengths: g.strengths || [],
          rawStrengthSummary: g.rawStrengthSummary,
          releaseType: g.releaseType || 'IMMEDIATE_RELEASE',
          manufacturer: undefined,
          isCombination: g.isCombination,
          isStrengthVerified: g.isStrengthVerified,
          sourceProvenance: g.sourceProvenance,
        });
      }

      if (items.length < safeLimit) {
        // Generics exhausted in this batch; fill remaining capacity with brands
        const brandLimit = safeLimit - items.length;
        const brands = await this.brandModel
          .find({})
          .sort({ identifier: 1 })
          .limit(brandLimit)
          .lean()
          .exec();

        for (const b of brands) {
          items.push({
            id: b.identifier,
            sourceIdentifier: b.identifier,
            type: 'BRAND',
            name: b.brandName,
            brandName: b.brandName,
            genericName: b.genericName || undefined,
            productName: b.productName || undefined,
            dosageForm: b.dosageForm || undefined,
            route: b.route || undefined,
            strengths: b.strengths || [],
            rawStrengthSummary: b.rawStrengthSummary,
            releaseType: b.releaseType || 'IMMEDIATE_RELEASE',
            manufacturer: b.supplierName || undefined,
            isCombination: b.isCombination,
            isStrengthVerified: b.isStrengthVerified,
            sourceProvenance: b.sourceProvenance,
          });
        }

        const nextCursor =
          brands.length > 0
            ? `B_${brands[brands.length - 1].identifier}`
            : generics.length === safeLimit
              ? `G_${generics[generics.length - 1].identifier}`
              : null;

        return {
          items,
          nextCursor,
          total,
          attribution:
            'CDCI / NRCeS India (CC BY 4.0); SNOMED CT® International Release terms apply.',
        };
      } else {
        const nextCursor = `G_${generics[generics.length - 1].identifier}`;
        return {
          items,
          nextCursor,
          total,
          attribution:
            'CDCI / NRCeS India (CC BY 4.0); SNOMED CT® International Release terms apply.',
        };
      }
    } else {
      // Cursor starts with 'B_' or is legacy brand id
      const brandCursorId = trimmedCursor.startsWith('B_')
        ? trimmedCursor.slice(2)
        : trimmedCursor;
      const brandFilter = brandCursorId ? { identifier: { $gt: brandCursorId } } : {};

      const brands = await this.brandModel
        .find(brandFilter)
        .sort({ identifier: 1 })
        .limit(safeLimit)
        .lean()
        .exec();

      for (const b of brands) {
        items.push({
          id: b.identifier,
          sourceIdentifier: b.identifier,
          type: 'BRAND',
          name: b.brandName,
          brandName: b.brandName,
          genericName: b.genericName || undefined,
          productName: b.productName || undefined,
          dosageForm: b.dosageForm || undefined,
          route: b.route || undefined,
          strengths: b.strengths || [],
          rawStrengthSummary: b.rawStrengthSummary,
          releaseType: b.releaseType || 'IMMEDIATE_RELEASE',
          manufacturer: b.supplierName || undefined,
          isCombination: b.isCombination,
          isStrengthVerified: b.isStrengthVerified,
          sourceProvenance: b.sourceProvenance,
        });
      }

      const nextCursor =
        brands.length === safeLimit
          ? `B_${brands[brands.length - 1].identifier}`
          : null;

      return {
        items,
        nextCursor,
        total,
        attribution:
          'CDCI / NRCeS India (CC BY 4.0); SNOMED CT® International Release terms apply.',
      };
    }
  }
}
