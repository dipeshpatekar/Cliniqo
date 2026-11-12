import { describe, it, expect, afterAll } from "vitest"
import mongoose from "mongoose"
import type { Connection } from "mongoose"
import fs from "node:fs"
import path from "node:path"
import { ConfigService } from "../src/config/config.service.js"
import { HealthService } from "../src/health/health.service.js"

function getEffectiveEnv(): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...process.env }
  const envPath = path.resolve(process.cwd(), ".env")
  if (fs.existsSync(envPath)) {
    const raw = fs.readFileSync(envPath, "utf8")
    for (const line of raw.split("\n")) {
      const trimmed = line.trim()
      if (trimmed && !trimmed.startsWith("#")) {
        const idx = trimmed.indexOf("=")
        if (idx !== -1) {
          const key = trimmed.slice(0, idx).trim()
          const val = trimmed.slice(idx + 1).trim()
          if (!merged[key]) {
            merged[key] = val
          }
        }
      }
    }
  }
  return merged
}

const effectiveEnv = getEffectiveEnv()
const isLiveTestEnabled =
  effectiveEnv.TEST_LIVE_MONGODB === "true" && Boolean(effectiveEnv.MONGODB_URI)

describe("Live MongoDB Atlas Integration (OPT-IN ONLY)", () => {
  let connection: Connection | null = null

  describe.skipIf(!isLiveTestEnabled)(
    "Verified Live Atlas Connectivity",
    () => {
      afterAll(async () => {
        if (connection && connection.readyState !== 0) {
          await connection.close(false)
        }
      })

      it("should connect to live MongoDB cluster, ping database, and verify health readiness", async () => {
        const configService = new ConfigService(effectiveEnv)
        const { uri, dbName } = configService.validateDatabaseConfig()

        // Connect with strict timeout settings
        const mongooseInstance = await mongoose.connect(uri, {
          dbName,
          serverSelectionTimeoutMS: 5000,
          connectTimeoutMS: 5000,
        })

        connection = mongooseInstance.connection

        // Verify connection state is connected (1)
        expect(connection.readyState).toBe(1)

        // Verify live ping
        const pingResult = await connection.db!.admin().ping()
        expect(pingResult.ok).toBe(1)

        // Verify HealthService reports ready
        const healthService = new HealthService(connection)
        const readiness = await healthService.getReadiness()
        expect(readiness.status).toBe("ready")
        expect(readiness.checks.database).toBe("ok")
        expect(readiness.checks.process).toBe("ok")
      }, 15000)
    },
  )

  describe.skipIf(isLiveTestEnabled)("Live Integration Guard", () => {
    it("skips live database connection tests by default when TEST_LIVE_MONGODB is not set", () => {
      expect(isLiveTestEnabled).toBe(false)
    })
  })
})
