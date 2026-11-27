import { NestFactory } from "@nestjs/core"
import { AppModule } from "./app.module.js"
import { ConfigService } from "./config/config.service.js"
import { AppLogger } from "./common/logging/app-logger.service.js"
import { configureHttpApp } from "./common/security-app.config.js"

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

  configureHttpApp(app, configService)

  const port = configService.port
  await app.listen(port, "0.0.0.0")
  logger.log(
    `Cliniqo Backend listening on port ${port} in ${configService.nodeEnv} mode`,
  )
}

await bootstrap()
