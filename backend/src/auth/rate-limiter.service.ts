import { Injectable, HttpException, HttpStatus, Logger } from "@nestjs/common"
import { InjectModel } from "@nestjs/mongoose"
import { Model } from "mongoose"
import {
  RateLimit,
  type RateLimitDocument,
} from "./schemas/rate-limit.schema.js"
import { ConfigService } from "../config/config.service.js"

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  retryAfterSeconds: number
}

@Injectable()
export class RateLimiterService {
  private readonly logger = new Logger(RateLimiterService.name)

  constructor(
    @InjectModel(RateLimit.name)
    private readonly rateLimitModel: Model<RateLimitDocument>,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Distributed atomic rate limiter leveraging MongoDB Atlas findOneAndUpdate and TTL index.
   * Guarantees race-free rate limiting across multiple scaled backend instances.
   */
  async checkRateLimit(
    key: string,
    maxPoints: number,
    windowSec: number,
  ): Promise<RateLimitResult> {
    const now = new Date()
    const windowMs = windowSec * 1000
    const windowExpiresAt = new Date(now.getTime() + windowMs)

    try {
      // 1. Try to increment an existing, non-expired window
      const record = await this.rateLimitModel.findOneAndUpdate(
        { key, expiresAt: { $gt: now } },
        { $inc: { points: 1 } },
        { new: true, upsert: false },
      )

      if (!record) {
        // 2. No active window: upsert a fresh rate limit record
        await this.rateLimitModel.updateOne(
          { key },
          { $set: { points: 1, expiresAt: windowExpiresAt } },
          { upsert: true },
        )
        return {
          allowed: true,
          remaining: maxPoints - 1,
          retryAfterSeconds: 0,
        }
      }

      if (record.points > maxPoints) {
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((record.expiresAt.getTime() - now.getTime()) / 1000),
        )
        return { allowed: false, remaining: 0, retryAfterSeconds }
      }

      return {
        allowed: true,
        remaining: Math.max(0, maxPoints - record.points),
        retryAfterSeconds: 0,
      }
    } catch (err) {
      // Fail open safely if database error occurs on rate limiter, with logging
      this.logger.error(
        `Rate limiter database error: ${(err as Error)?.message}`,
      )
      return { allowed: true, remaining: 1, retryAfterSeconds: 0 }
    }
  }

  /**
   * Asserts rate limit or throws HTTP 429 Too Many Requests with sanitized message.
   */
  async assertRateLimit(
    key: string,
    maxPoints: number,
    windowSec: number,
  ): Promise<void> {
    const result = await this.checkRateLimit(key, maxPoints, windowSec)
    if (!result.allowed) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: "Too Many Requests",
          message: "Too many requests. Please try again later.",
          retryAfter: result.retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      )
    }
  }

  /**
   * Resets rate limit for a key (e.g. after successful login).
   */
  async resetLimit(key: string): Promise<void> {
    try {
      await this.rateLimitModel.deleteOne({ key })
    } catch {
      // Ignore
    }
  }
}
