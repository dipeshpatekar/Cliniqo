#!/usr/bin/env node
/**
 * Safe, idempotent index deployment script for Cliniqo Phase 3C Clinic domain.
 * Pre-validates existing data for constraint conflicts before creating unique indexes.
 *
 * Usage: node backend/scripts/deploy-clinic-indexes.mjs
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const backendRoot = path.resolve(__dirname, "..")
const require = createRequire(path.join(backendRoot, "package.json"))
const mongoose = require("mongoose")

// Read backend/.env
const envPath = path.join(backendRoot, ".env")
const env = { ...process.env }
if (fs.existsSync(envPath)) {
  const rawEnv = fs.readFileSync(envPath, "utf8")
  for (const line of rawEnv.split("\n")) {
    const trimmed = line.trim()
    if (trimmed && !trimmed.startsWith("#")) {
      const idx = trimmed.indexOf("=")
      if (idx !== -1) {
        const key = trimmed.slice(0, idx).trim()
        const val = trimmed.slice(idx + 1).trim()
        if (!env[key]) env[key] = val
      }
    }
  }
}

const uri = env.MONGODB_URI
const dbName = env.MONGODB_DB_NAME || "cliniqo"

if (!uri) {
  console.error("[ERROR] MONGODB_URI is required in environment.")
  process.exit(1)
}

const sanitizedUri = uri.replace(/\/\/[^@]+@/, "//[REDACTED_CREDENTIALS]@")
console.log(`[INFO] Connecting to MongoDB: ${sanitizedUri} (DB: ${dbName})`)

async function run() {
  try {
    await mongoose.connect(uri, { dbName })
    const db = mongoose.connection.db

    console.log(
      "[INFO] MongoDB connection established. Pre-validating data for index conflicts...",
    )

    // 1. Pre-validate clinics for duplicate slugs
    const clinicsColl = db.collection("clinics")
    const duplicateSlugs = await clinicsColl
      .aggregate([
        { $match: { slug: { $exists: true, $ne: null } } },
        { $group: { _id: "$slug", count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
      ])
      .toArray()

    if (duplicateSlugs.length > 0) {
      console.error(
        `[FATAL] Pre-validation failed: Found ${duplicateSlugs.length} duplicate slug(s) in clinics collection. Aborting index deployment.`,
      )
      process.exit(1)
    }

    // 2. Pre-validate clinic_memberships for duplicate { clinicId, doctorId }
    const membershipsColl = db.collection("clinic_memberships")
    const duplicateMemberships = await membershipsColl
      .aggregate([
        {
          $match: { clinicId: { $exists: true }, doctorId: { $exists: true } },
        },
        {
          $group: {
            _id: { clinicId: "$clinicId", doctorId: "$doctorId" },
            count: { $sum: 1 },
          },
        },
        { $match: { count: { $gt: 1 } } },
      ])
      .toArray()

    if (duplicateMemberships.length > 0) {
      console.error(
        `[FATAL] Pre-validation failed: Found ${duplicateMemberships.length} duplicate membership(s) in clinic_memberships collection. Aborting index deployment.`,
      )
      process.exit(1)
    }

    // 3. Pre-validate clinic_invitations for duplicate { clinicId, inviteeEmail } with status: 'PENDING'
    const invitationsColl = db.collection("clinic_invitations")
    const duplicatePendingInvites = await invitationsColl
      .aggregate([
        { $match: { status: "PENDING" } },
        {
          $group: {
            _id: { clinicId: "$clinicId", inviteeEmail: "$inviteeEmail" },
            count: { $sum: 1 },
          },
        },
        { $match: { count: { $gt: 1 } } },
      ])
      .toArray()

    if (duplicatePendingInvites.length > 0) {
      console.error(
        `[FATAL] Pre-validation failed: Found ${duplicatePendingInvites.length} duplicate pending invitation(s) in clinic_invitations collection. Aborting index deployment.`,
      )
      process.exit(1)
    }

    console.log(
      "[INFO] Pre-validation passed with zero conflicts. Creating indexes idempotently...",
    )

    // Deploy indexes for clinics
    await clinicsColl.createIndex({ slug: 1 }, {
      unique: true,
      name: "uniq_clinic_slug",
    })
    await clinicsColl.createIndex({ ownerDoctorId: 1 }, {
      name: "idx_clinic_owner",
    })
    await clinicsColl.createIndex({ status: 1 }, { name: "idx_clinic_status" })
    console.log("  -> clinics indexes verified")

    // Deploy indexes for clinic_memberships
    await membershipsColl.createIndex({ clinicId: 1, doctorId: 1 }, {
      unique: true,
      name: "uniq_clinic_membership",
    })
    await membershipsColl.createIndex({ doctorId: 1, status: 1 }, {
      name: "idx_member_doctor_status",
    })
    await membershipsColl.createIndex({ clinicId: 1, role: 1, status: 1 }, {
      name: "idx_member_clinic_role_status",
    })
    console.log("  -> clinic_memberships indexes verified")

    // Deploy indexes for clinic_invitations
    await invitationsColl.createIndex({ clinicId: 1, inviteeEmail: 1 }, {
      unique: true,
      partialFilterExpression: { status: "PENDING" },
      name: "uniq_pending_clinic_invitation",
    })
    await invitationsColl.createIndex({ invitationTokenHash: 1 }, {
      unique: true,
      name: "uniq_invitation_token_hash",
    })
    await invitationsColl.createIndex(
      { inviteeEmail: 1, status: 1, expiresAt: 1 },
      { name: "idx_invitation_email_status_expiry" },
    )
    await invitationsColl.createIndex({ clinicId: 1, status: 1 }, {
      name: "idx_invitation_clinic_status",
    })
    await invitationsColl.createIndex({ retentionExpiresAt: 1 }, {
      expireAfterSeconds: 0,
      sparse: true,
      name: "ttl_invitation_retention",
    })
    console.log("  -> clinic_invitations indexes verified")

    // Deploy indexes for invitation_outbox
    const outboxColl = db.collection("invitation_outbox")
    await outboxColl.createIndex({ status: 1, nextAttemptAt: 1 }, {
      name: "idx_outbox_queue",
    })
    await outboxColl.createIndex({ status: 1, leaseExpiresAt: 1 }, {
      name: "idx_outbox_lease",
    })
    await outboxColl.createIndex({ invitationId: 1 }, {
      name: "idx_outbox_invitation",
    })
    await outboxColl.createIndex({ clinicId: 1, status: 1 }, {
      name: "idx_outbox_clinic_status",
    })
    console.log("  -> invitation_outbox indexes verified")

    // Deploy indexes for clinic_audit_logs
    const auditColl = db.collection("clinic_audit_logs")
    await auditColl.createIndex({ clinicId: 1, timestamp: -1 }, {
      name: "idx_audit_clinic_time",
    })
    await auditColl.createIndex({ actorDoctorId: 1, timestamp: -1 }, {
      name: "idx_audit_actor_time",
    })
    await auditColl.createIndex({ action: 1, timestamp: -1 }, {
      name: "idx_audit_action_time",
    })
    console.log("  -> clinic_audit_logs indexes verified")

    console.log(
      "[SUCCESS] All Phase 3C clinic domain indexes deployed and verified successfully.",
    )
  } finally {
    await mongoose.disconnect()
  }
}

run().catch((err) => {
  console.error(`[ERROR] Index deployment failed: ${err.message}`)
  process.exit(1)
})
