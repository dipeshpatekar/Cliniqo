import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CatalogueImportService } from '../dist/catalogue/catalogue-import.service.js';
import { CatalogueGenericSchema } from '../dist/catalogue/schemas/catalogue-generic.schema.js';
import { CatalogueBrandSchema } from '../dist/catalogue/schemas/catalogue-brand.schema.js';
import { CatalogueImportJobSchema } from '../dist/catalogue/schemas/catalogue-import-job.schema.js';
import { CatalogueProductSchema } from '../dist/catalogue/schemas/catalogue-product.schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const envPath = path.resolve(__dirname, '..', '.env');
  const envContent = fs.readFileSync(envPath, 'utf8');
  const uriMatch = envContent.match(/MONGODB_URI=(.+)/);
  if (!uriMatch) {
    throw new Error('MONGODB_URI not found in backend/.env');
  }
  const uri = uriMatch[1].trim();
  const dbName = 'cliniqo_prod';

  console.log(`Connecting to MongoDB Atlas database [${dbName}]...`);
  const conn = await mongoose.connect(uri, {
    dbName,
    serverSelectionTimeoutMS: 15000,
    connectTimeoutMS: 15000,
  });
  console.log('Connected to MongoDB Atlas successfully.');

  const genericModel = conn.model('CatalogueGeneric', CatalogueGenericSchema);
  const brandModel = conn.model('CatalogueBrand', CatalogueBrandSchema);
  const jobModel = conn.model('CatalogueImportJob', CatalogueImportJobSchema);
  const productModel = conn.model('CatalogueProduct', CatalogueProductSchema);

  const initialGenerics = await genericModel.countDocuments();
  const initialBrands = await brandModel.countDocuments();
  const initialProducts = await productModel.countDocuments();
  console.log(`Initial Atlas counts - Generics: ${initialGenerics}, Brands: ${initialBrands}, Products: ${initialProducts}`);

  const service = new CatalogueImportService(
    genericModel,
    brandModel,
    jobModel,
    productModel
  );

  const sourceDir = path.resolve(__dirname, '..', 'data', 'cdci', 'CommonDrugCodesForIndia_FlatFilePackage');
  console.log(`Starting real CDCI import from: ${sourceDir}`);
  const summary = await service.runImport({ sourcePath: sourceDir, dryRun: false });

  console.log('\n--- CDCI ATLAS IMPORT SUMMARY ---');
  console.log('Status:', summary.status);
  console.log('Duration (ms):', summary.durationMs);
  console.log('Generics processed:', summary.totalGenericProcessed);
  console.log('Generics inserted/upserted:', summary.totalGenericInserted);
  console.log('Brands processed:', summary.totalBrandProcessed);
  console.log('Brands inserted/upserted:', summary.totalBrandInserted);
  console.log('Products inserted/upserted:', summary.totalProductInserted);
  console.log('Rows rejected:', summary.totalRejected);
  if (summary.error) {
    console.error('Import error:', summary.error);
  }

  const finalGenerics = await genericModel.countDocuments();
  const finalBrands = await brandModel.countDocuments();
  const finalProducts = await productModel.countDocuments();
  console.log(`\nVerified final Atlas counts - Generics: ${finalGenerics}, Brands: ${finalBrands}, Products: ${finalProducts}`);

  await mongoose.disconnect();
  console.log('Disconnected from MongoDB Atlas.');
}

main().catch((err) => {
  console.error('Fatal error during CDCI import:', err);
  process.exit(1);
});
