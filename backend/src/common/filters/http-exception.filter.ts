import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

export interface ErrorResponsePayload {
  statusCode: number;
  error: string;
  message: string | string[];
  timestamp: string;
  path: string;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const isHttpException = exception instanceof HttpException;
    const status = isHttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    let errorName = 'Internal Server Error';
    let message: string | string[] = 'An unexpected error occurred';

    if (isHttpException) {
      const res = exception.getResponse();
      if (typeof res === 'string') {
        message = res;
        errorName = exception.name;
      } else if (typeof res === 'object' && res !== null) {
        const body = res as Record<string, any>;
        message = body.message || exception.message;
        errorName = body.error || exception.name;
      }
    } else {
      // Unhandled internal error: log full error internally, but NEVER leak stack trace to client
      const err = exception as Error;
      this.logger.error(
        `Unhandled exception on ${request?.method} ${request?.url}: ${err?.message}`,
        err?.stack,
      );
      message = 'An unexpected internal error occurred';
    }

    const payload: ErrorResponsePayload = {
      statusCode: status,
      error: errorName,
      message,
      timestamp: new Date().toISOString(),
      path: request?.url || '',
    };

    response.status(status).json(payload);
  }
}
