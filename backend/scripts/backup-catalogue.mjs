import fs from "fs";
import path from "path";
import crypto from "crypto";
import mongoose from "mongoose";

const BACKUP_DIR = path.resolve("backend/data/catalogue_backup");

async function backup() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  const envContent = fs.readFileSync("backend/.env", "utf8");
  const uriMatch = envContent.match(/MONGODB_URI=(.+)/);
  if (!uriMatch) throw new Error("MONGODB_URI not found");
  const uri = uriMatch[1].trim();

  console.log("Connecting to MongoDB Atlas [cliniqo_prod]...");
  const conn = await mongoose.connect(uri, { dbName: "cliniqo_prod", serverSelectionTimeoutMS: 20000 });
  const db = conn.connection.db;

  const targetCollections = [
    "catalogue_generics",
    "catalogue_products",
    "catalogue_brands",
    "catalogue_import_jobs"
  ];

  const manifest = {
    timestamp: new Date().toISOString(),
    database: "cliniqo_prod",
    collections: {}
  };

  for (const collName of targetCollections) {
    console.log(`\nExporting [${collName}]...`);
    const coll = db.collection(collName);
    const mongoCount = await coll.countDocuments();
    const outputFile = path.join(BACKUP_DIR, `${collName}.jsonl`);

    const writeStream = fs.createWriteStream(outputFile, { encoding: "utf8" });
    const hash = crypto.createHash("sha256");

    let exportedCount = 0;
    const cursor = coll.find({});
    for await (const doc of cursor) {
      const line = JSON.stringify(doc) + "\n";
      writeStream.write(line);
      hash.update(line);
      exportedCount++;
      if (exportedCount % 25000 === 0) {
        process.stdout.write(`  Exported ${exportedCount} / ${mongoCount}...\r`);
      }
    }
    await new Promise((resolve) => writeStream.end(resolve));

    const sha256 = hash.digest("hex");
    const stat = fs.statSync(outputFile);
    const sizeMB = (stat.size / 1024 / 1024).toFixed(2);

    console.log(`  Done: ${exportedCount} documents exported (${sizeMB} MB), SHA256: ${sha256}`);
    if (exportedCount !== mongoCount) {
      throw new Error(`Count mismatch on ${collName}: mongo has ${mongoCount}, exported ${exportedCount}`);
    }

    manifest.collections[collName] = {
      documentCount: exportedCount,
      fileSizeMB: parseFloat(sizeMB),
      sha256,
      filePath: outputFile
    };
  }

  const manifestPath = path.join(BACKUP_DIR, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  console.log(`\nBackup completed and verified! Manifest written to: ${manifestPath}`);

  await mongoose.disconnect();
}

backup().catch((err) => {
  console.error("Backup failed:", err);
  process.exit(1);
});

