import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CatalogueGenericSchema } from '../dist/catalogue/schemas/catalogue-generic.schema.js';
import { CatalogueBrandSchema } from '../dist/catalogue/schemas/catalogue-brand.schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function verifyAtoZ() {
  const envPath = path.resolve(__dirname, '..', '.env');
  const envContent = fs.readFileSync(envPath, 'utf8');
  const uri = envContent.match(/MONGODB_URI=(.+)/)[1].trim();
  const dbName = 'cliniqo_prod';

  const conn = await mongoose.connect(uri, {
    dbName,
    serverSelectionTimeoutMS: 20000,
  });

  const genericModel = conn.model('CatalogueGeneric', CatalogueGenericSchema);
  const brandModel = conn.model('CatalogueBrand', CatalogueBrandSchema);

  const letters = 'abcdefghijklmnopqrstuvwxyz'.split('');
  console.log('| Letter | MongoDB Brands (Prefix) | Sample Brand Match | Formulation | Sample Strength | MongoDB Generics | Sample Generic Match |');
  console.log('|---|---:|---|---|---|---:|---|');

  for (const letter of letters) {
    const brandRegex = new RegExp(`^${letter}`, 'i');
    const genericRegex = new RegExp(`^${letter}`, 'i');

    const [brandCount, sampleBrand, genericCount, sampleGeneric] = await Promise.all([
      brandModel.countDocuments({ brandName: brandRegex }),
      brandModel.findOne({ brandName: brandRegex, dosageForm: /tablet/i }).lean(),
      genericModel.countDocuments({ genericName: genericRegex }),
      genericModel.findOne({ genericName: genericRegex }).lean(),
    ]);

    const fallbackBrand = sampleBrand || await brandModel.findOne({ brandName: brandRegex }).lean();

    const brandName = fallbackBrand?.brandName || 'N/A';
    const form = fallbackBrand?.dosageForm || 'N/A';
    const strength = fallbackBrand?.rawStrengthSummary || 'N/A';
    const genName = sampleGeneric?.genericName ? sampleGeneric.genericName.slice(0, 35) + '...' : 'N/A';

    console.log(`| **${letter.toUpperCase()}** | ${brandCount.toLocaleString()} | ${brandName} | ${form} | ${strength} | ${genericCount.toLocaleString()} | ${genName} |`);
  }

  await mongoose.disconnect();
}

verifyAtoZ().catch(console.error);

