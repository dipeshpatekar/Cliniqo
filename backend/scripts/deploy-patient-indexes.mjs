#!/usr/bin/env node
/**
 * Safe, idempotent index deployment script for Cliniqo Phase 3 Patient domain.
 * Pre-validates existing data for constraint conflicts before creating unique indexes.
 *
 * Usage: node backend/scripts/deploy-patient-indexes.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, '..');
const require = createRequire(path.join(backendRoot, 'package.json'));
const mongoose = require('mongoose');

// Read backend/.env
const envPath = path.join(backendRoot, '.env');
const env = { ...process.env };
if (fs.existsSync(envPath)) {
  const rawEnv = fs.readFileSync(envPath, 'utf8');
  for (const line of rawEnv.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const idx = trimmed.indexOf('=');
      if (idx !== -1) {
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim();
        if (!env[key]) env[key] = val;
      }
    }
  }
}

const uri = env.MONGODB_URI;
const dbName = env.MONGODB_DB_NAME || 'cliniqo';

if (!uri) {
  console.error('[ERROR] MONGODB_URI is required in environment.');
  process.exit(1);
}

const sanitizedUri = uri.replace(/\/\/[^@]+@/, '//[REDACTED_CREDENTIALS]@');
console.log(`[INFO] Connecting to MongoDB: ${sanitizedUri} (DB: ${dbName})`);

async function run() {
  try {
    await mongoose.connect(uri, { dbName });
    const db = mongoose.connection.db;

    console.log('[INFO] MongoDB connection established. Pre-validating data for index conflicts...');

    // 1. Pre-validate patients for duplicate { clinicId, patientId }
    const patientsColl = db.collection('patients');
    const duplicatePatientIds = await patientsColl
      .aggregate([
        { $match: { clinicId: { $exists: true }, patientId: { $exists: true } } },
        {
          $group: {
            _id: { clinicId: '$clinicId', patientId: '$patientId' },
            count: { $sum: 1 },
          },
        },
        { $match: { count: { $gt: 1 } } },
      ])
      .toArray();

    if (duplicatePatientIds.length > 0) {
      console.error(
        `[FATAL] Pre-validation failed: Found ${duplicatePatientIds.length} duplicate patientId(s) in patients collection. Aborting index deployment.`,
      );
      process.exit(1);
    }

    // 2. Pre-validate clinic_counters for duplicate { clinicId, sequenceName }
    const countersColl = db.collection('clinic_counters');
    const duplicateCounters = await countersColl
      .aggregate([
        { $match: { clinicId: { $exists: true }, sequenceName: { $exists: true } } },
        {
          $group: {
            _id: { clinicId: '$clinicId', sequenceName: '$sequenceName' },
            count: { $sum: 1 },
          },
        },
        { $match: { count: { $gt: 1 } } },
      ])
      .toArray();

    if (duplicateCounters.length > 0) {
      console.error(
        `[FATAL] Pre-validation failed: Found ${duplicateCounters.length} duplicate counter(s) in clinic_counters collection. Aborting index deployment.`,
      );
      process.exit(1);
    }

    console.log('[INFO] Pre-validation passed with zero conflicts. Creating indexes idempotently...');

    // Deploy indexes for patients
    await patientsColl.createIndex(
      { clinicId: 1, patientId: 1 },
      { unique: true, name: 'uniq_patient_clinic_id' },
    );
    await patientsColl.createIndex(
      { clinicId: 1, normalizedPhone: 1, status: 1 },
      { name: 'idx_patient_phone_status' },
    );
    await patientsColl.createIndex(
      { clinicId: 1, status: 1, name: 1 },
      { name: 'idx_patient_status_name' },
    );
    await patientsColl.createIndex(
      { clinicId: 1, status: 1, createdAt: -1 },
      { name: 'idx_patient_status_created' },
    );
    console.log('  -> patients indexes verified');

    // Deploy indexes for clinic_counters
    await countersColl.createIndex(
      { clinicId: 1, sequenceName: 1 },
      { unique: true, name: 'uniq_clinic_sequence_counter' },
    );
    console.log('  -> clinic_counters indexes verified');

    console.log('[SUCCESS] All Phase 3 Patient domain indexes deployed and verified successfully.');
  } finally {
    await mongoose.disconnect();
  }
}

run().catch((err) => {
  console.error(`[ERROR] Index deployment failed: ${err.message}`);
  process.exit(1);
});
