import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  MAX_FAQ_ENTRIES,
  type AgencyFaqItem,
  type AgencyFaqItemForMember,
  type CreateFaqInput,
  type UpdateFaqInput,
} from '@rihlati/shared';
import { AppError, notFound } from '../../common/errors/app-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import type { TenantContext } from '../../common/auth/tenant-context';
import type { RequestMeta } from '../auth/auth.service';

/**
 * "Repeated questions", answered once by the agency.
 *
 * Two consumers: the public agency page today, and — later — the per-agency
 * chatbot, which answers ONLY from this table plus the agency's offers (see
 * obsidian/Backend/Agency Chatbot.md). That is why entries carry a locale and
 * an enabled flag: the bot needs to know what language an answer was written
 * in, and the agency needs a way to retire an answer without deleting it.
 */
@Injectable()
export class AgencyFaqService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Public: enabled entries of a VERIFIED agency. Unverified agencies 404. */
  async listPublicBySlug(slug: string): Promise<AgencyFaqItem[]> {
    const agency = await this.prisma.agency.findFirst({
      where: { slug, status: 'verified', deletedAt: null },
      select: { id: true },
    });
    if (!agency) throw notFound('Agence');

    const rows = await this.prisma.agencyFaq.findMany({
      where: { agencyId: agency.id, isEnabled: true },
      select: PUBLIC_SELECT,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      // Bounded by the MAX_FAQ_ENTRIES cap at create — this is why the list
      // needs no cursor.
      take: MAX_FAQ_ENTRIES,
    });

    return rows.map(toPublicItem);
  }

  /** The agency's own view: disabled entries included. */
  async listForAgency(tenant: TenantContext): Promise<AgencyFaqItemForMember[]> {
    const rows = await this.prisma.agencyFaq.findMany({
      where: { agencyId: tenant.agencyId },
      select: MEMBER_SELECT,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      take: MAX_FAQ_ENTRIES,
    });
    return rows.map(toMemberItem);
  }

  async create(
    tenant: TenantContext,
    actorUserId: string,
    input: CreateFaqInput,
    meta: RequestMeta,
  ): Promise<AgencyFaqItemForMember> {
    // The cap that keeps this table content, not a dumping ground — and keeps
    // the list endpoints bounded. Counted from the database, per rule #2.
    const count = await this.prisma.agencyFaq.count({
      where: { agencyId: tenant.agencyId },
    });
    if (count >= MAX_FAQ_ENTRIES) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Maximum ${MAX_FAQ_ENTRIES} questions. Supprimez-en avant d'en ajouter.`,
        { details: { limit: MAX_FAQ_ENTRIES, current: count } },
      );
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.agencyFaq.create({
        data: {
          agencyId: tenant.agencyId, // from the verified tenant, never the body
          question: input.question,
          answer: input.answer,
          locale: input.locale,
          isEnabled: input.isEnabled,
          sortOrder: input.sortOrder,
        },
        select: MEMBER_SELECT,
      });

      await this.audit.record(
        {
          action: 'agency.faq_created',
          entityType: 'agency_faq',
          entityId: row.id,
          agencyId: tenant.agencyId,
          actorUserId,
          after: { question: row.question },
          requestId: meta.requestId,
        },
        tx,
      );

      return row;
    });

    return toMemberItem(created);
  }

  async update(
    tenant: TenantContext,
    actorUserId: string,
    faqId: string,
    input: UpdateFaqInput,
    meta: RequestMeta,
  ): Promise<AgencyFaqItemForMember> {
    const before = await this.prisma.agencyFaq.findFirst({
      // id AND agencyId — another agency's entry is a 404, same as a missing one.
      where: { id: faqId, agencyId: tenant.agencyId },
      select: MEMBER_SELECT,
    });
    if (!before) throw notFound('Question');

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.agencyFaq.updateMany({
        where: { id: faqId, agencyId: tenant.agencyId },
        data: {
          ...(input.question !== undefined ? { question: input.question } : {}),
          ...(input.answer !== undefined ? { answer: input.answer } : {}),
          ...(input.locale !== undefined ? { locale: input.locale } : {}),
          ...(input.isEnabled !== undefined ? { isEnabled: input.isEnabled } : {}),
          ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        },
      });
      if (result.count === 0) throw notFound('Question');

      const after = await tx.agencyFaq.findFirstOrThrow({
        where: { id: faqId, agencyId: tenant.agencyId },
        select: MEMBER_SELECT,
      });

      const diff = AuditService.diff(before, input);
      await this.audit.record(
        {
          action: 'agency.faq_updated',
          entityType: 'agency_faq',
          entityId: faqId,
          agencyId: tenant.agencyId,
          actorUserId,
          before: diff.before,
          after: diff.after,
          requestId: meta.requestId,
        },
        tx,
      );

      return after;
    });

    return toMemberItem(updated);
  }

  async remove(
    tenant: TenantContext,
    actorUserId: string,
    faqId: string,
    meta: RequestMeta,
  ): Promise<{ ok: true }> {
    await this.prisma.$transaction(async (tx) => {
      // Hard delete, not soft: an FAQ entry is public content with no
      // relations pointing at it, and "disable" already exists for the
      // keep-but-hide case.
      const result = await tx.agencyFaq.deleteMany({
        where: { id: faqId, agencyId: tenant.agencyId },
      });
      if (result.count === 0) throw notFound('Question');

      await this.audit.record(
        {
          action: 'agency.faq_deleted',
          entityType: 'agency_faq',
          entityId: faqId,
          agencyId: tenant.agencyId,
          actorUserId,
          requestId: meta.requestId,
        },
        tx,
      );
    });

    return { ok: true };
  }
}

const PUBLIC_SELECT = {
  id: true,
  question: true,
  answer: true,
  locale: true,
  sortOrder: true,
} as const;

const MEMBER_SELECT = {
  ...PUBLIC_SELECT,
  isEnabled: true,
  createdAt: true,
  updatedAt: true,
} as const;

type PublicRow = Prisma.AgencyFaqGetPayload<{ select: typeof PUBLIC_SELECT }>;
type MemberRow = Prisma.AgencyFaqGetPayload<{ select: typeof MEMBER_SELECT }>;

function toPublicItem(row: PublicRow): AgencyFaqItem {
  return {
    id: row.id,
    question: row.question,
    answer: row.answer,
    locale: row.locale,
    sortOrder: row.sortOrder,
  };
}

function toMemberItem(row: MemberRow): AgencyFaqItemForMember {
  return {
    ...toPublicItem(row),
    isEnabled: row.isEnabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
