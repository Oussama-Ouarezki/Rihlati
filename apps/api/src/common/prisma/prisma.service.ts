import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { APP_CONFIG, type AppConfig } from '../../config/env';

/**
 * The database connection, as a Nest provider.
 *
 * This is the ONLY class in the app allowed to talk to Postgres. Everything
 * else injects it. That single chokepoint is what makes it possible to answer
 * "is every query tenant-scoped?" by reading a bounded amount of code.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super({
      datasources: { db: { url: config.DATABASE_URL } },
      // Queries are logged only in development. In production a query log is a
      // slow, expensive way to leak phone numbers into your log storage.
      log: config.isProduction ? ['warn', 'error'] : ['warn', 'error'],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Wipes every table. Test helper only — it throws anywhere else, because a
   * function that can empty the database must not be one import away from a
   * production code path.
   */
  async truncateAllForTests(): Promise<void> {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('truncateAllForTests() is only callable with NODE_ENV=test');
    }
    await this.$executeRawUnsafe(`
      TRUNCATE TABLE
        audit_logs, lead_tags, lead_activities, lead_notes, reviews, leads,
        saved_offers, offer_reports, offer_duplicate_candidates, offers,
        tags, memberships, agencies, refresh_tokens, users
      RESTART IDENTITY CASCADE
    `);
  }
}
