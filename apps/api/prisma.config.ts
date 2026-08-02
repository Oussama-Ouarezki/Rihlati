import path from 'node:path';
import { defineConfig } from 'prisma/config';

/**
 * Prisma CLI configuration.
 *
 * It exists for one reason: `.env` lives at the REPO ROOT, not in `apps/api`,
 * and the Prisma CLI only looks in its own working directory. Without this,
 * every `prisma migrate` fails with "Environment variable not found:
 * DATABASE_URL" even though the API itself starts fine.
 *
 * One `.env` for the whole monorepo is the deliberate choice — one file to
 * gitignore, one file to get wrong. See CLAUDE.md rule #1.
 *
 * `process.loadEnvFile` is built into Node 22, so this needs no dependency.
 */
const repoRoot = path.resolve(__dirname, '../..');

try {
  process.loadEnvFile(path.join(repoRoot, '.env'));
} catch {
  // Absent in CI and in production, where real environment variables are
  // injected by the platform. Not an error — the schema validation that
  // follows will complain if DATABASE_URL genuinely is not set.
}

export default defineConfig({
  schema: path.join(__dirname, 'prisma', 'schema.prisma'),
  migrations: {
    path: path.join(__dirname, 'prisma', 'migrations'),
    seed: 'tsx prisma/seed.ts',
  },
});
