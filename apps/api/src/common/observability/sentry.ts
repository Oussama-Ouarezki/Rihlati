import * as Sentry from '@sentry/node';
import type { AppConfig } from '../../config/env';
import { redact } from '../logging/logger';

/**
 * ERROR REPORTING — rule #4
 *
 * Works with Sentry.io or a self-hosted GlitchTip (same protocol, same DSN
 * format) — Decision 017 picks GlitchTip, and nothing here has to change if
 * you switch.
 *
 * No DSN configured = a no-op. That is what makes local development and CI
 * silent, while `loadConfig()` refuses to boot production without one.
 *
 * The `beforeSend` hook is the important part of this file. Rule #4 forbids
 * sending tokens, passwords, OTPs and full phone numbers anywhere — and an
 * error tracker is "anywhere". A crash report naturally carries the request
 * body that caused it, which for this app means a traveler's phone number, so
 * everything leaving here goes through the SAME redaction as the logs.
 */
export function initSentry(config: AppConfig): boolean {
  if (!config.SENTRY_DSN) return false;

  Sentry.init({
    dsn: config.SENTRY_DSN,
    environment: config.NODE_ENV,

    // Errors always; traces sampled. 10% in production is plenty to spot a
    // slow endpoint and costs a fraction of the events.
    tracesSampleRate: config.isProduction ? 0.1 : 0,

    // Never attach the request body or headers automatically — see beforeSend.
    // We add exactly the context we chose, in the exception filter.
    sendDefaultPii: false,

    beforeSend(event) {
      // Belt and braces on top of sendDefaultPii: redact() masks phones and
      // strips tokens/passwords/secrets by key name, and it is the same
      // function the logger uses, so the two can never drift.
      if (event.request) {
        event.request = redact(event.request) as typeof event.request;
      }
      if (event.extra) {
        event.extra = redact(event.extra) as typeof event.extra;
      }
      if (event.contexts) {
        event.contexts = redact(event.contexts) as typeof event.contexts;
      }
      return event;
    },
  });

  return true;
}

/**
 * Report an unexpected error. Called from the exception filter for genuine
 * bugs only — a 404 or a validation failure is the app working correctly, and
 * flooding the tracker with those is how people learn to ignore it.
 */
export function captureException(
  error: unknown,
  context: { requestId: string; userId?: string; route?: string },
): void {
  Sentry.withScope((scope) => {
    scope.setTag('requestId', context.requestId);
    if (context.route) scope.setTag('route', context.route);
    // The user id, never the email or phone — enough to find the person in
    // the database, nothing that identifies them inside Sentry.
    if (context.userId) scope.setUser({ id: context.userId });
    Sentry.captureException(error);
  });
}

export async function flushSentry(timeoutMs = 2000): Promise<void> {
  await Sentry.flush(timeoutMs).catch(() => undefined);
}
