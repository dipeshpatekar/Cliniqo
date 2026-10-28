import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { CatalogueImportService } from './catalogue-import.service.js';

describe('CatalogueImportService', () => {
  let service: CatalogueImportService;
  let mockGenericModel: any;
  let mockBrandModel: any;
  let mockJobModel: any;
  const originalEnv = process.env.CDCI_DATA_DIR;

  beforeEach(() => {
    mockGenericModel = {
      bulkWrite: vi.fn().mockResolvedValue({ upsertedCount: 1 }),
      countDocuments: vi.fn().mockResolvedValue(100),
    };
    mockBrandModel = {
      bulkWrite: vi.fn().mockResolvedValue({ upsertedCount: 1 }),
      countDocuments: vi.fn().mockResolvedValue(500),
    };

    function MockJob(this: any, doc: any) {
      Object.assign(this, doc);
      this.save = vi.fn().mockResolvedValue(this);
    }
    MockJob.create = vi.fn().mockResolvedValue({ jobId: 'job_test_1' });
    MockJob.find = vi.fn().mockReturnValue({
      sort: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          exec: vi.fn().mockResolvedValue([
            { jobId: 'job_test_1', status: 'COMPLETED' },
          ]),
        }),
      }),
    });
    mockJobModel = MockJob as any;

    service = new CatalogueImportService(
      mockGenericModel,
      mockBrandModel,
      mockJobModel,
    );
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.CDCI_DATA_DIR = originalEnv;
    } else {
      delete process.env.CDCI_DATA_DIR;
    }
  });

  describe('resolveSourcePath', () => {
    it('resolves workspace data/cdci directory or Downloads fallback', () => {
      const p = service.resolveSourcePath();
      expect(p).toContain('CommonDrugCodesForIndia_FlatFilePackage');
      expect(path.isAbsolute(p)).toBe(true);
    });

    it('prioritizes CDCI_DATA_DIR environment variable when set', () => {
      const customEnvDir = path.resolve('custom', 'ci', 'cdci-package');
      process.env.CDCI_DATA_DIR = customEnvDir;
      const p = service.resolveSourcePath();
      expect(p).toBe(customEnvDir);
      expect(path.isAbsolute(p)).toBe(true);
      expect(p).not.toContain('CommonDrugCodesForIndia_FlatFilePackage');

      // Explicit argument must take precedence over CDCI_DATA_DIR
      const explicitDir = path.resolve('explicit', 'cdci-package');
      expect(service.resolveSourcePath(explicitDir)).toBe(explicitDir);
    });

    it('resolves tilde in custom path', () => {
      const p = service.resolveSourcePath('~/my-folder');
      expect(p).toBe(path.join(process.env.HOME || '', 'my-folder'));
    });

    it('resolves relative path to absolute', () => {
      const p = service.resolveSourcePath('./custom-data');
      expect(path.isAbsolute(p)).toBe(true);
    });
  });

  describe('parseTsvLine', () => {
    it('handles trailing tabs without dropping fields', () => {
      const line = 'G1001\tParacetamol 500 mg Tablet\tOral\t';
      const cols = service.parseTsvLine(line, 3);
      expect(cols[0]).toBe('G1001');
      expect(cols[1]).toBe('Paracetamol 500 mg Tablet');
      expect(cols[2]).toBe('Oral');
    });

    it('pads missing columns up to minCols', () => {
      const line = 'B1001\tDolo';
      const cols = service.parseTsvLine(line, 5);
      expect(cols.length).toBe(5);
      expect(cols[0]).toBe('B1001');
      expect(cols[1]).toBe('Dolo');
      expect(cols[2]).toBe('');
      expect(cols[3]).toBe('');
      expect(cols[4]).toBe('');
    });
  });

  describe('runImport (Validation & Dry Run)', () => {
    it('returns FAILED status if source directory does not exist', async () => {
      const res = await service.runImport({
        sourcePath: '/path/does/not/exist/at/all',
        dryRun: true,
      });

      expect(res.status).toBe('FAILED');
      expect(res.error).toContain('directory not found');
      expect(res.isDryRun).toBe(true);
    });

    it('fails with a clear error message if any required CDCI files are missing', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdci_incomplete_'));

      try {
        // Only create 1 file, leaving the other 6 missing
        fs.writeFileSync(path.join(tmpDir, 'GenericMaster.txt'), 'Header\n');

        const res = await service.runImport({
          sourcePath: tmpDir,
          dryRun: true,
        });

        expect(res.status).toBe('FAILED');
        expect(res.error).toContain('incomplete');
        expect(res.error).toContain('Missing required file(s):');
        expect(res.error).toContain('BrandMaster.txt');
        expect(res.error).toContain('README.md');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('processes mini fixture files in dry-run mode without invoking bulkWrite', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdci_test_'));

      try {
        // Provide all 7 required files
        fs.writeFileSync(
          path.join(tmpDir, 'DrugFormMaster.txt'),
          'Identifier\tTerm\nDF1\tTablet\n',
        );
        fs.writeFileSync(
          path.join(tmpDir, 'RouteOfAdministrationMaster.txt'),
          'Identifier\tTerm\nROA1\tOral\n',
        );
        fs.writeFileSync(
          path.join(tmpDir, 'SubstanceMaster.txt'),
          'Identifier\tTerm\nS1\tParacetamol\n',
        );
        fs.writeFileSync(
          path.join(tmpDir, 'SupplierMaster.txt'),
          'Identifier\tTerm\nSUP1\tMicro Labs\n',
        );
        fs.writeFileSync(
          path.join(tmpDir, 'ProductMaster.txt'),
          'Identifier\tTerm\nP1\tParacetamol 500 mg Tablet\n',
        );
        fs.writeFileSync(
          path.join(tmpDir, 'GenericMaster.txt'),
          'Identifier\tGeneric Name\tProduct Count\tDose Form Identifier\tRoutes\tSubstances\tlast_updated_on\n' +
            'G1\tParacetamol 500 mg Tablet\t1\tDF1\tOral\tParacetamol\t2023-01-01\n',
        );
        fs.writeFileSync(
          path.join(tmpDir, 'BrandMaster.txt'),
          'Identifier\tBrand Name\tProduct Identifier\tSupplier Identifier\tGeneric Identifier\tLicense Number\tLicense Status\tExcipient\tlast_updated_on\n' +
            'B1\tDolo 500\tP1\tSUP1\tG1\tL1\tACTIVE\tNone\t2023-01-01\n' +
            'B2\tOrphanBrand\tP2\tSUP1\tG_NONEXISTENT\tL2\tACTIVE\tNone\t2023-01-01\n',
        );

        const res = await service.runImport({
          sourcePath: tmpDir,
          dryRun: true,
        });

        expect(res.status).toBe('COMPLETED');
        expect(res.isDryRun).toBe(true);
        expect(res.totalGenericProcessed).toBe(1);
        expect(res.totalBrandProcessed).toBe(2);
        expect(res.totalRejected).toBe(1); // G_NONEXISTENT rejected
        expect(res.rejectedDetails[0].reason).toContain('does not exist');

        // bulkWrite should NOT have been called in dry-run mode
        expect(mockGenericModel.bulkWrite).not.toHaveBeenCalled();
        expect(mockBrandModel.bulkWrite).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('getImportHistory', () => {
    it('returns jobs list from database', async () => {
      const history = await service.getImportHistory();
      expect(history.length).toBe(1);
      expect(history[0].jobId).toBe('job_test_1');
    });
  });
});
