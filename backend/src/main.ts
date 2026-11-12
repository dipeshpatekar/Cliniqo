import { NestFactory } from "@nestjs/core"
import { ValidationPipe } from "@nestjs/common"
import { AppModule } from "./app.module.js"
import { ConfigService } from "./config/config.service.js"
import { HttpExceptionFilter } from "./common/filters/http-exception.filter.js"
import { AppLogger } from "./common/logging/app-logger.service.js"

async function bootstrap() {
  // Automatically load local .env file in Node 20+ environments if present
  if (typeof process.loadEnvFile === "function") {
    try {
      process.loadEnvFile(".env")
    } catch {
      // Gracefully ignore if .env file does not exist
    }
  }

  const logger = new AppLogger()
  const app = await NestFactory.create(AppModule, { logger })

  // Enable shutdown hooks for graceful database disconnection
  app.enableShutdownHooks()

  const configService = app.get(ConfigService)
  // Fail startup if database or auth configuration is invalid fail-closed
  configService.validateDatabaseConfig()
  configService.validateAuthConfig()
  if (configService.isProduction) {
    configService.validateOutboxConfig()
    configService.validateEmailConfig()
  }

  // Centralized safe exception handling
  app.useGlobalFilters(new HttpExceptionFilter())

  // Enforce runtime DTO validation, transformation, and rejection of unexpected fields
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )

  // Restrictive CORS using validated legitimate origins without wildcards
  const allowedOrigins = configService.corsOrigins
  app.enableCors({
    origin: (
      requestOrigin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      // Allow requests with no origin (like native desktop apps, mobile, curl)
      if (!requestOrigin) return callback(null, true)
      if (allowedOrigins.includes(requestOrigin)) {
        return callback(null, true)
      }
      return callback(new Error(`Origin ${requestOrigin} not allowed by CORS`))
    },
    credentials: true,
  })

  const port = configService.port
  await app.listen(port, "0.0.0.0")
  logger.log(
    `Cliniqo Backend listening on port ${port} in ${configService.nodeEnv} mode`,
  )
}

await bootstrap()
