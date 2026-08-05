import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  buildPage,
  type AdminAgencyDecision,
  type AdminAgencyListItem,
  type AdminAgencyQueueInput,
  type Page,
  type RejectAgencyInput,
  type VerifyAgencyInput,
} from '@rihlati/shared';
import { AppError, notFound } from '../../common/errors/app-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import type { RequestMeta } from '../auth/auth.service';

/**
 * THE VERIFICATION QUEUE — and the one place tenant scoping does not apply.
 *
 * Read obsidian/Concepts/Multi-Tenancy.md first, then read this, because this
 * service breaks its central rule on purpose.
 *
 * Everywhere else, a query without `agencyId` in its `where` is a bug. Here it
 * is the requirement: Rihlati staff review agencies they are by definition not
 * members of. There is no session tenant to scope by, so the ONLY thing
 * standing between these methods and every agency's legal identifiers is
 * `@PlatformAdminOnly()` on the controller and the `isPlatformAdmin` check
 * inside `JwtAuthGuard`.
 *
 * That is a single point of failure, and naming it is the point: a bug there
 * exposes every agency at once, whereas a bug in a tenant-scoped service
 * exposes one. It is why the tests for this module lean on the guard rather
 * than on the happy path.
 */
@Injectable()
export class AdminAgenciesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The queue. Oldest submission first, because the only fair way to order a
   * manual review is the order people asked.
   */
  async listAgencies(query: AdminAgencyQueueInput): Promise<Page<AdminAgencyListItem>> {
    const where: Prisma.AgencyWhereInput = {
      status: query.status,
      deletedAt: null,
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' } },
              { legalName: { contains: query.q, mode: 'insensitive' } },
              { slug: { contains: query.q, mode: 'insensitive' } },
              { registreCommerce: { contains: query.q, mode: 'insensitive' } },
              { nif: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const rows = await this.prisma.agency.findMany({
      where,
      select: ADMIN_AGENCY_SELECT,
      // `nulls: 'first'`: an agency whose row predates this column has been
      // waiting at least as long as anyone with a timestamp, so it belongs at
      // the front, not silently at the back where Postgres puts NULLs by
      // default in an ascending sort.
      orderBy: [{ submittedForReviewAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const page = buildPage(rows, query.limit);
    return { items: page.items.map(toListItem), nextCursor: page.nextCursor };
  }

  /**
   * Grant the badge.
   *
   * `verifiedByUserId` is the reason this endpoint exists at all. Until now
   * verification was a hand-written UPDATE, which left no record of who
   * granted it — precisely the record you want when a verified agency turns
   * out to be fraudulent.
   */
  async verify(
    adminUserId: string,
    agencyId: string,
    input: VerifyAgencyInput,
    meta: RequestMeta,
  ): Promise<AdminAgencyDecision> {
    const agency = await this.loadForDecision(agencyId, adminUserId);

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      // The status is repeated in the `where`, not just checked above: two
      // admins opening the queue at the same time would otherwise both write,
      // and the second would overwrite the first one's decision along with the
      // record of who made it. Compare-and-set makes the loser a 409.
      const result = await tx.agency.updateMany({
        where: { id: agencyId, status: 'pending_review', deletedAt: null },
        data: {
          status: 'verified',
          verifiedAt: now,
          verifiedByUserId: adminUserId,
          // Cleared: the banner from a previous rejection must not survive an
          // approval and keep telling the owner they were refused.
          rejectionReason: null,
        },
      });
      if (result.count === 0) throw alreadyDecided(agency.status);

      await this.audit.record(
        {
          action: 'agency.verified',
          entityType: 'agency',
          entityId: agencyId,
          agencyId,
          actorUserId: adminUserId,
          before: { status: agency.status },
          // The note is stored here and nowhere else. This row is the answer
          // to "what exactly did you verify?" — see the reasoning on
          // `checkedNote` in packages/shared/src/admin/schemas.ts.
          after: { status: 'verified', checkedNote: input.checkedNote },
          ipHash: meta.ipHash ?? null,
          requestId: meta.requestId,
        },
        tx,
      );
    });

    return { id: agencyId, status: 'verified' };
  }

  /** Refuse, with a reason the owner will read word for word. */
  async reject(
    adminUserId: string,
    agencyId: string,
    input: RejectAgencyInput,
    meta: RequestMeta,
  ): Promise<AdminAgencyDecision> {
    const agency = await this.loadForDecision(agencyId, adminUserId);

    await this.prisma.$transaction(async (tx) => {
      const result = await tx.agency.updateMany({
        where: { id: agencyId, status: 'pending_review', deletedAt: null },
        data: { status: 'rejected', rejectionReason: input.reason },
      });
      if (result.count === 0) throw alreadyDecided(agency.status);

      await this.audit.record(
        {
          action: 'agency.rejected',
          entityType: 'agency',
          entityId: agencyId,
          agencyId,
          actorUserId: adminUserId,
          before: { status: agency.status },
          // Both texts land in the audit log; only `reason` reaches the agency.
          after: {
            status: 'rejected',
            reason: input.reason,
            ...(input.internalNote ? { internalNote: input.internalNote } : {}),
          },
          ipHash: meta.ipHash ?? null,
          requestId: meta.requestId,
        },
        tx,
      );
    });

    return { id: agencyId, status: 'rejected' };
  }

  // -------------------------------------------------------------------------

  /**
   * The checks both decisions share.
   *
   * The self-review rule is the interesting one. A platform admin who is also
   * a member of an agency must not review that agency — not because we expect
   * staff to cheat, but because a badge granted by its own owner cannot be
   * used as evidence of anything afterwards, which is the only reason the
   * badge is worth having. `AgencyMembershipGuard` cannot catch this: it
   * happily gives an admin `owner` rank on any agency, and this route has no
   * `:agencyId` for it to fire on in the first place.
   */
  private async loadForDecision(
    agencyId: string,
    adminUserId: string,
  ): Promise<{ status: string }> {
    const agency = await this.prisma.agency.findFirst({
      where: { id: agencyId, deletedAt: null },
      select: { id: true, status: true },
    });
    if (!agency) throw notFound('Agence');

    const ownMembership = await this.prisma.membership.findUnique({
      where: { userId_agencyId: { userId: adminUserId, agencyId } },
      select: { role: true },
    });
    if (ownMembership) {
      throw new AppError(
        'FORBIDDEN',
        'Un administrateur ne peut pas décider du sort de sa propre agence',
        { details: { reason: 'self_review' } },
      );
    }

    if (agency.status !== 'pending_review') {
      throw alreadyDecided(agency.status);
    }

    return agency;
  }
}

/**
 * One error for both "never asked" and "already decided".
 *
 * Deliberately NOT a 404: unlike every tenant-scoped endpoint, hiding the
 * agency's existence from a platform admin protects nobody — they can list
 * every agency on the next line. Here a precise answer is just a better
 * answer, and the queue page can say "someone else already handled this".
 */
function alreadyDecided(status: string): AppError {
  return new AppError(
    'INVALID_STATUS_TRANSITION',
    `Seule une agence « pending_review » peut être vérifiée ou refusée (état actuel : ${status})`,
    { details: { status } },
  );
}

const ADMIN_AGENCY_SELECT = {
  id: true, slug: true, name: true, legalName: true, status: true,
  submittedForReviewAt: true, verifiedAt: true, rejectionReason: true, createdAt: true,
  registreCommerce: true, nif: true, tourismLicence: true,
  addressLine: true, city: true, wilayaCode: true,
  phone: true, whatsapp: true, email: true, websiteUrl: true,
  memberships: {
    where: { role: 'owner' as const },
    take: 1,
    select: {
      userId: true,
      user: { select: { displayName: true, email: true, phone: true } },
    },
  },
} as const;

type AdminAgencyRow = Prisma.AgencyGetPayload<{ select: typeof ADMIN_AGENCY_SELECT }>;

/**
 * Built field by field rather than spread, for the same reason `toPublic` is:
 * a spread means the next column added to `Agency` ships to the client without
 * anyone deciding it should.
 */
function toListItem(row: AdminAgencyRow): AdminAgencyListItem {
  const owner = row.memberships[0];

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    legalName: row.legalName,
    status: row.status,
    submittedForReviewAt: row.submittedForReviewAt?.toISOString() ?? null,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    rejectionReason: row.rejectionReason,
    createdAt: row.createdAt.toISOString(),
    registreCommerce: row.registreCommerce,
    nif: row.nif,
    tourismLicence: row.tourismLicence,
    addressLine: row.addressLine,
    city: row.city,
    wilayaCode: row.wilayaCode,
    phone: row.phone,
    whatsapp: row.whatsapp,
    email: row.email,
    websiteUrl: row.websiteUrl,
    owner: owner
      ? {
          userId: owner.userId,
          displayName: owner.user.displayName,
          email: owner.user.email,
          phone: owner.user.phone,
        }
      : null,
  };
}
