import { Injectable, LoggerService } from '@nestjs/common';

const SENSITIVE_KEYS = new Set([
  'password',
  'token',
  'refreshtoken',
  'authorization',
  'cookie',
  'secret',
  'otp',
  'mongodb_uri',
]);

export function redactSensitiveData(data: unknown): unknown {
  if (typeof data !== 'object' || data === null) {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map(redactSensitiveData);
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = redactSensitiveData(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

@Injectable()
export class AppLogger implements LoggerService {
  log(message: any, ...optionalParams: any[]) {
    console.log(`[INFO] ${this.format(message, optionalParams)}`);
  }

  error(message: any, ...optionalParams: any[]) {
    console.error(`[ERROR] ${this.format(message, optionalParams)}`);
  }

  warn(message: any, ...optionalParams: any[]) {
    console.warn(`[WARN] ${this.format(message, optionalParams)}`);
  }

  debug?(message: any, ...optionalParams: any[]) {
    console.debug(`[DEBUG] ${this.format(message, optionalParams)}`);
  }

  private format(message: any, optionalParams: any[]): string {
    const sanitizedMsg = typeof message === 'object' ? JSON.stringify(redactSensitiveData(message)) : message;
    const sanitizedParams = optionalParams.map((p) =>
      typeof p === 'object' ? JSON.stringify(redactSensitiveData(p)) : p,
    );
    return [sanitizedMsg, ...sanitizedParams].filter(Boolean).join(' ');
  }
}
