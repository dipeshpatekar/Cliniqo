import "reflect-metadata"
import { describe, it, expect, vi, afterEach } from "vitest"
import { ValidationPipe } from "@nestjs/common"
import { Types } from "mongoose"
import { IsString } from "class-validator"
import { configureHttpApp } from "../common/security-app.config.js"
import { ConfigService } from "../config/config.service.js"
import { AuthService } from "./auth.service.js"
import { CatalogueService } from "../catalogue/catalogue.service.js"
import { ClinicScopeGuard } from "../clinic/guards/clinic-scope.guard.js"
import { NON_CLINICAL_INDEXED_SCHEMAS } from "../database/ensure-indexes.js"
import { DoctorStatus } from "./auth.constants.js"
import { ClinicStatus } from "../clinic/schemas/clinic.schema.js"

class EchoDto {
  @IsString()
  name!: string
}

describe("Phase 5 Security Hardening & Non-Clinical Audit Suite", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("applies OWASP security headers, strips x-powered-by, enforces no-store on /auth, and rejects unknown DTO fields", async () => {
    const configService = new ConfigService({
      NODE_ENV: "production",
      CORS_ORIGIN: "https://app.cliniqo.test",
    })

    const middlewares: Array<(req: any, res: any, next: () => void) => void> = []
    const pipes: ValidationPipe[] = []
    let corsOptions: any = null
    const disabledSettings: string[] = []

    const mockApp: any = {
      getHttpAdapter: () => ({
        getInstance: () => ({
          disable: (setting: string) => disabledSettings.push(setting),
        }),
      }),
      use: (fn: any) => middlewares.push(fn),
      useGlobalFilters: vi.fn(),
      useGlobalPipes: (...p: ValidationPipe[]) => pipes.push(...p),
      enableCors: (opts: any) => {
        corsOptions = opts
      },
    }

    configureHttpApp(mockApp, configService)

    expect(disabledSettings).toContain("x-powered-by")
    expect(middlewares).toHaveLength(1)
    expect(pipes).toHaveLength(1)

    // Verify /auth route sets Cache-Control: no-store and OWASP security headers
    const authHeaders: Record<string, string> = {}
    middlewares[0](
      { path: "/auth/login" },
      { setHeader: (k: string, v: string) => { authHeaders[k] = v } },
      vi.fn(),
    )
    expect(authHeaders["X-Content-Type-Options"]).toBe("nosniff")
    expect(authHeaders["X-Frame-Options"]).toBe("DENY")
    expect(authHeaders["Referrer-Policy"]).toBe("no-referrer")
    expect(authHeaders["Strict-Transport-Security"]).toContain("max-age=31536000")
    expect(authHeaders["Cache-Control"]).toBe("no-store")
    expect(authHeaders["Pragma"]).toBe("no-cache")

    // Verify non-auth route omits Cache-Control: no-store while keeping security headers
    const apiHeaders: Record<string, string> = {}
    middlewares[0](
      { path: "/catalogue/search" },
      { setHeader: (k: string, v: string) => { apiHeaders[k] = v } },
      vi.fn(),
    )
    expect(apiHeaders["Cache-Control"]).toBeUndefined()
    expect(apiHeaders["X-Content-Type-Options"]).toBe("nosniff")

    // Verify restrictive CORS rejects untrusted browser origins and allows configured origins
    const allowConfigured = await new Promise<boolean>((resolve) => {
      corsOptions.origin("https://app.cliniqo.test", (_err: Error | null, ok?: boolean) => resolve(Boolean(ok)))
    })
    expect(allowConfigured).toBe(true)

    const rejectUntrusted = await new Promise<Error | null>((resolve) => {
      corsOptions.origin("https://evil.example.com", (err: Error | null) => resolve(err))
    })
    expect(rejectUntrusted?.message).toContain("not allowed by CORS")

    // Verify global ValidationPipe rejects unknown injected DTO fields
    await expect(
      pipes[0].transform(
        { name: "Dr. Test", injectedAdmin: true },
        { type: "body", metatype: EchoDto },
      ),
    ).rejects.toThrow()
  })

  it("enforces IP rate limiting on both register and refreshToken endpoints", async () => {
    const configService = new ConfigService({
      OTP_HMAC_SECRET: "test-otp-hmac-secret-32-chars-minimum!",
    })
    const mockRateLimiter = {
      assertRateLimit: vi.fn().mockResolvedValue(undefined),
      checkRateLimit: vi.fn(),
      resetLimit: vi.fn(),
    }
    const mockDoctorModel: any = vi.fn().mockImplementation(function (
      this: any,
      d: any,
    ) {
      Object.assign(this, d, {
        _id: new Types.ObjectId(),
        save: vi.fn().mockResolvedValue(true),
      })
    })
    mockDoctorModel.findOne = vi.fn().mockResolvedValue(null)
    const mockTokenService = {
      generateAccessToken: vi.fn().mockResolvedValue("access-jwt"),
      createRefreshSession: vi.fn().mockResolvedValue({ refreshToken: "refresh-1" }),
      rotateRefreshSession: vi.fn().mockResolvedValue({
        accessToken: "access-2",
        refreshToken: "refresh-2",
        tokenType: "Bearer",
        expiresIn: "15m",
      }),
    }
    const authService = new AuthService(
      mockDoctorModel,
      {} as any,
      { hashPassword: vi.fn().mockResolvedValue("argon2hash") } as any,
      mockTokenService as any,
      {} as any,
      mockRateLimiter as any,
      configService,
    )

    await authService.register(
      {
        fullName: "Dr. Security",
        email: "sec@clinic.test",
        password: "StrongPassword#2026",
      } as any,
      { ipAddress: "203.0.113.10" },
    )
    expect(mockRateLimiter.assertRateLimit).toHaveBeenCalledWith(
      "register:ip:203.0.113.10",
      10,
      300,
    )

    await authService.refreshToken(
      { refreshToken: "tok_abc", deviceId: "dev_1" } as any,
      { ipAddress: "203.0.113.10" },
    )
    expect(mockRateLimiter.assertRateLimit).toHaveBeenCalledWith(
      "refresh:ip:203.0.113.10",
      30,
      60,
    )
  })

  it("enforces cross-tenant isolation via ClinicScopeGuard for non-members", async () => {
    const clinicId = new Types.ObjectId()
    const doctorId = new Types.ObjectId()
    const guard = new ClinicScopeGuard(
      { getAllAndOverride: vi.fn().mockReturnValue(undefined) } as any,
      {
        findById: vi.fn().mockResolvedValue({
          _id: clinicId,
          status: ClinicStatus.ACTIVE,
        }),
      } as any,
      { findOne: vi.fn().mockResolvedValue(null) } as any,
    )

    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({
          user: { _id: doctorId, status: DoctorStatus.ACTIVE },
          params: { clinicId: clinicId.toString() },
          headers: {},
        }),
      }),
      getHandler: () => ({ name: "listMembers" }),
      getClass: () => class {},
    } as any

    await expect(guard.canActivate(ctx)).rejects.toThrow(
      "You are not an active member of this clinic.",
    )
  })

  it("safely escapes formulation regex (ReDoS protection) and uses estimatedDocumentCount on getFeed", async () => {
    const mockGenericModel = {
      find: vi.fn().mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([]),
      }),
      countDocuments: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(0) }),
      estimatedDocumentCount: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(120) }),
    }
    const mockBrandModel = {
      find: vi.fn().mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([]),
      }),
      countDocuments: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(0) }),
      estimatedDocumentCount: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(300) }),
    }

    const service = new CatalogueService(
      mockGenericModel as any,
      mockBrandModel as any,
    )

    const res = await service.search({
      q: "paracetamol",
      formulation: "(a+)+$[",
      limit: 10,
      page: 1,
    })
    expect(res.items).toEqual([])

    const feed = await service.getFeed(undefined, 50)
    expect(feed.total).toBe(420)
    expect(mockGenericModel.estimatedDocumentCount).toHaveBeenCalled()
    expect(mockBrandModel.estimatedDocumentCount).toHaveBeenCalled()
  })

  it("ensures non-clinical production index registry excludes clinical patient/consultation/prescription/invoice models", () => {
    const names = NON_CLINICAL_INDEXED_SCHEMAS.map((s) => s.name)
    expect(names).not.toContain("Patient")
    expect(names).not.toContain("Consultation")
    expect(names).not.toContain("Prescription")
    expect(names).not.toContain("PrescriptionRevision")
    expect(names).not.toContain("Invoice")
    expect(names).toContain("Doctor")
    expect(names).toContain("RefreshSession")
    expect(names).toContain("ClinicMembership")
    expect(names).toContain("FormularyItem")
  })
})
