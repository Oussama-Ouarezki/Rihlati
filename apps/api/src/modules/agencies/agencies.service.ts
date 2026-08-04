import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  PLAN_LIMITS,
  RESERVED_AGENCY_SLUGS,
  buildPage,
  resolvePublishedOfferLimit,
  type AgencyForMember,
  type AgencySearchInput,
  type CreateAgencyInput,
  type Page,
  type PublicAgency,
  type UpdateAgencyInput,
} from '@rihlati/shared';
import { AppError, notFound } from '../../common/errors/app-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import type { TenantContext } from '../../common/auth/tenant-context';
import type { RequestMeta } from '../auth/auth.service';

@Injectable()
export class AgenciesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Create an agency. The caller becomes its `owner`.
   *
   * Both writes happen in one transaction. An agency with no owner would be
   * unreachable by anyone — including its creator — and the only fix would be
   * a manual database edit.
   */
  async create(
    userId: string,
    input: CreateAgencyInput,
    meta: RequestMeta,
  ): Promise<AgencyForMember> {
    if (RESERVED_AGENCY_SLUGS.includes(input.slug)) {
      throw new AppError('SLUG_TAKEN', 'Cet identifiant est réservé', {
        fields: { slug: ['validation.slugReserved'] },
      });
    }

    const taken = await this.prisma.agency.findUnique({
      where: { slug: input.slug },
      select: { id: true },
    });
    if (taken) {
      throw new AppError('SLUG_TAKEN', 'Cet identifiant est déjà pris', {
        fields: { slug: ['validation.slugTaken'] },
      });
    }

    /**
     * One agency per person, for now.
     *
     * Not a technical limit — the data model handles many memberships fine.
     * It is a spam control: without it, one signup can create fifty agencies
     * and fifty times the free offer quota, which defeats the quota entirely.
     * Lift it when there is a verification step with a real cost attached.
     */
    const alreadyOwns = await this.prisma.membership.findFirst({
      where: { userId, role: 'owner', agency: { deletedAt: null } },
      select: { agencyId: true },
    });
    if (alreadyOwns) {
      throw new AppError(
        'AGENCY_ALREADY_EXISTS',
        'Vous gérez déjà une agence. Contactez le support pour en ajouter une autre.',
      );
    }

    const agency = await this.prisma.$transaction(async (tx) => {
      const created = await tx.agency.create({
        data: {
          ...input,
          // `status` is NOT in the input schema, and is pinned here anyway.
          // Belt and braces: an agency that could set its own status could
          // publish to travelers without anyone checking its licence.
          status: 'draft',
          memberships: { create: { userId, role: 'owner', acceptedAt: new Date() } },
        },
        select: AGENCY_SELECT,
      });

      await this.audit.record(
        {
          action: 'agency.created',
          entityType: 'agency',
          entityId: created.id,
          agencyId: created.id,
          actorUserId: userId,
          after: { slug: created.slug, name: created.name },
          ipHash: meta.ipHash ?? null,
          requestId: meta.requestId,
        },
        tx,
      );

      return created;
    });

    return this.toMemberView(agency, 'owner', { publishedOffers: 0, seats: 1 });
  }

  /** The agency as its own staff see it, with live quota counts. */
  async getForMember(tenant: TenantContext): Promise<AgencyForMember> {
    // Scoped by tenant.agencyId, which the guard proved. Never by a raw param.
    const agency = await this.prisma.agency.findFirst({
      where: { id: tenant.agencyId, deletedAt: null },
      select: AGENCY_SELECT,
    });
    if (!agency) throw notFound('Agence');

    const [publishedOffers, seats] = await Promise.all([
      this.prisma.offer.count({
        where: { agencyId: tenant.agencyId, status: 'published', deletedAt: null },
      }),
      this.prisma.membership.count({ where: { agencyId: tenant.agencyId } }),
    ]);

    return this.toMemberView(agency, tenant.role, { publishedOffers, seats });
  }

  async update(
    tenant: TenantContext,
    actorUserId: string,
    input: UpdateAgencyInput,
    meta: RequestMeta,
  ): Promise<AgencyForMember> {
    const before = await this.prisma.agency.findFirst({
      where: { id: tenant.agencyId, deletedAt: null },
      select: AGENCY_SELECT,
    });
    if (!before) throw notFound('Agence');

    /**
     * Editing the legal identifiers of a VERIFIED agency sends it back for
     * review.
     *
     * Otherwise the flow is: get verified with a real RC, then quietly swap in
     * a different one and keep the badge. The badge is the only thing a
     * traveler can rely on, so it has to track what was actually checked.
     */
    const legalFields = ['registreCommerce', 'nif', 'tourismLicence'] as const;
    const legalChanged = legalFields.some(
      (field) => input[field] !== undefined && input[field] !== before[field],
    );
    const resetToReview = legalChanged && before.status === 'verified';

    const updated = await this.prisma.$transaction(async (tx) => {
      // updateMany + agencyId in the where clause, not update({ where: { id } }).
      // See the tenant-scoping note in obsidian/Concepts/Multi-Tenancy.md.
      const result = await tx.agency.updateMany({
        where: { id: tenant.agencyId, deletedAt: null },
        data: {
          ...input,
          ...(resetToReview ? { status: 'pending_review', verifiedAt: null } : {}),
        },
      });
      if (result.count === 0) throw notFound('Agence');

      const after = await tx.agency.findFirstOrThrow({
        where: { id: tenant.agencyId },
        select: AGENCY_SELECT,
      });

      const diff = AuditService.diff(before, input);
      await this.audit.record(
        {
          action: 'agency.updated',
          entityType: 'agency',
          entityId: tenant.agencyId,
          agencyId: tenant.agencyId,
          actorUserId,
          before: diff.before,
          after: { ...diff.after, ...(resetToReview ? { status: 'pending_review' } : {}) },
          ipHash: meta.ipHash ?? null,
          requestId: meta.requestId,
        },
        tx,
      );

      return after;
    });

    const [publishedOffers, seats] = await Promise.all([
      this.prisma.offer.count({
        where: { agencyId: tenant.agencyId, status: 'published', deletedAt: null },
      }),
      this.prisma.membership.count({ where: { agencyId: tenant.agencyId } }),
    ]);

    return this.toMemberView(updated, tenant.role, { publishedOffers, seats });
  }

  /**
   * Ask Rihlati to verify this agency.
   *
   * The check itself is manual and always will be: a human reads the RC, the
   * NIF and the tourism licence. That slowness is the product. An automated
   * "verified" badge is worth exactly nothing to a traveler about to transfer
   * 400 000 DZD.
   */
  async submitForReview(
    tenant: TenantContext,
    actorUserId: string,
    meta: RequestMeta,
  ): Promise<{ status: string }> {
    const agency = await this.prisma.agency.findFirst({
      where: { id: tenant.agencyId, deletedAt: null },
      select: { status: true, registreCommerce: true, nif: true, name: true },
    });
    if (!agency) throw notFound('Agence');

    if (!['draft', 'rejected'].includes(agency.status)) {
      throw new AppError(
        'INVALID_STATUS_TRANSITION',
        `Une agence « ${agency.status} » ne peut pas être soumise à vérification`,
      );
    }
    if (!agency.registreCommerce || !agency.nif) {
      throw new AppError('VALIDATION_FAILED', 'Registre de commerce et NIF requis', {
        fields: {
          ...(agency.registreCommerce ? {} : { registreCommerce: ['validation.requiredForVerification'] }),
          ...(agency.nif ? {} : { nif: ['validation.requiredForVerification'] }),
        },
      });
    }

    await this.prisma.$transaction(async (tx) => {
      const result = await tx.agency.updateMany({
        where: { id: tenant.agencyId, status: { in: ['draft', 'rejected'] } },
        data: { status: 'pending_review', rejectionReason: null },
      });
      if (result.count === 0) throw notFound('Agence');

      await this.audit.record(
        {
          action: 'agency.submitted_for_review',
          entityType: 'agency',
          entityId: tenant.agencyId,
          agencyId: tenant.agencyId,
          actorUserId,
          before: { status: agency.status },
          after: { status: 'pending_review' },
          ipHash: meta.ipHash ?? null,
          requestId: meta.requestId,
        },
        tx,
      );
    });

    return { status: 'pending_review' };
  }

  // -------------------------------------------------------------------------
  // PUBLIC
  // -------------------------------------------------------------------------

  /** Only verified agencies are listed. Unverified ones do not exist publicly. */
  async searchPublic(query: AgencySearchInput): Promise<Page<PublicAgency>> {
    const where: Prisma.AgencyWhereInput = {
      status: 'verified',
      deletedAt: null,
      ...(query.wilayaCode ? { wilayaCode: query.wilayaCode } : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' } },
              { city: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const rows = await this.prisma.agency.findMany({
      where,
      select: { ...PUBLIC_AGENCY_SELECT, _count: { select: { offers: true } } },
      orderBy: [{ ratingCount: 'desc' }, { id: 'asc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    // minRating is applied after the fetch because it is derived from two
    // columns. Fine at this scale; when it stops being fine, store the average
    // as its own indexed column rather than making the query cleverer.
    const filtered =
      query.minRating === undefined
        ? rows
        : rows.filter((row) => averageRating(row.ratingSum, row.ratingCount) >= query.minRating!);

    const page = buildPage(filtered, query.limit);
    return {
      items: page.items.map((row) => this.toPublic(row, row._count.offers)),
      nextCursor: page.nextCursor,
    };
  }

  async getPublicBySlug(slug: string): Promise<PublicAgency> {
    const agency = await this.prisma.agency.findFirst({
      where: { slug, status: 'verified', deletedAt: null },
      select: PUBLIC_AGENCY_SELECT,
    });
    if (!agency) throw notFound('Agence');

    const publishedOfferCount = await this.prisma.offer.count({
      where: {
        agencyId: agency.id,
        status: 'published',
        deletedAt: null,
        duplicateStatus: { not: 'confirmed' },
      },
    });

    return this.toPublic(agency, publishedOfferCount);
  }

  // -------------------------------------------------------------------------

  private toPublic(row: PublicAgencyRow, publishedOfferCount: number): PublicAgency {
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      logoUrl: row.logoUrl,
      isVerified: row.status === 'verified',
      verifiedAt: row.verifiedAt?.toISOString() ?? null,
      city: row.city,
      wilayaCode: row.wilayaCode,
      phone: row.phone,
      whatsapp: row.whatsapp,
      websiteUrl: row.websiteUrl,
      rating: averageRatingOrNull(row.ratingSum, row.ratingCount),
      ratingCount: row.ratingCount,
      publishedOfferCount,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toMemberView(
    row: AgencyRow,
    role: TenantContext['role'],
    counts: { publishedOffers: number; seats: number },
  ): AgencyForMember {
    return {
      ...this.toPublic(row, counts.publishedOffers),
      status: row.status,
      rejectionReason: row.rejectionReason,
      legalName: row.legalName,
      email: row.email,
      addressLine: row.addressLine,
      registreCommerce: row.registreCommerce,
      nif: row.nif,
      tourismLicence: row.tourismLicence,
      plan: row.plan,
      yourRole: role,
      limits: {
        publishedOffers: {
          used: counts.publishedOffers,
          limit: resolvePublishedOfferLimit(row.plan, row.publishedOfferLimitOverride),
        },
        seats: { used: counts.seats, limit: PLAN_LIMITS[row.plan].maxSeats },
      },
    };
  }
}

function averageRating(sum: number, count: number): number {
  return count === 0 ? 0 : sum / count;
}

/** null, not 0 — "no reviews yet" and "rated zero" are different things. */
function averageRatingOrNull(sum: number, count: number): number | null {
  return count === 0 ? null : Math.round((sum / count) * 10) / 10;
}

const PUBLIC_AGENCY_SELECT = {
  id: true, slug: true, name: true, description: true, logoUrl: true,
  status: true, verifiedAt: true, city: true, wilayaCode: true,
  phone: true, whatsapp: true, websiteUrl: true,
  ratingSum: true, ratingCount: true, createdAt: true,
} as const;

const AGENCY_SELECT = {
  ...PUBLIC_AGENCY_SELECT,
  legalName: true, email: true, addressLine: true,
  registreCommerce: true, nif: true, tourismLicence: true,
  plan: true, publishedOfferLimitOverride: true, rejectionReason: true,
} as const;

type PublicAgencyRow = Prisma.AgencyGetPayload<{ select: typeof PUBLIC_AGENCY_SELECT }>;
type AgencyRow = Prisma.AgencyGetPayload<{ select: typeof AGENCY_SELECT }>;
