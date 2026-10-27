#!/usr/bin/env node
/**
 * Safe, idempotent index deployment script for Cliniqo Phase 3 Consultations & Clinical Records domain.
 * Pre-validates existing data for constraint conflicts before creating unique indexes.
 *
 * Usage: node backend/scripts/deploy-consultation-indexes.mjs
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

    // 1. Pre-validate consultations for duplicate active drafts per patient
    const consultationsColl = db.collection('consultations');
    const duplicateDrafts = await consultationsColl
      .aggregate([
        {
          $match: {
            clinicId: { $exists: true },
            patientId: { $exists: true },
            status: 'DRAFT',
          },
        },
        {
          $group: {
            _id: { clinicId: '$clinicId', patientId: '$patientId' },
            count: { $sum: 1 },
            draftIds: { $push: '$_id' },
          },
        },
        { $match: { count: { $gt: 1 } } },
      ])
      .toArray();

    if (duplicateDrafts.length > 0) {
      console.error(
        `[FATAL] Pre-validation failed: Found ${duplicateDrafts.length} patient(s) with multiple active DRAFT consultations.`,
      );
      for (const d of duplicateDrafts) {
        console.error(
          `  -> Clinic ${d._id.clinicId}, Patient ${d._id.patientId}: ${d.count} drafts (IDs: ${d.draftIds.join(', ')})`,
        );
      }
      console.error(
        'Aborting index deployment. Manual clinical reconciliation required. No records were modified or deleted.',
      );
      process.exit(1);
    }

    // 2. Pre-validate consultation_addenda for duplicate sequence numbers
    const addendaColl = db.collection('consultation_addenda');
    const duplicateAddenda = await addendaColl
      .aggregate([
        {
          $match: {
            consultationId: { $exists: true },
            sequenceNumber: { $exists: true },
          },
        },
        {
          $group: {
            _id: {
              consultationId: '$consultationId',
              sequenceNumber: '$sequenceNumber',
            },
            count: { $sum: 1 },
          },
        },
        { $match: { count: { $gt: 1 } } },
      ])
      .toArray();

    if (duplicateAddenda.length > 0) {
      console.error(
        `[FATAL] Pre-validation failed: Found ${duplicateAddenda.length} duplicate addenda sequence(s). Aborting.`,
      );
      process.exit(1);
    }

    // 3. Pre-validate idempotency_records for duplicate keys
    const idempotencyColl = db.collection('idempotency_records');
    const duplicateIdempotency = await idempotencyColl
      .aggregate([
        {
          $match: {
            clinicId: { $exists: true },
            key: { $exists: true },
          },
        },
        {
          $group: {
            _id: { clinicId: '$clinicId', key: '$key' },
            count: { $sum: 1 },
          },
        },
        { $match: { count: { $gt: 1 } } },
      ])
      .toArray();

    if (duplicateIdempotency.length > 0) {
      console.error(
        `[FATAL] Pre-validation failed: Found ${duplicateIdempotency.length} duplicate idempotency key(s). Aborting.`,
      );
      process.exit(1);
    }

    console.log(
      '[INFO] Pre-validation passed with zero conflicts. Creating indexes idempotently...',
    );

    // Deploy indexes for consultations
    await consultationsColl.createIndex(
      { clinicId: 1, patientId: 1 },
      {
        unique: true,
        partialFilterExpression: { status: 'DRAFT' },
        name: 'uniq_active_consultation_draft_per_patient',
      },
    );
    await consultationsColl.createIndex(
      { clinicId: 1, patientId: 1, consultationDate: -1 },
      { name: 'idx_consultation_patient_date' },
    );
    await consultationsColl.createIndex(
      { clinicId: 1, status: 1, consultationDate: -1 },
      { name: 'idx_consultation_status_date' },
    );
    await consultationsColl.createIndex(
      { clinicId: 1, doctorId: 1, consultationDate: -1 },
      { name: 'idx_consultation_doctor_date' },
    );
    await consultationsColl.createIndex(
      { clinicId: 1, patientCode: 1 },
      { name: 'idx_consultation_patient_code' },
    );
    console.log('  -> consultations indexes verified');

    // Deploy indexes for consultation_addenda
    await addendaColl.createIndex(
      { consultationId: 1, sequenceNumber: 1 },
      { unique: true, name: 'uniq_consultation_addendum_sequence' },
    );
    await addendaColl.createIndex(
      { clinicId: 1, createdAt: -1 },
      { name: 'idx_consultation_addenda_clinic_created' },
    );
    console.log('  -> consultation_addenda indexes verified');

    // Deploy indexes for idempotency_records
    await idempotencyColl.createIndex(
      { clinicId: 1, key: 1 },
      { unique: true, name: 'uniq_clinic_idempotency_key' },
    );
    await idempotencyColl.createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0, name: 'idx_idempotency_ttl' },
    );
    console.log('  -> idempotency_records indexes verified');

    console.log(
      '[SUCCESS] All Phase 3 Consultations domain indexes deployed and verified successfully.',
    );
  } finally {
    await mongoose.disconnect();
  }
}

run().catch((err) => {
  console.error(`[ERROR] Index deployment failed: ${err.message}`);
  process.exit(1);
});
