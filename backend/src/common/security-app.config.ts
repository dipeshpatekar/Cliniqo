import { type INestApplication, ValidationPipe } from "@nestjs/common"
import type { Request, Response, NextFunction } from "express"
import type { ConfigService } from "../config/config.service.js"
import { HttpExceptionFilter } from "./filters/http-exception.filter.js"

/**
 * Applies production security headers, strict DTO validation, exception filtering,
 * and restrictive CORS rules consistently across bootstrap and security tests.
 */
export function configureHttpApp(
  app: INestApplication,
  configService: ConfigService,
): void {
  const httpInstance = app.getHttpAdapter()?.getInstance?.()
  if (httpInstance && typeof httpInstance.disable === "function") {
    httpInstance.disable("x-powered-by")
  }

  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader("X-Content-Type-Options", "nosniff")
    res.setHeader("X-Frame-Options", "DENY")
    res.setHeader("Referrer-Policy", "no-referrer")
    res.setHeader(
      "Permissions-Policy",
      "geolocation=(), microphone=(), camera=()",
    )
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin")
    if (configService.isProduction) {
      res.setHeader(
        "Strict-Transport-Security",
        "max-age=31536000; includeSubDomains",
      )
    }
    if (req.path?.startsWith("/auth")) {
      res.setHeader("Cache-Control", "no-store")
      res.setHeader("Pragma", "no-cache")
    }
    next()
  })

  app.useGlobalFilters(new HttpExceptionFilter())

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )

  const allowedOrigins = configService.corsOrigins
  app.enableCors({
    origin: (
      requestOrigin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      if (!requestOrigin) return callback(null, true)
      if (allowedOrigins.includes(requestOrigin)) {
        return callback(null, true)
      }
      return callback(new Error(`Origin ${requestOrigin} not allowed by CORS`))
    },
    credentials: true,
  })
}
