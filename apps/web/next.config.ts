import path from 'node:path';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

/**
 * Load the MONOREPO-ROOT `.env`.
 *
 * Next only looks for `.env` beside the app it is building — `apps/web/.env`,
 * which does not exist. This project keeps one `.env` at the root (one file to
 * gitignore, one file to get wrong), so it has to be loaded explicitly, the
 * same way `prisma.config.ts` and `playwright.config.ts` do it.
 *
 * This must run before the config is exported: `NEXT_PUBLIC_*` values are
 * inlined into the browser bundle at build time, and they are read from
 * `process.env` at exactly that moment.
 */
try {
  process.loadEnvFile(path.resolve(process.cwd(), '../../.env'));
} catch {
  /* CI and production inject real environment variables */
}

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const config: NextConfig = {
  // Offer photos come from arbitrary agency URLs for now, so pages use plain
  // <img>. When uploads move to our R2 bucket, switch to next/image and list
  // that single domain here — an allowlist only makes sense once there is a
  // domain we control to allow.
};

export default withNextIntl(config);
