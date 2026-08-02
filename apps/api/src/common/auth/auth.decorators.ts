import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import type { AgencyRole } from '@rihlati/shared';
import type { AuthenticatedActor } from '../http/request-context';
import type { TenantContext } from './tenant-context';

/**
 * DENY BY DEFAULT
 *
 * `JwtAuthGuard` is registered globally, so every route requires a logged-in
 * user unless it is explicitly marked `@Public()`. Write a new controller,
 * forget everything, and it is still protected.
 *
 * The opposite arrangement — open by default, add a guard per route — is how
 * "we forgot to protect one endpoint" happens, and it only takes one.
 */
export const IS_PUBLIC_KEY = 'rihlati:isPublic';

/**
 * No authentication required. Use sparingly, and remember:
 *   - it must be rate limited (public = the whole internet)
 *   - it must not read tenant data
 *   - a token may still be present; `@OptionalUser()` reads it if so
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Minimum role at the agency named by the route's `:agencyId` parameter.
 *
 * Ranked, not exact: `manager` satisfies `@RequireAgencyRole('agent')`. See
 * AGENCY_ROLE_RANK in @rihlati/shared.
 */
export const AGENCY_ROLE_KEY = 'rihlati:agencyRole';
export const RequireAgencyRole = (role: AgencyRole): MethodDecorator & ClassDecorator =>
  SetMetadata(AGENCY_ROLE_KEY, role);

/** Rihlati's own staff only. Verification, moderation, plan overrides. */
export const PLATFORM_ADMIN_KEY = 'rihlati:platformAdmin';
export const PlatformAdminOnly = (): MethodDecorator & ClassDecorator =>
  SetMetadata(PLATFORM_ADMIN_KEY, true);

/**
 * The agency must be `verified` — not merely existing.
 *
 * Applied to publishing and to anything a traveler will see. An unverified
 * agency can build its catalogue in draft; it cannot put it in front of people.
 */
export const REQUIRE_VERIFIED_KEY = 'rihlati:requireVerifiedAgency';
export const RequireVerifiedAgency = (): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRE_VERIFIED_KEY, true);

// ---------------------------------------------------------------------------
// PARAMETER DECORATORS
// ---------------------------------------------------------------------------

/**
 * The authenticated actor. Guaranteed present on any route that is not
 * `@Public()` — the guard has already rejected the request otherwise, so the
 * non-null assertion here is safe by construction.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedActor => {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.auth) {
      throw new Error(
        'CurrentUser used on a route with no auth guard. Remove @Public() or use @OptionalUser().',
      );
    }
    return req.auth;
  },
);

/** For public routes that behave slightly differently when someone is logged in. */
export const OptionalUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedActor | null =>
    ctx.switchToHttp().getRequest<Request>().auth ?? null,
);

/**
 * The verified tenant context — the agency this request acts on, and the
 * caller's role there.
 *
 * This is the value services must scope every query by. It does NOT come from
 * the request body or a header: it is the membership row the guard loaded from
 * the database this request. See tenant-context.ts.
 */
export const Tenant = createParamDecorator((_data: unknown, ctx: ExecutionContext): TenantContext => {
  const req = ctx.switchToHttp().getRequest<Request>();
  if (!req.tenant) {
    throw new Error(
      'Tenant used on a route without an :agencyId parameter. Add it to the path, ' +
        'or the membership guard cannot run and the query would be unscoped.',
    );
  }
  return req.tenant;
});

/** The per-request id, for handlers that need to pass it into an audit row. */
export const RequestId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string =>
    ctx.switchToHttp().getRequest<Request>().requestId,
);
