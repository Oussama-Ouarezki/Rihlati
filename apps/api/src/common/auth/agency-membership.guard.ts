import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AGENCY_ROLE_RANK, type AgencyRole } from '@rihlati/shared';
import { AppError, notFound } from '../errors/app-error';
import { PrismaService } from '../prisma/prisma.service';
import { AGENCY_ROLE_KEY, REQUIRE_VERIFIED_KEY } from './auth.decorators';
import type { TenantContext } from './tenant-context';

/**
 * TENANT ISOLATION, ENFORCED BEFORE ANY HANDLER RUNS
 *
 * Registered globally. It activates on one condition: the matched route has an
 * `:agencyId` parameter. That is the trick worth understanding —
 *
 *   You cannot write a tenant-scoped route and forget this guard, because the
 *   thing that makes a route tenant-scoped (the `:agencyId` in its path) is
 *   the same thing that turns the guard on.
 *
 * There is no decorator to remember. Adding `@RequireAgencyRole('manager')`
 * only raises the bar above the default of "any member".
 *
 * What it does:
 *   1. reads `:agencyId` from the URL — a CLAIM, not a fact
 *   2. looks for a membership row (this user, that agency)
 *   3. no row → 404. Not 403. A 403 would confirm the agency exists.
 *   4. builds TenantContext from the row, and puts the agency's real id on the
 *      request. Services take `tenant.agencyId` from there, so a handler can
 *      never accidentally scope a query by an unverified path parameter.
 */
@Injectable()
export class AgencyMembershipGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const req = context.switchToHttp().getRequest<Request>();
    const agencyIdParam = (req.params as Record<string, string | undefined>)['agencyId'];

    // Not a tenant-scoped route. Nothing to check.
    if (!agencyIdParam) return true;

    // An unauthenticated caller cannot be a member of anything. This is
    // reachable only if someone marks an `:agencyId` route `@Public()`, which
    // is a mistake — so say so loudly rather than silently allowing it.
    if (!req.auth) {
      throw new AppError(
        'UNAUTHENTICATED',
        'Authentification requise pour accéder aux données d’une agence',
      );
    }

    // Reject a malformed id before it becomes a query. Prisma would throw a
    // 500 on a non-uuid, and a 500 that only happens for invalid ids is itself
    // an oracle.
    if (!UUID_RE.test(agencyIdParam)) throw notFound('Agence');

    const membership = await this.prisma.membership.findUnique({
      where: { userId_agencyId: { userId: req.auth.userId, agencyId: agencyIdParam } },
      select: {
        role: true,
        agency: {
          select: {
            id: true,
            slug: true,
            name: true,
            status: true,
            plan: true,
            publishedOfferLimitOverride: true,
            deletedAt: true,
          },
        },
      },
    });

    let tenant: TenantContext;

    if (membership && !membership.agency.deletedAt) {
      tenant = {
        agencyId: membership.agency.id,
        agencySlug: membership.agency.slug,
        agencyName: membership.agency.name,
        agencyStatus: membership.agency.status,
        plan: membership.agency.plan,
        publishedOfferLimitOverride: membership.agency.publishedOfferLimitOverride,
        role: membership.role,
        actingAsPlatformAdmin: false,
      };
    } else if (req.auth.isPlatformAdmin) {
      /**
       * A Rihlati admin can act on any agency — that is the job: verifying
       * documents, resolving spam reports, handling "we're locked out".
       *
       * They are given `owner` rank so no role check blocks support work, and
       * `actingAsPlatformAdmin` so every audit row records that it was staff,
       * not the agency. An admin action that looks like the agency's own
       * action is how support access becomes indistinguishable from abuse.
       */
      const agency = await this.prisma.agency.findFirst({
        where: { id: agencyIdParam, deletedAt: null },
        select: {
          id: true, slug: true, name: true, status: true, plan: true,
          publishedOfferLimitOverride: true,
        },
      });
      if (!agency) throw notFound('Agence');

      tenant = {
        agencyId: agency.id,
        agencySlug: agency.slug,
        agencyName: agency.name,
        agencyStatus: agency.status,
        plan: agency.plan,
        publishedOfferLimitOverride: agency.publishedOfferLimitOverride,
        role: 'owner',
        actingAsPlatformAdmin: true,
      };
    } else {
      // No membership. Identical answer to "no such agency" — same code, same
      // message, same status. This line is CLAUDE.md rule #3.
      throw notFound('Agence');
    }

    const requiredRole = this.reflector.getAllAndOverride<AgencyRole>(AGENCY_ROLE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (requiredRole && AGENCY_ROLE_RANK[tenant.role] < AGENCY_ROLE_RANK[requiredRole]) {
      // 403, not 404: the caller already knows this agency exists — they are a
      // member of it. Hiding the reason here would only confuse, not protect.
      throw new AppError('INSUFFICIENT_ROLE', `Rôle « ${requiredRole} » requis`, {
        details: { required: requiredRole, actual: tenant.role },
      });
    }

    const needsVerified = this.reflector.getAllAndOverride<boolean>(REQUIRE_VERIFIED_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (needsVerified && tenant.agencyStatus !== 'verified') {
      throw new AppError(
        'AGENCY_NOT_VERIFIED',
        "Cette action nécessite une agence vérifiée par Rihlati",
        { details: { status: tenant.agencyStatus } },
      );
    }

    req.tenant = tenant;
    return true;
  }
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
