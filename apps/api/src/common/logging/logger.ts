import { Inject, Injectable, Scope } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/env';

/**
 * STRUCTURED LOGGING (rule #4)
 *
 * One JSON object per line. Not because JSON is pretty — it is not — but
 * because `grep "requestId":"abc"` across a million lines is the difference
 * between finding a user's failed request in 10 seconds and not finding it.
 *
 * The redaction below is not optional politeness. Rule #4 forbids logging
 * tokens, passwords, OTP codes, full phone numbers and payment identifiers,
 * and the only reliable way to enforce that is to strip them at the exit,
 * not to trust every future caller to remember.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

/** Keys whose values never reach the log, whatever they contain. */
const REDACTED_KEYS = new Set([
  'password', 'passwordhash', 'currentpassword', 'newpassword',
  'token', 'accesstoken', 'refreshtoken', 'tokenhash', 'authorization',
  'secret', 'apikey', 'otp', 'code', 'pin',
  'cookie', 'setcookie', 'sessionid',
  'nif', 'registrecommerce', 'cardnumber', 'cvv', 'iban',
]);

/** Keys that hold a phone number: masked rather than dropped, so logs stay useful. */
const PHONE_KEYS = new Set(['phone', 'contactphone', 'whatsapp', 'identifier', 'msisdn']);

function maskPhoneValue(value: string): string {
  if (value.length < 6) return '•••';
  return `${value.slice(0, 4)}${'•'.repeat(Math.max(0, value.length - 8))}${value.slice(-4)}`;
}

/** Depth-limited so a cyclic or enormous object cannot hang the logger. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]';
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
  if (typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/[-_]/g, '');
    if (REDACTED_KEYS.has(normalized)) {
      out[key] = '[redacted]';
    } else if (PHONE_KEYS.has(normalized) && typeof val === 'string') {
      out[key] = maskPhoneValue(val);
    } else {
      out[key] = redact(val, depth + 1);
    }
  }
  return out;
}

export interface LogContext {
  requestId?: string;
  userId?: string;
  agencyId?: string;
  [key: string]: unknown;
}

@Injectable({ scope: Scope.DEFAULT })
export class AppLogger {
  private readonly threshold: number;
  private readonly pretty: boolean;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.threshold = LEVELS[config.LOG_LEVEL];
    this.pretty = !config.isProduction;
  }

  debug(message: string, context?: LogContext): void {
    this.write('debug', message, context);
  }
  info(message: string, context?: LogContext): void {
    this.write('info', message, context);
  }
  warn(message: string, context?: LogContext): void {
    this.write('warn', message, context);
  }
  error(message: string, context?: LogContext): void {
    this.write('error', message, context);
  }

  private write(level: LogLevel, message: string, context?: LogContext): void {
    if (LEVELS[level] < this.threshold) return;

    const entry = {
      level,
      time: new Date().toISOString(),
      msg: message,
      ...(redact(context ?? {}) as Record<string, unknown>),
    };

    const line = this.pretty ? JSON.stringify(entry, null, 0) : JSON.stringify(entry);
    if (level === 'error' || level === 'warn') {
      process.stderr.write(`${line}\n`);
    } else {
      process.stdout.write(`${line}\n`);
    }
  }
}
