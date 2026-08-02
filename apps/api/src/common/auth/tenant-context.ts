import type { AgencyPlan, AgencyRole, AgencyStatus } from '@rihlati/shared';

/**
 * THE TENANT CONTEXT
 *
 * Proof, produced fresh on every request, that this user may act for this
 * agency. It is built by `AgencyMembershipGuard` from a membership row read out
 * of the database — never from the request body, a header, or the JWT.
 *
 * The distinction that matters:
 *
 *   The client SAYS which agency it wants to act as, in the URL path.
 *   The server PROVES the claim, and derives the role from its own data.
 *
 * So `:agencyId` in a URL is not trusted input in the dangerous sense — it is a
 * lookup key that must match a row the caller owns. If no such row exists the
 * request 404s, which is the same answer as "no such agency". A client can
 * therefore learn nothing by guessing ids.
 *
 * Why not put the agency and role in the JWT and skip the query? Because a
 * token is a snapshot. Fire an employee at 09:00 and, with a 15-minute access
 * token, they can still read your client list until 09:15. One indexed lookup
 * per request is a small price for revocation that takes effect immediately.
 */
export interface TenantContext {
  /** The tenant key. Every query on tenant-owned data is scoped by this. */
  agencyId: string;
  agencySlug: string;
  agencyName: string;
  agencyStatus: AgencyStatus;
  plan: AgencyPlan;
  publishedOfferLimitOverride: number | null;

  /** The caller's role AT THIS AGENCY. Read from the database this request. */
  role: AgencyRole;

  /**
   * True when a Rihlati admin is acting on an agency they are not a member of.
   * Services use it to decide what to write to the audit log — an admin
   * touching an agency's data must always be distinguishable from the agency
   * doing it themselves.
   */
  actingAsPlatformAdmin: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by AgencyMembershipGuard on any route with an `:agencyId` param. */
      tenant?: TenantContext;
    }
  }
}
