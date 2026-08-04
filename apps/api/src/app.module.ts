import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ConfigModule } from './config/config.module';
import { CommonModule } from './common/common.module';
import { PrismaModule } from './common/prisma/prisma.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { JwtAuthGuard } from './common/auth/jwt-auth.guard';
import { AgencyMembershipGuard } from './common/auth/agency-membership.guard';
import { requestIdMiddleware } from './common/http/request-context';
import { AuthModule } from './modules/auth/auth.module';
import { AgenciesModule } from './modules/agencies/agencies.module';
import { OffersModule } from './modules/offers/offers.module';
import { LeadsModule } from './modules/leads/leads.module';
import { ReservationsModule } from './modules/reservations/reservations.module';
import { MilestonesModule } from './modules/milestones/milestones.module';
import { TripsModule } from './modules/trips/trips.module';
import { TrackedLinksModule } from './modules/tracked-links/tracked-links.module';
import { UploadsModule } from './modules/uploads/uploads.module';
import { HealthModule } from './modules/health/health.module';

/**
 * THE COMPOSITION ROOT
 *
 * The three `APP_GUARD` entries below are the most important lines in the
 * codebase. They run in the order listed, on EVERY request:
 *
 *   1. ThrottlerGuard        — rate limit, before any work is done
 *   2. JwtAuthGuard          — deny by default; `@Public()` is the only exit
 *   3. AgencyMembershipGuard — any route with `:agencyId` proves membership
 *
 * Because they are global, protection is the default state of a new endpoint
 * rather than something the author has to remember. Rules #2 and #3 of
 * CLAUDE.md are enforced here, once, instead of in every controller.
 */
@Module({
  imports: [
    ConfigModule,
    CommonModule,
    PrismaModule,
    JwtModule.register({}),

    /**
     * A default ceiling for every route. Individual routes tighten it with
     * `@Throttle(...)`. 300/minute is generous for a browsing traveler and
     * still stops a script from scraping the whole offer catalogue in seconds.
     */
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', limit: 300, ttl: 60_000 }],
    }),

    AuthModule,
    AgenciesModule,
    OffersModule,
    LeadsModule,
    ReservationsModule,
    MilestonesModule,
    TripsModule,
    TrackedLinksModule,
    UploadsModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: AgencyMembershipGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Must be first: everything downstream logs with this id.
    consumer.apply(requestIdMiddleware).forRoutes('*');
  }
}
