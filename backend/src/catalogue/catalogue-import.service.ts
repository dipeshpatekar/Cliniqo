import { Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import {
  CatalogueGeneric,
  CatalogueGenericDocument,
} from './schemas/catalogue-generic.schema.js';
import {
  CatalogueBrand,
  CatalogueBrandDocument,
} from './schemas/catalogue-brand.schema.js';
import {
  CatalogueProduct,
  CatalogueProductDocument,
} from './schemas/catalogue-product.schema.js';
import {
  CatalogueImportJob,
  CatalogueImportJobDocument,
} from './schemas/catalogue-import-job.schema.js';
import { extractStrengths } from './catalogue-strength-parser.js';

export interface ImportSummary {
  jobId: string;
  isDryRun: boolean;
  status: 'COMPLETED' | 'FAILED';
  sourcePath: string;
  totalGenericProcessed: number;
  totalGenericInserted: number;
  totalBrandProcessed: number;
  totalBrandInserted: number;
  totalProductInserted?: number;
  totalRejected: number;
  durationMs: number;
  attribution: string;
  rejectedDetails: Array<{
    file: string;
    line: number;
    identifier?: string;
    reason: string;
  }>;
  error?: string;
}

export const CDCI_REQUIRED_FILES = [
  'GenericMaster.txt',
  'BrandMaster.txt',
  'ProductMaster.txt',
  'SubstanceMaster.txt',
  'SupplierMaster.txt',
  'DrugFormMaster.txt',
  'RouteOfAdministrationMaster.txt',
] as const;

@Injectable()
export class CatalogueImportService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CatalogueImportService.name);

  constructor(
    @InjectModel(CatalogueGeneric.name)
    private readonly genericModel: Model<CatalogueGenericDocument>,
    @InjectModel(CatalogueBrand.name)
    private readonly brandModel: Model<CatalogueBrandDocument>,
    @InjectModel(CatalogueImportJob.name)
    private readonly jobModel: Model<CatalogueImportJobDocument>,
    @Optional()
    @InjectModel(CatalogueProduct.name)
    private readonly productModel?: Model<CatalogueProductDocument>,
  ) {}

  /**
   * CDCI dataset has been decommissioned.
   */
  async onApplicationBootstrap(): Promise<void> {
    // CDCI dataset has been decommissioned. No auto-import on bootstrap.
  }

  /**
   * Resolves CDCI package directory in priority order:
   * 1. customPath (if provided)
   * 2. process.env.CDCI_DATA_DIR (if set)
   * 3. Project workspace candidates
   * 4. User downloads fallback: ~/Downloads/CommonDrugCodesForIndia_FlatFilePackage
   */
  resolveSourcePath(customPath?: string): string {
    if (customPath && customPath.trim()) {
      const p = customPath.trim();
      return p.startsWith('~')
        ? path.join(process.env.HOME || '', p.slice(1))
        : path.resolve(p);
    }

    if (process.env.CDCI_DATA_DIR && process.env.CDCI_DATA_DIR.trim()) {
      const envPath = process.env.CDCI_DATA_DIR.trim();
      return envPath.startsWith('~')
        ? path.join(process.env.HOME || '', envPath.slice(1))
        : path.resolve(envPath);
    }

    const candidates = [
      path.resolve(process.cwd(), 'data', 'cdci', 'CommonDrugCodesForIndia_FlatFilePackage'),
      path.resolve(process.cwd(), 'backend', 'data', 'cdci', 'CommonDrugCodesForIndia_FlatFilePackage'),
      path.resolve(process.cwd(), '..', 'data', 'cdci', 'CommonDrugCodesForIndia_FlatFilePackage'),
      path.resolve(process.cwd(), '..', 'backend', 'data', 'cdci', 'CommonDrugCodesForIndia_FlatFilePackage'),
      path.resolve(__dirname, '..', '..', 'data', 'cdci', 'CommonDrugCodesForIndia_FlatFilePackage'),
      path.resolve(__dirname, '..', '..', '..', 'data', 'cdci', 'CommonDrugCodesForIndia_FlatFilePackage'),
      path.resolve(__dirname, '..', '..', '..', 'backend', 'data', 'cdci', 'CommonDrugCodesForIndia_FlatFilePackage'),
      path.join(process.env.HOME || '', 'Downloads', 'CommonDrugCodesForIndia_FlatFilePackage'),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return path.resolve(process.cwd(), 'data', 'cdci', 'CommonDrugCodesForIndia_FlatFilePackage');
  }

  /**
   * Reads a TSV line and handles trailing tabs and whitespace.
   */
  parseTsvLine(line: string, minCols: number): string[] {
    const raw = line.split('\t').map((c) => c.trim());
    while (raw.length < minCols) {
      raw.push('');
    }
    return raw;
  }

  /**
   * Executes CDCI catalogue import or dry-run validation.
   */
  async runImport(
    options: {
      sourcePath?: string;
      dryRun?: boolean;
    } = {},
  ): Promise<ImportSummary> {
    const startTime = Date.now();
    const sourceDir = this.resolveSourcePath(options.sourcePath);
    const isDryRun = Boolean(options.dryRun);
    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    const summary: ImportSummary = {
      jobId,
      isDryRun,
      status: 'COMPLETED',
      sourcePath: sourceDir,
      totalGenericProcessed: 0,
      totalGenericInserted: 0,
      totalBrandProcessed: 0,
      totalBrandInserted: 0,
      totalRejected: 0,
      durationMs: 0,
      attribution:
        'National Resource Centre for EHR Standards (NRCeS) at C-DAC Pune under CC BY 4.0; SNOMED CT® International Release terms apply within India.',
      rejectedDetails: [],
    };

    this.logger.log(
      `Starting CDCI Catalogue Import (Job: ${jobId}, dryRun: ${isDryRun}) from: ${sourceDir}`,
    );

    try {
      // 1. Verify directory exists
      if (!fs.existsSync(sourceDir)) {
        throw new Error(
          `CDCI source package directory not found at: ${sourceDir}. Please ensure the dataset is placed at data/cdci/CommonDrugCodesForIndia_FlatFilePackage/ or configured via CDCI_DATA_DIR. Refer to data/cdci/README.md for setup instructions.`,
        );
      }

      // 2. Validate that all required master files exist
      const missingFiles = CDCI_REQUIRED_FILES.filter(
        (fileName) => !fs.existsSync(path.join(sourceDir, fileName)),
      );
      if (missingFiles.length > 0) {
        throw new Error(
          `CDCI source package at ${sourceDir} is incomplete. Missing required file(s): ${missingFiles.join(', ')}. Please refer to data/cdci/README.md for instructions on obtaining the full flat file package.`,
        );
      }

      // 1. Load Reference Lookups (DoseForm, Route, Substance, Supplier, Product)
      this.logger.log('Loading auxiliary reference master files...');
      const formsMap = await this.loadTwoColLookup(
        path.join(sourceDir, 'DrugFormMaster.txt'),
      );
      const routesMap = await this.loadTwoColLookup(
        path.join(sourceDir, 'RouteOfAdministrationMaster.txt'),
      );
      const substancesMap = await this.loadSubstanceLookup(
        path.join(sourceDir, 'SubstanceMaster.txt'),
      );
      const suppliersMap = await this.loadSupplierLookup(
        path.join(sourceDir, 'SupplierMaster.txt'),
      );
      const productsMap = await this.loadTwoColLookup(
        path.join(sourceDir, 'ProductMaster.txt'),
      );

      this.logger.log(
        `Lookups loaded: ${formsMap.size} dose forms, ${routesMap.size} routes, ${substancesMap.size} substances, ${suppliersMap.size} suppliers, ${productsMap.size} products.`,
      );

      // Persist products if productModel is available and collection empty
      if (!isDryRun && this.productModel) {
        try {
          const productCount = await this.productModel.estimatedDocumentCount().exec();
          if (productCount === 0 && productsMap.size > 0) {
            this.logger.log(`Populating catalogue_products with ${productsMap.size} records...`);
            const pBatch: any[] = [];
            for (const [identifier, productName] of productsMap.entries()) {
              pBatch.push({
                updateOne: {
                  filter: { identifier },
                  update: {
                    $set: {
                      identifier,
                      productName,
                      sourceProvenance: 'CDCI_NRCES_INDIA',
                    },
                  },
                  upsert: true,
                },
              });
              if (pBatch.length >= 2000) {
                await this.productModel.bulkWrite(pBatch, { ordered: false });
                pBatch.length = 0;
              }
            }
            if (pBatch.length > 0) {
              await this.productModel.bulkWrite(pBatch, { ordered: false });
            }
            summary.totalProductInserted = productsMap.size;
          }
        } catch (prodErr) {
          this.logger.warn('Failed to bulk populate catalogue_products:', prodErr);
        }
      }

      // 2. Stream GenericMaster.txt
      const genericLookup = new Map<
        string,
        { genericName: string; dosageForm?: string; route?: string }
      >();
      await this.processGenericMaster(
        path.join(sourceDir, 'GenericMaster.txt'),
        formsMap,
        routesMap,
        substancesMap,
        genericLookup,
        summary,
        isDryRun,
      );

      // 3. Stream BrandMaster.txt
      await this.processBrandMaster(
        path.join(sourceDir, 'BrandMaster.txt'),
        productsMap,
        suppliersMap,
        genericLookup,
        summary,
        isDryRun,
      );

      summary.durationMs = Date.now() - startTime;
      summary.status = 'COMPLETED';

      this.logger.log(
        `CDCI Catalogue Import completed in ${summary.durationMs}ms. Generics: ${summary.totalGenericInserted}/${summary.totalGenericProcessed}, Brands: ${summary.totalBrandInserted}/${summary.totalBrandProcessed}, Rejected: ${summary.totalRejected}`,
      );
    } catch (err: unknown) {
      summary.durationMs = Date.now() - startTime;
      summary.status = 'FAILED';
      summary.error = err instanceof Error ? err.message : String(err);
      this.logger.error(`CDCI Catalogue Import failed: ${summary.error}`, err);
    }

    // Persist import job record
    try {
      await this.jobModel.create({
        jobId: summary.jobId,
        isDryRun: summary.isDryRun,
        sourcePath: summary.sourcePath,
        totalGenericProcessed: summary.totalGenericProcessed,
        totalGenericInserted: summary.totalGenericInserted,
        totalBrandProcessed: summary.totalBrandProcessed,
        totalBrandInserted: summary.totalBrandInserted,
        totalRejected: summary.totalRejected,
        rejectedDetails: summary.rejectedDetails.slice(0, 100), // Persist top 100 rejections in DB
        status: summary.status,
        durationMs: summary.durationMs,
        error: summary.error || null,
        startedAt: new Date(startTime),
        completedAt: new Date(),
      });
    } catch (dbErr) {
      this.logger.warn('Failed to record import job document:', dbErr);
    }

    return summary;
  }

  private async loadTwoColLookup(filePath: string): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (!fs.existsSync(filePath)) return map;

    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });

    let isHeader = true;
    for await (const line of rl) {
      if (isHeader) {
        isHeader = false;
        continue;
      }
      if (!line.trim()) continue;
      const cols = line.split('\t');
      if (cols.length >= 2) {
        const id = cols[0].trim();
        const val = cols[1].trim();
        if (id && val) map.set(id, val);
      }
    }
    return map;
  }

  private async loadSubstanceLookup(
    filePath: string,
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (!fs.existsSync(filePath)) return map;

    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });

    let isHeader = true;
    for await (const line of rl) {
      if (isHeader) {
        isHeader = false;
        continue;
      }
      if (!line.trim()) continue;
      const cols = line.split('\t');
      if (cols.length >= 2) {
        const id = cols[0].trim();
        const name = cols[1].trim();
        if (id && name) map.set(id, name);
      }
    }
    return map;
  }

  private async loadSupplierLookup(
    filePath: string,
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (!fs.existsSync(filePath)) return map;

    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });

    let isHeader = true;
    for await (const line of rl) {
      if (isHeader) {
        isHeader = false;
        continue;
      }
      if (!line.trim()) continue;
      const cols = line.split('\t');
      if (cols.length >= 2) {
        const id = cols[0].trim();
        const name = cols[1].trim();
        if (id && name) map.set(id, name);
      }
    }
    return map;
  }

  private async processGenericMaster(
    filePath: string,
    formsMap: Map<string, string>,
    routesMap: Map<string, string>,
    substancesMap: Map<string, string>,
    genericLookup: Map<
      string,
      { genericName: string; dosageForm?: string; route?: string }
    >,
    summary: ImportSummary,
    isDryRun: boolean,
  ): Promise<void> {
    if (!fs.existsSync(filePath)) {
      throw new Error(`GenericMaster file not found at: ${filePath}`);
    }

    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });

    let isHeader = true;
    let lineNum = 1;
    const batch: any[] = [];
    const seenIds = new Set<string>();

    for await (const line of rl) {
      lineNum++;
      if (isHeader) {
        isHeader = false;
        continue;
      }
      if (!line.trim()) continue;

      summary.totalGenericProcessed++;
      const cols = this.parseTsvLine(line, 12);
      const identifier = cols[0];
      const genericName = cols[1];

      // Validate required identifier and generic name
      if (!identifier || !genericName) {
        summary.totalRejected++;
        summary.rejectedDetails.push({
          file: 'GenericMaster.txt',
          line: lineNum,
          identifier,
          reason: 'Missing required Identifier or Generic Name',
        });
        continue;
      }

      // Check duplicates within source file
      if (seenIds.has(identifier)) {
        summary.totalRejected++;
        summary.rejectedDetails.push({
          file: 'GenericMaster.txt',
          line: lineNum,
          identifier,
          reason: 'Duplicate Generic Identifier in source file',
        });
        continue;
      }
      seenIds.add(identifier);

      // Substance cross-references (may be compound joined with +)
      const rawSubstanceIds = cols[2] ? cols[2].split('+') : [];
      const substanceIdentifiers: string[] = [];
      const substances: string[] = [];
      for (const sid of rawSubstanceIds) {
        const cleanSid = sid.trim();
        if (cleanSid) {
          substanceIdentifiers.push(cleanSid);
          const sName = substancesMap.get(cleanSid);
          if (sName) substances.push(sName);
        }
      }

      // Route cross-references (may be joined with +)
      const rawRouteIds = cols[3] ? cols[3].split('+') : [];
      const routeIdentifiers: string[] = [];
      const routes: string[] = [];
      for (const rid of rawRouteIds) {
        const cleanRid = rid.trim();
        if (cleanRid) {
          routeIdentifiers.push(cleanRid);
          const rName = routesMap.get(cleanRid);
          if (rName) routes.push(rName);
        }
      }

      // Dose Form cross-reference
      const doseFormId = cols[4] ? cols[4].trim() : null;
      const doseForm = doseFormId ? formsMap.get(doseFormId) || null : null;

      // Extract verified strengths
      const parsedStrength = extractStrengths(genericName);

      // Populate lookup for BrandMaster resolving
      genericLookup.set(identifier, {
        genericName,
        dosageForm: doseForm || undefined,
        route: routes.length > 0 ? routes[0] : undefined,
      });

      if (!isDryRun) {
        batch.push({
          updateOne: {
            filter: { identifier },
            update: {
              $set: {
                identifier,
                genericName,
                substanceIdentifiers,
                substances,
                routeIdentifiers,
                routes,
                doseFormId,
                doseForm,
                strengths: parsedStrength.strengths,
                isCombination: parsedStrength.isCombination,
                isStrengthVerified: parsedStrength.isVerified,
                rawStrengthSummary: parsedStrength.rawSummary,
                releaseType: parsedStrength.releaseType,
                indications: cols[6] || null,
                contraindications: cols[7] || null,
                therapeuticRole: cols[5] || null,
                sourceProvenance: 'CDCI_NRCES_INDIA',
                lastUpdatedOn: cols[11] || null,
              },
            },
            upsert: true,
          },
        });

        if (batch.length >= 1000) {
          await this.genericModel.bulkWrite(batch, { ordered: false });
          summary.totalGenericInserted += batch.length;
          batch.length = 0;
        }
      } else {
        summary.totalGenericInserted++;
      }
    }

    if (!isDryRun && batch.length > 0) {
      await this.genericModel.bulkWrite(batch, { ordered: false });
      summary.totalGenericInserted += batch.length;
    }
  }

  private async processBrandMaster(
    filePath: string,
    productsMap: Map<string, string>,
    suppliersMap: Map<string, string>,
    genericLookup: Map<
      string,
      { genericName: string; dosageForm?: string; route?: string }
    >,
    summary: ImportSummary,
    isDryRun: boolean,
  ): Promise<void> {
    if (!fs.existsSync(filePath)) {
      throw new Error(`BrandMaster file not found at: ${filePath}`);
    }

    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });

    let isHeader = true;
    let lineNum = 1;
    const batch: any[] = [];
    const seenIds = new Set<string>();

    for await (const line of rl) {
      lineNum++;
      if (isHeader) {
        isHeader = false;
        continue;
      }
      if (!line.trim()) continue;

      summary.totalBrandProcessed++;
      const cols = this.parseTsvLine(line, 9);
      const identifier = cols[0];
      const brandName = cols[1];
      const productIdentifier = cols[2];
      const supplierIdentifier = cols[3];
      const genericIdentifier = cols[4];

      // Validate required identifier and brand name
      if (!identifier || !brandName) {
        summary.totalRejected++;
        summary.rejectedDetails.push({
          file: 'BrandMaster.txt',
          line: lineNum,
          identifier,
          reason: 'Missing required Identifier or Brand Name',
        });
        continue;
      }

      // Check duplicates
      if (seenIds.has(identifier)) {
        summary.totalRejected++;
        summary.rejectedDetails.push({
          file: 'BrandMaster.txt',
          line: lineNum,
          identifier,
          reason: 'Duplicate Brand Identifier in source file',
        });
        continue;
      }
      seenIds.add(identifier);

      // Validate Generic Identifier if provided
      const resolvedGeneric = genericIdentifier
        ? genericLookup.get(genericIdentifier)
        : undefined;
      if (genericIdentifier && !resolvedGeneric) {
        summary.totalRejected++;
        summary.rejectedDetails.push({
          file: 'BrandMaster.txt',
          line: lineNum,
          identifier,
          reason: `Referenced Generic Identifier (${genericIdentifier}) does not exist in GenericMaster`,
        });
        continue;
      }

      // Resolve product name and supplier name
      const productName = productIdentifier
        ? productsMap.get(productIdentifier) || null
        : null;
      const supplierName = supplierIdentifier
        ? suppliersMap.get(supplierIdentifier) || null
        : null;

      // Extract verified strengths
      const parsedStrength = extractStrengths(brandName);

      if (!isDryRun) {
        batch.push({
          updateOne: {
            filter: { identifier },
            update: {
              $set: {
                identifier,
                brandName,
                productIdentifier: productIdentifier || null,
                productName,
                supplierIdentifier: supplierIdentifier || null,
                supplierName,
                genericIdentifier: genericIdentifier || null,
                genericName: resolvedGeneric?.genericName || null,
                dosageForm: resolvedGeneric?.dosageForm || null,
                route: resolvedGeneric?.route || null,
                strengths: parsedStrength.strengths,
                isCombination: parsedStrength.isCombination,
                isStrengthVerified: parsedStrength.isVerified,
                rawStrengthSummary: parsedStrength.rawSummary,
                releaseType: parsedStrength.releaseType,
                licenseStatus: cols[6] || 'UNKNOWN',
                excipient: cols[7] || null,
                sourceProvenance: 'CDCI_NRCES_INDIA',
                lastUpdatedOn: cols[8] || null,
              },
            },
            upsert: true,
          },
        });

        if (batch.length >= 1000) {
          await this.brandModel.bulkWrite(batch, { ordered: false });
          summary.totalBrandInserted += batch.length;
          batch.length = 0;
        }
      } else {
        summary.totalBrandInserted++;
      }
    }

    if (!isDryRun && batch.length > 0) {
      await this.brandModel.bulkWrite(batch, { ordered: false });
      summary.totalBrandInserted += batch.length;
    }
  }

  /**
   * Retrieves previous import job history.
   */
  async getImportHistory(limit = 10): Promise<CatalogueImportJobDocument[]> {
    return this.jobModel.find().sort({ startedAt: -1 }).limit(limit).exec();
  }
}
