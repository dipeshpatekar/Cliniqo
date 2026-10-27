#!/usr/bin/env node
/**
 * Safe, idempotent index deployment script for Cliniqo Phase 3 Prescriptions & Immutable Revision Engine domain.
 * Pre-validates existing data for constraint conflicts before creating unique indexes.
 *
 * Usage: node backend/scripts/deploy-prescription-indexes.mjs
 *
 * NOTE: DO NOT EXECUTE AGAINST ATLAS/PRODUCTION DURING DEVELOPMENT.
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

    console.log(
      '[INFO] MongoDB connection established. Pre-validating data for index conflicts...',
    );

    // 1. Pre-validate prescriptions for duplicate active prescriptions per consultation
    const prescriptionsColl = db.collection('prescriptions');
    const duplicateActiveRx = await prescriptionsColl
      .aggregate([
        {
          $match: {
            clinicId: { $exists: true },
            consultationId: { $exists: true },
            status: 'ACTIVE',
          },
        },
        {
          $group: {
            _id: { clinicId: '$clinicId', consultationId: '$consultationId' },
            count: { $sum: 1 },
            rxIds: { $push: '$_id' },
          },
        },
        { $match: { count: { $gt: 1 } } },
      ])
      .toArray();

    if (duplicateActiveRx.length > 0) {
      console.error(
        `[FATAL] Pre-validation failed: Found ${duplicateActiveRx.length} consultation(s) with multiple active prescriptions.`,
      );
      for (const d of duplicateActiveRx) {
        console.error(
          `  -> Clinic ${d._id.clinicId}, Consultation ${d._id.consultationId}: ${d.count} active prescriptions (IDs: ${d.rxIds.join(', ')})`,
        );
      }
      console.error(
        'Aborting index deployment. Clinical reconciliation required. No records were modified or deleted.',
      );
      process.exit(1);
    }

    // 2. Pre-validate prescriptions for duplicate prescription numbers per clinic
    const duplicateRxNumbers = await prescriptionsColl
      .aggregate([
        {
          $match: {
            clinicId: { $exists: true },
            prescriptionNumber: { $exists: true },
          },
        },
        {
          $group: {
            _id: { clinicId: '$clinicId', prescriptionNumber: '$prescriptionNumber' },
            count: { $sum: 1 },
            rxIds: { $push: '$_id' },
          },
        },
        { $match: { count: { $gt: 1 } } },
      ])
      .toArray();

    if (duplicateRxNumbers.length > 0) {
      console.error(
        `[FATAL] Pre-validation failed: Found ${duplicateRxNumbers.length} duplicate prescription number(s). Aborting.`,
      );
      for (const d of duplicateRxNumbers) {
        console.error(
          `  -> Clinic ${d._id.clinicId}, Number ${d._id.prescriptionNumber}: ${d.count} records (IDs: ${d.rxIds.join(', ')})`,
        );
      }
      process.exit(1);
    }

    // 3. Pre-validate prescription_revisions for duplicate revision sequences
    const revisionsColl = db.collection('prescription_revisions');
    const duplicateRevisions = await revisionsColl
      .aggregate([
        {
          $match: {
            prescriptionId: { $exists: true },
            revisionNumber: { $exists: true },
          },
        },
        {
          $group: {
            _id: {
              prescriptionId: '$prescriptionId',
              revisionNumber: '$revisionNumber',
            },
            count: { $sum: 1 },
          },
        },
        { $match: { count: { $gt: 1 } } },
      ])
      .toArray();

    if (duplicateRevisions.length > 0) {
      console.error(
        `[FATAL] Pre-validation failed: Found ${duplicateRevisions.length} duplicate revision sequence(s). Aborting.`,
      );
      process.exit(1);
    }

    // 4. Pre-validate clinic_counters for duplicate sequences
    const countersColl = db.collection('clinic_counters');
    const duplicateCounters = await countersColl
      .aggregate([
        {
          $match: {
            clinicId: { $exists: true },
            sequenceName: { $exists: true },
          },
        },
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
        `[FATAL] Pre-validation failed: Found ${duplicateCounters.length} duplicate counter sequence(s). Aborting.`,
      );
      process.exit(1);
    }

    console.log(
      '[INFO] Pre-validation passed with zero conflicts. Creating indexes idempotently...',
    );

    // Deploy indexes for prescriptions
    await prescriptionsColl.createIndex(
      { clinicId: 1, consultationId: 1 },
      {
        unique: true,
        partialFilterExpression: { status: 'ACTIVE' },
        name: 'uniq_active_prescription_per_consultation',
      },
    );
    await prescriptionsColl.createIndex(
      { clinicId: 1, prescriptionNumber: 1 },
      {
        unique: true,
        name: 'uniq_clinic_prescription_number',
      },
    );
    await prescriptionsColl.createIndex(
      { clinicId: 1, patientId: 1, createdAt: -1 },
      { name: 'idx_prescription_patient_created' },
    );
    await prescriptionsColl.createIndex(
      { clinicId: 1, status: 1, createdAt: -1 },
      { name: 'idx_prescription_status_created' },
    );
    console.log('  -> prescriptions indexes verified');

    // Deploy indexes for prescription_revisions
    await revisionsColl.createIndex(
      { prescriptionId: 1, revisionNumber: 1 },
      {
        unique: true,
        name: 'uniq_prescription_revision_sequence',
      },
    );
    await revisionsColl.createIndex(
      { clinicId: 1, createdAt: -1 },
      { name: 'idx_prescription_revision_clinic_created' },
    );
    console.log('  -> prescription_revisions indexes verified');

    // Deploy indexes for clinic_counters
    await countersColl.createIndex(
      { clinicId: 1, sequenceName: 1 },
      {
        unique: true,
        name: 'uniq_clinic_sequence_counter',
      },
    );
    console.log('  -> clinic_counters indexes verified');

    console.log(
      '[SUCCESS] All Phase 3 Prescriptions domain indexes deployed and verified successfully.',
    );
  } finally {
    await mongoose.disconnect();
  }
}

run().catch((err) => {
  console.error(`[ERROR] Index deployment failed: ${err.message}`);
  process.exit(1);
});
