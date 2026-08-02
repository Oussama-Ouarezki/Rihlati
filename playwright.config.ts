import { defineConfig, devices } from '@playwright/test';

// Load `.env` here rather than relying on the shell: `npm run test:e2e` does
// not source it, and the API refuses to boot without DATABASE_URL and its
// JWT secrets. CI injects real environment variables instead, so a missing
// file is not an error.
try {
  process.loadEnvFile();
} catch {
  /* CI */
}

/**
 * Rule #7: "Playwright covers the five pages that matter: search, offer
 * detail, inquiry submission, agency lead inbox, login. Screenshot/visual
 * assertions on each."
 *
 * These are the pages where a silent regression costs money — nobody notices
 * a broken settings page for a week, but a broken inquiry form is every
 * conversion lost until someone complains.
 *
 * Both servers must be running. `webServer` starts them if they are not, and
 * reuses yours if they are.
 */
const WEB_PORT = Number(process.env['E2E_WEB_PORT'] ?? 3200);
const API_PORT = Number(process.env['E2E_API_PORT'] ?? 4200);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 1 : 0,
  workers: 1,
  reporter: process.env['CI'] ? 'github' : 'list',

  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    // French is the default locale; the Arabic RTL check sets its own.
    locale: 'fr-DZ',
  },

  expect: {
    toHaveScreenshot: {
      // Font rendering differs by a hair between machines. 1% of pixels is
      // loose enough not to cry wolf, tight enough to catch a layout that
      // actually moved.
      maxDiffPixelRatio: 0.01,
    },
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: [
    {
      command: `node apps/api/dist/main.js`,
      port: API_PORT,
      // Fresh processes every run, deliberately: the rate limiters are
      // in-memory, so a reused server carries over "5 inquiries per hour"
      // from the last run and the suite fails for a reason that has nothing
      // to do with the code. Restarting keeps the real limits in place rather
      // than weakening them for tests.
      reuseExistingServer: false,
      env: {
        ...(process.env as Record<string, string>),
        API_PORT: String(API_PORT),
        CORS_ORIGINS: `http://localhost:${WEB_PORT}`,
      },
      stdout: 'ignore',
      timeout: 60_000,
    },
    {
      command: `npx next start -p ${WEB_PORT}`,
      cwd: 'apps/web',
      port: WEB_PORT,
      // Fresh processes every run, deliberately: the rate limiters are
      // in-memory, so a reused server carries over "5 inquiries per hour"
      // from the last run and the suite fails for a reason that has nothing
      // to do with the code. Restarting keeps the real limits in place rather
      // than weakening them for tests.
      reuseExistingServer: false,
      env: {
        ...(process.env as Record<string, string>),
        // Server-side fetches. The BROWSER's copy is inlined at build time by
        // `npm run test:e2e:build` — NEXT_PUBLIC_* cannot be set at runtime.
        API_URL: `http://localhost:${API_PORT}`,
      },
      stdout: 'ignore',
      timeout: 120_000,
    },
  ],
});
