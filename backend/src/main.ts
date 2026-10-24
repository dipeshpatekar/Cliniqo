import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module.js';
import { ConfigService } from './config/config.service.js';
import { HttpExceptionFilter } from './common/filters/http-exception.filter.js';
import { AppLogger } from './common/logging/app-logger.service.js';

async function bootstrap() {
  // Automatically load local .env file in Node 20+ environments if present
  if (typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile('.env');
    } catch {
      // Gracefully ignore if .env file does not exist
    }
  }

  const logger = new AppLogger();
  const app = await NestFactory.create(AppModule, { logger });

  // Enable shutdown hooks for graceful database disconnection
  app.enableShutdownHooks();

  const configService = app.get(ConfigService);

  // Centralized safe exception handling
  app.useGlobalFilters(new HttpExceptionFilter());

  // Enforce runtime DTO validation, transformation, and rejection of unexpected fields
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Restrictive CORS using validated environment origin
  app.enableCors({
    origin: configService.corsOrigin,
    credentials: true,
  });

  const port = configService.port;
  await app.listen(port);
  logger.log(
    `Cliniqo Backend listening on port ${port} in ${configService.nodeEnv} mode`,
  );
}

await bootstrap();
