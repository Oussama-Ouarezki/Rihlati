import 'reflect-metadata';
import path from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { APP_CONFIG, loadConfig, type AppConfig } from './config/env';
import { AppLogger } from './common/logging/logger';
import { flushSentry, initSentry } from './common/observability/sentry';

/**
 * Load `.env` from the repo root so `npm run dev:api` just works.
 *
 * Deliberately here in main.ts and NOT inside `loadConfig()`: the tests build
 * the app with `Test.createTestingModule` and never run this file, so they
 * keep full control of their own environment. A loader inside `loadConfig()`
 * could re-read `.env` mid-test and point `DATABASE_URL` back at the
 * DEVELOPMENT database — which the suite then truncates. Not a risk worth
 * taking for a convenience.
 *
 * Real environment variables always win in production; this file simply is
 * not there.
 */
try {
  process.loadEnvFile(path.resolve(__dirname, '../../../.env'));
} catch {
  /* production / CI injects real environment variables */
}

async function bootstrap(): Promise<void> {
  // Before Nest, so a crash during startup is reported too — the window
  // where a bad deploy fails is exactly the window you most want covered.
  const sentryEnabled = initSentry(loadConfig());

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Our own JSON logger takes over as soon as it is available; Nest's
    // coloured startup logs are fine until then.
    bufferLogs: false,
  });

  const config = app.get<AppConfig>(APP_CONFIG);
  const logger = app.get(AppLogger);

  /**
   * Trust exactly one proxy hop.
   *
   * `trust proxy: true` (the tempting one) tells Express to believe the whole
   * `X-Forwarded-For` chain — which any client can write. Rate limits and IP
   * hashes would then be based on an attacker-supplied value. One hop is right
   * when the API sits behind a single load balancer; change it if your
   * deployment adds another, and never set it to `true`.
   */
  app.set('trust proxy', 1);

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

  /**
   * CORS: an explicit allow-list, no wildcard, credentials off.
   *
   * The API authenticates with a Bearer token in a header, not with a cookie,
   * so `credentials: true` is not needed — and leaving it off means a hostile
   * site cannot ride along on a logged-in browser session (no CSRF surface).
   */
  app.enableCors({
    origin: config.corsOrigins,
    credentials: false,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'Accept-Language'],
    exposedHeaders: ['X-Request-Id'],
    maxAge: 86_400,
  });

  // 1 MB. An offer with 20 media URLs is a few KB; anything near this ceiling
  // is either a bug or someone probing for a memory exhaustion bug.
  app.useBodyParser('json', { limit: '1mb' });

  app.setGlobalPrefix('v1', { exclude: ['health', 'media/*key'] });
  app.enableShutdownHooks();

  await app.listen(config.API_PORT, '0.0.0.0');

  logger.info('api started', {
    port: config.API_PORT,
    env: config.NODE_ENV,
    corsOrigins: config.corsOrigins,
    sentry: sentryEnabled,
  });

  // In-flight error reports must reach the tracker before the process dies —
  // otherwise the crash that killed it is the one you never see.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void flushSentry().then(() => process.exit(0));
    });
  }
}

bootstrap().catch((error: unknown) => {
  // Boot failures happen before the logger exists, so this one goes to stderr
  // raw. A misconfigured .env is the usual cause and the message says so.
  process.stderr.write(
    `${JSON.stringify({
      level: 'error',
      time: new Date().toISOString(),
      msg: 'api failed to start',
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exit(1);
});
