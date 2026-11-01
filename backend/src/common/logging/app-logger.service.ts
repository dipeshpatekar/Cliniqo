import { Injectable, LoggerService } from '@nestjs/common';

const SENSITIVE_KEYS = new Set([
  'password',
  'passwordhash',
  'password_hash',
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'authorization',
  'cookie',
  'secret',
  'jwtsecret',
  'jwt_secret',
  'jwt_access_secret',
  'jwt_refresh_secret',
  'resetcode',
  'reset_code',
  'resettoken',
  'reset_token',
  'pin',
  'privatekey',
  'private_key',
  'otp',
  'smtp_pass',
  'smtppass',
  'smtp_password',
  'smtppassword',
  'smtp_user',
  'smtpuser',
  'mongodb_uri',
  'mongodburi',
  'uri',
  'connectionstring',
  'connection_string',
  'db_uri',
  'mongouri',
  'database_url',
  'databaseurl',
]);

const MONGODB_URI_REGEX = /mongodb(\+srv)?:\/\/[^\s"',;)]+/gi;
const PASSWORD_PARAM_REGEX = /(password|pwd|secret)=([^&\s]+)/gi;
const PASSWORD_LEAK_REGEX = /(password|secret|token|pwd)(?:\s*(?:leak|is|:|value)[\s:]*)([^\s"',;)]+)/gi;

export function redactString(str: string): string {
  return str
    .replace(MONGODB_URI_REGEX, '[REDACTED_MONGODB_URI]')
    .replace(PASSWORD_PARAM_REGEX, '$1=[REDACTED]')
    .replace(PASSWORD_LEAK_REGEX, '$1: [REDACTED]');
}

export function redactSensitiveData(data: unknown): unknown {
  if (typeof data === 'string') {
    return redactString(data);
  }

  if (typeof data !== 'object' || data === null) {
    return data;
  }

  if (data instanceof Error) {
    const sanitizedMsg = redactString(data.message);
    const sanitizedStack = data.stack ? redactString(data.stack) : undefined;
    return {
      name: data.name,
      message: sanitizedMsg,
      ...(sanitizedStack ? { stack: sanitizedStack } : {}),
    };
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
    } else if (typeof value === 'string') {
      sanitized[key] = redactString(value);
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
    const formatItem = (item: any): string => {
      if (typeof item === 'string') {
        return redactString(item);
      }
      if (item instanceof Error) {
        return redactString(item.stack || `${item.name}: ${item.message}`);
      }
      if (typeof item === 'object' && item !== null) {
        return JSON.stringify(redactSensitiveData(item));
      }
      return String(item);
    };

    const sanitizedMsg = formatItem(message);
    const sanitizedParams = optionalParams.map(formatItem);
    return [sanitizedMsg, ...sanitizedParams].filter(Boolean).join(' ');
  }
}
