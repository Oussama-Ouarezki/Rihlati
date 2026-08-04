import { Controller, Get, Param } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import type { TravelerTripView } from '@rihlati/shared';
import { Public } from '../../common/auth/auth.decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { TripsService } from './trips.service';

/**
 * A `base64url` capability code: 22 characters for 128 bits. Bounded and
 * character-restricted before it reaches the database, so a 40 KB path segment
 * or a `%00` is rejected at the door rather than becoming a query.
 */
const publicCodeParam = (): ZodValidationPipe<z.ZodString> =>
  new ZodValidationPipe(
    z.string().trim().min(16).max(64).regex(/^[A-Za-z0-9_-]+$/, 'validation.urlInvalid'),
  );

@Controller('trips')
export class TripsController {
  constructor(private readonly trips: TripsService) {}

  /**
   * The traveler's own trip page. `@Public()` — the family has no account, by
   * design (see Trip Programme.md §5); the code in the URL is the credential.
   *
   * The throttle is not decoration. A capability URL is only as strong as the
   * rate at which it can be guessed, so this is the control that turns "128
   * random bits" into an actual security property. 30 per hour per IP is far
   * more than a family refreshing on the way to the airport needs, and far
   * less than enumeration needs.
   */
  @Public()
  @Throttle({ trip: { limit: 30, ttl: 3_600_000 } })
  @Get(':code')
  get(@Param('code', publicCodeParam()) code: string): Promise<TravelerTripView> {
    return this.trips.getByPublicCode(code);
  }
}
