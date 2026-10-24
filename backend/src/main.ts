import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { ConfigService } from './config/config.service.js';
import { HttpExceptionFilter } from './common/filters/http-exception.filter.js';
import { AppLogger } from './common/logging/app-logger.service.js';

async function bootstrap() {
  const logger = new AppLogger();
  const app = await NestFactory.create(AppModule, { logger });

  const configService = app.get(ConfigService);

  // Centralized safe exception handling
  app.useGlobalFilters(new HttpExceptionFilter());

  // Restrictive CORS using validated environment origin
  app.enableCors({
    origin: configService.corsOrigin,
    credentials: true,
  });

  const port = configService.port;
  await app.listen(port);
  logger.log(`Cliniqo Backend listening on port ${port} in ${configService.nodeEnv} mode`);
}

await bootstrap();
