import fs from "fs";
import readline from "readline";
import path from "path";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
const { MongoClient } = mongoose.mongo;

const BACKUP_DIR = path.resolve("data/catalogue_backup");

async function runRestoreVerification() {
  console.log("=== STARTING ISOLATED RESTORE VERIFICATION TEST ===");
  console.log("Target Database: EPHEMERAL IN-MEMORY MONGODB (isolated, zero connection to Atlas/prod)");

  // 1. Start ephemeral in-memory MongoDB
  const mongod = await MongoMemoryServer.create({
    instance: {
      dbName: "cliniqo_restore_test"
    }
  });
  const uri = mongod.getUri();
  console.log("Ephemeral MongoDB running at:", uri);

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db("cliniqo_restore_test");

  const expectedCounts = {
    catalogue_generics: 10305,
    catalogue_products: 72284,
    catalogue_brands: 93903,
    catalogue_import_jobs: 2
  };

  const results = {};

  for (const [collName, expectedCount] of Object.entries(expectedCounts)) {
    console.log(`\nRestoring [${collName}] into isolated database...`);
    const filePath = path.join(BACKUP_DIR, `${collName}.jsonl`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Backup file missing: ${filePath}`);
    }

    const coll = db.collection(collName);
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    let batch = [];
    let count = 0;

    for await (const line of rl) {
      if (!line.trim()) continue;
      const doc = JSON.parse(line);
      batch.push(doc);
      if (batch.length >= 5000) {
        await coll.insertMany(batch);
        count += batch.length;
        process.stdout.write(`  Restored ${count} / ${expectedCount}...\r`);
        batch = [];
      }
    }
    if (batch.length > 0) {
      await coll.insertMany(batch);
      count += batch.length;
    }

    const actualDbCount = await coll.countDocuments();
    console.log(`  Restored ${actualDbCount} documents (Expected: ${expectedCount})`);
    if (actualDbCount !== expectedCount) {
      throw new Error(`Count mismatch for ${collName}: expected ${expectedCount}, got ${actualDbCount}`);
    }
    results[collName] = actualDbCount;
  }

  console.log("\n=== VERIFYING REPRESENTATIVE DOCUMENTS & RELATIONSHIPS ===");

  // 1. Verify a generic document
  const sampleGeneric = await db.collection("catalogue_generics").findOne({ identifier: { $exists: true } });
  console.log("\nSample Restored Generic:", {
    identifier: sampleGeneric.identifier,
    genericName: sampleGeneric.genericName,
    doseForm: sampleGeneric.doseForm,
    routes: sampleGeneric.routes,
    strengthsCount: sampleGeneric.strengths?.length,
    isCombination: sampleGeneric.isCombination
  });

  // 2. Verify a product document
  const sampleProduct = await db.collection("catalogue_products").findOne({ identifier: { $exists: true } });
  console.log("\nSample Restored Product:", {
    identifier: sampleProduct.identifier,
    productName: sampleProduct.productName,
    sourceProvenance: sampleProduct.sourceProvenance
  });

  // 3. Verify a brand document and its relationships
  const sampleBrand = await db.collection("catalogue_brands").findOne({
    productIdentifier: { $exists: true, $ne: "" },
    genericIdentifier: { $exists: true, $ne: "" }
  });
  console.log("\nSample Restored Brand:", {
    identifier: sampleBrand.identifier,
    brandName: sampleBrand.brandName,
    genericName: sampleBrand.genericName,
    productIdentifier: sampleBrand.productIdentifier,
    genericIdentifier: sampleBrand.genericIdentifier,
    supplierName: sampleBrand.supplierName,
    rawStrengthSummary: sampleBrand.rawStrengthSummary
  });

  // 4. Verify referential integrity between restored collections
  const linkedProduct = await db.collection("catalogue_products").findOne({ identifier: sampleBrand.productIdentifier });
  console.log("\nReferenced Product Lookup for Brand:", {
    found: !!linkedProduct,
    productName: linkedProduct?.productName
  });
  if (!linkedProduct) {
    throw new Error(`Referenced product not found in restored catalogue_products: ${sampleBrand.productIdentifier}`);
  }

  const linkedGeneric = await db.collection("catalogue_generics").findOne({ identifier: sampleBrand.genericIdentifier });
  console.log("Referenced Generic Lookup for Brand:", {
    found: !!linkedGeneric,
    genericName: linkedGeneric?.genericName
  });
  if (!linkedGeneric) {
    throw new Error(`Referenced generic not found in restored catalogue_generics: ${sampleBrand.genericIdentifier}`);
  }

  // 5. Verify import job document
  const importJobs = await db.collection("catalogue_import_jobs").find({}).toArray();
  console.log("\nRestored Catalogue Import Jobs:", importJobs.map(j => ({
    jobId: j.jobId,
    status: j.status,
    totalGenericInserted: j.totalGenericInserted,
    totalBrandInserted: j.totalBrandInserted,
    startedAt: j.startedAt
  })));

  await client.close();
  await mongod.stop();

  console.log("\nISOLATED RESTORE TEST COMPLETE AND 100% VERIFIED!");
  console.log("Summary of Restored Counts:");
  for (const [k, v] of Object.entries(results)) {
    console.log(`  - ${k}: ${v}`);
  }
}

runRestoreVerification().catch((err) => {
  console.error("Restore verification failed:", err);
  process.exit(1);
});
