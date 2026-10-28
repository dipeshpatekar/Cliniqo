import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import { CatalogueImportService } from './catalogue-import.service.js';

describe('CDCI Real Dataset Dry-Run Verification', () => {
  it('runs streaming dry-run on CDCI package and validates counts and rejection handling', async () => {
    const mockGenericModel: any = {
      bulkWrite: vi.fn().mockResolvedValue({}),
      countDocuments: vi.fn().mockResolvedValue(0),
    };
    const mockBrandModel: any = {
      bulkWrite: vi.fn().mockResolvedValue({}),
      countDocuments: vi.fn().mockResolvedValue(0),
    };
    const mockJobModel: any = {
      create: vi.fn().mockResolvedValue({}),
      find: vi.fn().mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([]),
      }),
    };

    const service = new CatalogueImportService(
      mockGenericModel,
      mockBrandModel,
      mockJobModel,
    );

    const defaultPath = service.resolveSourcePath();
    if (!fs.existsSync(defaultPath)) {
      console.log(`CDCI package not present at ${defaultPath}, skipping real dataset verification.`);
      return;
    }

    const summary = await service.runImport({ dryRun: true });

    expect(summary.status).toBe('COMPLETED');
    expect(summary.isDryRun).toBe(true);
    expect(summary.totalGenericProcessed).toBeGreaterThan(10000);
    expect(summary.totalBrandProcessed).toBeGreaterThan(90000);
    expect(summary.totalRejected).toBeGreaterThan(0); // Captures known orphaned brand references without crashing

    console.log('--- CDCI ACTUAL IMPORT STATS ---');
    console.log(`Generics Processed: ${summary.totalGenericProcessed}`);
    console.log(`Brands Processed: ${summary.totalBrandProcessed}`);
    console.log(`Total Rows Rejected: ${summary.totalRejected}`);
    console.log(`Sample Rejection Reason: ${summary.rejectedDetails[0]?.reason}`);
    console.log(`Execution Duration: ${summary.durationMs}ms`);
  }, 60000);
});
