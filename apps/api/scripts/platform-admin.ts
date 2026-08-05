import path from 'node:path';
import { PrismaClient } from '@prisma/client';

/**
 * GRANT OR REVOKE PLATFORM ADMIN
 *
 *   npm run admin:grant  -- someone@rihlati.dz
 *   npm run admin:revoke -- someone@rihlati.dz
 *   npm run admin:list
 *
 * WHY THIS IS A SCRIPT AND NOT AN ENDPOINT
 *
 * There is a chicken-and-egg problem: an endpoint that promotes someone to
 * platform admin would itself have to be protected by platform admin, so the
 * FIRST one can never be created through it. Something outside the API has to
 * bootstrap it.
 *
 * It could have been an endpoint that only works when zero admins exist. That
 * is worse: it is a public "make me god" endpoint that is armed on every fresh
 * deployment, and a race between deploying and registering hands the platform
 * to whoever gets there first.
 *
 * A CLI moves the permission boundary to something an attacker on the internet
 * does not have: shell access to the server and the database credentials. If
 * they already have those, this script is not what you lost.
 *
 * The cost is honest — promotion is a manual operation with no UI, which is
 * correct while Rihlati's staff is a list of two people. When it stops being
 * correct, the replacement is an endpoint restricted to existing admins, and
 * this script stays for the bootstrap.
 */

try {
  process.loadEnvFile(path.resolve(__dirname, '../../../.env'));
} catch {
  // Real environment variables in CI and in production.
}

const prisma = new PrismaClient();

type Command = 'grant' | 'revoke' | 'list';

async function main(): Promise<void> {
  const [command, identifier] = process.argv.slice(2) as [Command | undefined, string | undefined];

  if (command !== 'grant' && command !== 'revoke' && command !== 'list') {
    throw new Error('Usage: platform-admin.ts <grant|revoke|list> [email]');
  }

  if (command === 'list') {
    const admins = await prisma.user.findMany({
      where: { isPlatformAdmin: true },
      select: { email: true, displayName: true, disabledAt: true },
      orderBy: { createdAt: 'asc' },
    });
    if (admins.length === 0) {
      console.log('No platform admins. Nobody can review an agency.');
      return;
    }
    console.log(`${admins.length} platform admin(s):`);
    for (const admin of admins) {
      console.log(`  ${admin.email ?? '(no email)'}  ${admin.displayName}${admin.disabledAt ? '  [DISABLED]' : ''}`);
    }
    return;
  }

  if (!identifier) throw new Error(`Usage: platform-admin.ts ${command} <email>`);
  const email = identifier.trim().toLowerCase();

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, displayName: true, isPlatformAdmin: true },
  });
  if (!user) {
    // Deliberately blunt. This is a local shell, not an API: there is nobody
    // to protect from enumeration, and "no such user" beats a silent no-op.
    throw new Error(`No user with email ${email}. Register the account first.`);
  }

  const shouldBeAdmin = command === 'grant';
  if (user.isPlatformAdmin === shouldBeAdmin) {
    console.log(`${email} is already ${shouldBeAdmin ? 'a platform admin' : 'not a platform admin'}. Nothing to do.`);
    return;
  }

  /**
   * The flag and its audit row are written together. A promotion that
   * committed without its audit row would be an admin nobody can account for,
   * which is the exact thing this row exists to prevent (rule #4).
   *
   * `actorUserId` is null: the actor is whoever had shell access, and the
   * script genuinely does not know who that was. Pretending otherwise by
   * attributing it to the promoted user would be worse than admitting it.
   */
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { isPlatformAdmin: shouldBeAdmin },
    });

    await tx.auditLog.create({
      data: {
        action: shouldBeAdmin ? 'user.platform_admin_granted' : 'user.platform_admin_revoked',
        entityType: 'user',
        entityId: user.id,
        actorUserId: null,
        before: { isPlatformAdmin: user.isPlatformAdmin },
        after: { isPlatformAdmin: shouldBeAdmin, via: 'cli', shellUser: process.env['USER'] ?? null },
      },
    });
  });

  console.log(
    shouldBeAdmin
      ? `${email} is now a platform admin. They can read every agency on the platform.`
      : `${email} is no longer a platform admin.`,
  );
  console.log('Takes effect immediately — JwtAuthGuard reads the flag from the database on every request, not from the token.');
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
