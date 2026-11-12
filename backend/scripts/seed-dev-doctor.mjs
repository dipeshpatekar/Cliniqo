import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const backendRoot = path.resolve(__dirname, "..")
const require = createRequire(path.join(backendRoot, "package.json"))

const mongoose = require("mongoose")
const argon2 = require("argon2")

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
        if (!env[key]) {
          env[key] = val
        }
      }
    }
  }
}

// 1. Production safety guard: strictly forbid running in production
if (process.env.NODE_ENV === "production" || env.NODE_ENV === "production") {
  console.error(
    "[SECURITY ERROR] Dev doctor provisioning script cannot run in production.",
  )
  process.exit(1)
}

const targetEmail = (process.argv[2] || "dipeshpatekar2507@gmail.com")
  .trim()
  .toLowerCase()
const fullName = process.argv[3] || "Dr. Dipesh Patekar"

async function seedDoctor() {
  const mongoUri = env.MONGODB_URI
  const dbName = env.MONGODB_DB_NAME || "cliniqo_dev"

  if (!mongoUri) {
    console.error("[ERROR] MONGODB_URI is not set in environment or .env")
    process.exit(1)
  }

  console.log(`Connecting to MongoDB (${dbName})...`)
  await mongoose.connect(mongoUri, {
    dbName,
    serverSelectionTimeoutMS: 5000,
  })

  const db = mongoose.connection.db
  const doctors = db.collection("doctors")

  const existingDoctor = await doctors.findOne({ email: targetEmail })

  if (existingDoctor) {
    console.log(
      `[INFO] Doctor with email "${targetEmail}" already exists (id="${existingDoctor._id}", status="${existingDoctor.status}"). Existing account was NOT modified.`,
    )
    await mongoose.disconnect()
    return
  } else {
    // Generate a secure temporary password meeting the policy (16 bytes random + special chars)
    const rawPass = crypto.randomBytes(16).toString("hex") + "!Aa9"
    const passwordHash = await argon2.hash(rawPass, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4,
    })

    const now = new Date()
    const result = await doctors.insertOne({
      email: targetEmail,
      passwordHash,
      fullName,
      status: "ACTIVE",
      failedLoginAttempts: 0,
      lockUntil: null,
      createdAt: now,
      updatedAt: now,
    })

    console.log(
      `[SUCCESS] Created dev doctor account: id="${result.insertedId}", email="${targetEmail}", status="ACTIVE"`,
    )
  }

  await mongoose.disconnect()
}

seedDoctor().catch((err) => {
  console.error("[ERROR] Failed to seed dev doctor:", err.message)
  process.exit(1)
})
