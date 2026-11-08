import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { HealthService } from "./health.service.js"
import type { Connection } from "mongoose"

describe("HealthService", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe("Liveness Check (getLiveness)", () => {
    it("should return status ok and valid uptime with no connection provided", () => {
      const service = new HealthService()
      const result = service.getLiveness()
      expect(result.status).toBe("ok")
      expect(typeof result.uptime).toBe("number")
      expect(typeof result.timestamp).toBe("string")
    })

    it("should remain healthy and independent when database connection is disconnected (readyState 0)", () => {
      const mockConn = { readyState: 0 } as unknown as Connection
      const service = new HealthService(mockConn)
      const result = service.getLiveness()
      expect(result.status).toBe("ok")
    })

    it("should remain healthy when database is in an error or timeout state", () => {
      const mockConn = {
        readyState: 1,
        db: {
          admin: () => ({
            ping: () =>
              Promise.reject(
                new Error("MongoServerSelectionError: connection timeout"),
              ),
          }),
        },
      } as unknown as Connection
      const service = new HealthService(mockConn)
      const result = service.getLiveness()
      expect(result.status).toBe("ok")
    })
  })

  describe("Readiness Check (getReadiness)", () => {
    it("should return not_ready and database unavailable when connection is undefined", async () => {
      const service = new HealthService(undefined)
      const result = await service.getReadiness()
      expect(result.status).toBe("not_ready")
      expect(result.checks.process).toBe("ok")
      expect(result.checks.database).toBe("unavailable")
    })

    it("should return not_ready when connection readyState is 0 (disconnected)", async () => {
      const mockConn = { readyState: 0 } as unknown as Connection
      const service = new HealthService(mockConn)
      const result = await service.getReadiness()
      expect(result.status).toBe("not_ready")
      expect(result.checks.database).toBe("unavailable")
    })

    it("should return not_ready when connection readyState is 2 (connecting)", async () => {
      const mockConn = { readyState: 2 } as unknown as Connection
      const service = new HealthService(mockConn)
      const result = await service.getReadiness()
      expect(result.status).toBe("not_ready")
      expect(result.checks.database).toBe("unavailable")
    })

    it("should return not_ready when connection readyState is 3 (disconnecting)", async () => {
      const mockConn = { readyState: 3 } as unknown as Connection
      const service = new HealthService(mockConn)
      const result = await service.getReadiness()
      expect(result.status).toBe("not_ready")
      expect(result.checks.database).toBe("unavailable")
    })

    it("should return not_ready when connection has no db object", async () => {
      const mockConn = {
        readyState: 1,
        db: undefined,
      } as unknown as Connection
      const service = new HealthService(mockConn)
      const result = await service.getReadiness()
      expect(result.status).toBe("not_ready")
      expect(result.checks.database).toBe("unavailable")
    })

    it("should return not_ready when ping rejects or encounters network failure", async () => {
      const mockConn = {
        readyState: 1,
        db: {
          admin: () => ({
            ping: () =>
              Promise.reject(
                new Error(
                  "MongoNetworkTimeoutException: timed out after 5000 ms",
                ),
              ),
          }),
        },
      } as unknown as Connection
      const service = new HealthService(mockConn)
      const result = await service.getReadiness()
      expect(result.status).toBe("not_ready")
      expect(result.checks.database).toBe("unavailable")
      // Assert sanitized payload does not leak host or error message
      expect(JSON.stringify(result)).not.toContain(
        "MongoNetworkTimeoutException",
      )
    })

    it("should return not_ready when database ping times out (>2000ms)", async () => {
      const mockConn = {
        readyState: 1,
        db: {
          admin: () => ({
            ping: () =>
              new Promise((resolve) =>
                setTimeout(() => resolve({ ok: 1 }), 5000),
              ),
          }),
        },
      } as unknown as Connection
      const service = new HealthService(mockConn)

      const readinessPromise = service.getReadiness()
      // Advance timers by 2000ms to trigger the timeout
      await vi.advanceTimersByTimeAsync(2050)

      const result = await readinessPromise
      expect(result.status).toBe("not_ready")
      expect(result.checks.database).toBe("unavailable")
    })

    it("should return ready and database ok when connected and ping succeeds", async () => {
      const mockConn = {
        readyState: 1,
        db: {
          admin: () => ({
            ping: () => Promise.resolve({ ok: 1 }),
          }),
        },
      } as unknown as Connection
      const service = new HealthService(mockConn)
      const result = await service.getReadiness()
      expect(result.status).toBe("ready")
      expect(result.checks.process).toBe("ok")
      expect(result.checks.database).toBe("ok")
    })

    it("should not expose hostnames, credentials, or internal errors in readiness output", async () => {
      const mockConn = {
        readyState: 1,
        db: {
          admin: () => ({
            ping: () =>
              Promise.reject(
                new Error(
                  "getaddrinfo ENOTFOUND cluster0.mongodb.net user=admin:secretpass",
                ),
              ),
          }),
        },
      } as unknown as Connection
      const service = new HealthService(mockConn)
      const result = await service.getReadiness()
      const output = JSON.stringify(result)

      expect(output).not.toContain("cluster0.mongodb.net")
      expect(output).not.toContain("secretpass")
      expect(output).not.toContain("ENOTFOUND")
      expect(output).not.toContain("Error")
      expect(result.checks.database).toBe("unavailable")
    })

    it("should reflect database reconnection and recover to ready after an outage", async () => {
      let currentReadyState = 0 // Starts disconnected
      let canPing = false

      const dynamicConn = {
        get readyState() {
          return currentReadyState
        },
        db: {
          admin: () => ({
            ping: () =>
              canPing
                ? Promise.resolve({ ok: 1 })
                : Promise.reject(new Error("Connection lost")),
          }),
        },
      } as unknown as Connection

      const service = new HealthService(dynamicConn)

      // Phase 1: Disconnected outage
      const beforeReconnect = await service.getReadiness()
      expect(beforeReconnect.status).toBe("not_ready")
      expect(beforeReconnect.checks.database).toBe("unavailable")
      expect(service.getLiveness().status).toBe("ok") // Liveness remains ok

      // Phase 2: Database reconnects
      currentReadyState = 1
      canPing = true

      const afterReconnect = await service.getReadiness()
      expect(afterReconnect.status).toBe("ready")
      expect(afterReconnect.checks.database).toBe("ok")
      expect(service.getLiveness().status).toBe("ok")
    })
  })
})
