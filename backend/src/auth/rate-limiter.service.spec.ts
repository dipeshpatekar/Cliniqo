import { describe, it, expect, beforeEach, vi } from "vitest"
import { HttpException, HttpStatus } from "@nestjs/common"
import { RateLimiterService } from "./rate-limiter.service.js"
import { ConfigService } from "../config/config.service.js"

describe("RateLimiterService", () => {
  let service: RateLimiterService
  let mockRateLimitModel: any
  let configService: ConfigService

  beforeEach(() => {
    configService = new ConfigService({})
    mockRateLimitModel = {
      findOneAndUpdate: vi.fn(),
      updateOne: vi.fn(),
      deleteOne: vi.fn(),
    }
    service = new RateLimiterService(mockRateLimitModel, configService)
  })

  it("should allow first request in a new window and upsert record", async () => {
    mockRateLimitModel.findOneAndUpdate.mockResolvedValue(null)
    mockRateLimitModel.updateOne.mockResolvedValue({ acknowledged: true })

    const result = await service.checkRateLimit("login:ip:127.0.0.1", 5, 60)

    expect(result.allowed).toBe(true)
    expect(result.remaining).toBe(4)
    expect(mockRateLimitModel.updateOne).toHaveBeenCalledWith(
      { key: "login:ip:127.0.0.1" },
      expect.objectContaining({
        $set: expect.objectContaining({ points: 1 }),
      }),
      { upsert: true },
    )
  })

  it("should allow consecutive attempts within threshold and increment points", async () => {
    const futureExpiry = new Date(Date.now() + 30000)
    mockRateLimitModel.findOneAndUpdate.mockResolvedValue({
      points: 3,
      expiresAt: futureExpiry,
    })

    const result = await service.checkRateLimit("login:ip:127.0.0.1", 5, 60)

    expect(result.allowed).toBe(true)
    expect(result.remaining).toBe(2)
  })

  it("should reject requests exceeding max threshold and compute retryAfterSeconds", async () => {
    const futureExpiry = new Date(Date.now() + 45000)
    mockRateLimitModel.findOneAndUpdate.mockResolvedValue({
      points: 6, // Exceeds max 5
      expiresAt: futureExpiry,
    })

    const result = await service.checkRateLimit("login:ip:127.0.0.1", 5, 60)

    expect(result.allowed).toBe(false)
    expect(result.remaining).toBe(0)
    expect(result.retryAfterSeconds).toBeGreaterThan(0)
  })

  it("should throw HTTP 429 when assertRateLimit is exceeded", async () => {
    const futureExpiry = new Date(Date.now() + 20000)
    mockRateLimitModel.findOneAndUpdate.mockResolvedValue({
      points: 6,
      expiresAt: futureExpiry,
    })

    try {
      await service.assertRateLimit("login:ip:10.0.0.1", 5, 60)
      expect.fail("Should have thrown HTTP 429")
    } catch (err: any) {
      expect(err).toBeInstanceOf(HttpException)
      expect(err.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS)
      const res = err.getResponse()
      expect(res.error).toBe("Too Many Requests")
      expect(res.retryAfter).toBeGreaterThan(0)
    }
  })

  it("should fail open safely if database error occurs", async () => {
    mockRateLimitModel.findOneAndUpdate.mockRejectedValue(
      new Error("Mongo network timeout"),
    )

    const result = await service.checkRateLimit("login:ip:127.0.0.1", 5, 60)
    expect(result.allowed).toBe(true)
  })

  it("should delete key on resetLimit", async () => {
    mockRateLimitModel.deleteOne.mockResolvedValue({ deletedCount: 1 })
    await service.resetLimit("login:ip:127.0.0.1")
    expect(mockRateLimitModel.deleteOne).toHaveBeenCalledWith({
      key: "login:ip:127.0.0.1",
    })
  })
})
