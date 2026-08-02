import { execSync } from 'node:child_process';
import path from 'node:path';
import { beforeAll } from 'vitest';

/**
 * TEST ENVIRONMENT
 *
 * Tests run against a REAL Postgres database, not a mock.
 *
 * That is a deliberate choice and it costs a few seconds per run. The bugs
 * these tests exist to catch — a missing `agencyId` in a WHERE clause, a
 * unique index that does not hold, a CHECK constraint that rejects a legal
 * value — are precisely the bugs a mocked Prisma client cannot see, because a
 * mock returns whatever you told it to. A tenant-isolation test against a mock
 * proves nothing at all.
 */

const repoRoot = path.resolve(__dirname, '../../..');

try {
  process.loadEnvFile(path.join(repoRoot, '.env'));
} catch {
  // CI injects real environment variables instead.
}

process.env.NODE_ENV = 'test';

/**
 * The test database is the development one with `_test` appended, derived
 * rather than configured — so the two can never drift apart, and there is no
 * second connection string to keep in `.env`.
 */
function deriveTestDatabaseUrl(devUrl: string): string {
  const url = new URL(devUrl);
  const dbName = url.pathname.replace(/^\//, '');

  if (dbName.endsWith('_test')) return url.toString();

  // Refuse to touch anything that looks live. A test run truncates every
  // table; pointing it at production is unrecoverable, so guess conservatively
  // and fail loudly rather than being clever.
  if (/prod|production|live/i.test(devUrl)) {
    throw new Error('Refusing to run tests against a database URL containing "prod"/"live".');
  }

  url.pathname = `/${dbName}_test`;
  return url.toString();
}

const devUrl = process.env['DATABASE_URL'];
if (!devUrl) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env and start docker compose.');
}

const testUrl = deriveTestDatabaseUrl(devUrl);
process.env['DATABASE_URL'] = testUrl;

// Real-looking secrets so config validation passes. They are not secret: this
// database holds only fixtures, and the values never leave the test process.
process.env['JWT_ACCESS_SECRET'] ??= 'test-access-secret-that-is-long-enough-0123456789';
process.env['JWT_REFRESH_SECRET'] ??= 'test-refresh-secret-that-is-long-enough-9876543210';
process.env['LOG_LEVEL'] = 'error';

beforeAll(() => {
  const testDbName = new URL(testUrl).pathname.replace(/^\//, '');
  const adminUrl = new URL(testUrl);
  adminUrl.pathname = '/postgres';

  // `CREATE DATABASE` is a no-op if it already exists; the `||` swallows the
  // error rather than making a rerun fail.
  execSync(
    `psql "${adminUrl.toString()}" -c 'CREATE DATABASE "${testDbName}"' 2>/dev/null || true`,
    { stdio: 'ignore', shell: '/bin/sh' },
  );

  /**
   * `migrate deploy`, not `db push`.
   *
   * The tests then run against schema built by the exact migration files that
   * will run in production — including the hand-written CHECK constraints,
   * which `db push` would silently skip. A test suite that passes on a schema
   * production will never have is a test suite that lies.
   */
  execSync('npx prisma migrate deploy', {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: testUrl },
    stdio: 'ignore',
  });
});
