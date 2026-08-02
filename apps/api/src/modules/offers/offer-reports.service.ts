import { Injectable } from '@nestjs/common';
import type { CreateOfferReportInput } from '@rihlati/shared';
import { AppError, notFound } from '../../common/errors/app-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import type { RequestMeta } from '../auth/auth.service';

/**
 * REPORTS
 *
 * A report is a signal, not an action. Nothing in this file hides, demotes or
 * deletes an offer at any report count — it increments a counter that orders
 * an admin queue, and a human decides.
 *
 * That restraint is the whole design. Rival agencies can report each other,
 * and organising ten reports in this market is one phone call. An auto-hide
 * threshold would hand every agency a button that removes a competitor.
 */
@Injectable()
export class OfferReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(
    offerId: string,
    input: CreateOfferReportInput,
    reporterUserId: string | null,
    meta: RequestMeta,
  ): Promise<{ ok: true }> {
    const offer = await this.prisma.offer.findFirst({
      where: { id: offerId, deletedAt: null },
      select: { id: true, agencyId: true },
    });
    if (!offer) throw notFound('Offre');

    /**
     * One report per person per offer.
     *
     * For logged-in users the database enforces it with a unique index. For
     * anonymous reports we can only compare hashed IPs, which a determined
     * person defeats in a minute — accepted, because the consequence of a
     * duplicate report is a slightly noisier queue, nothing more.
     */
    if (reporterUserId) {
      const existing = await this.prisma.offerReport.findUnique({
        where: { offerId_reporterUserId: { offerId, reporterUserId } },
        select: { id: true },
      });
      if (existing) {
        throw new AppError('ALREADY_REPORTED', 'Vous avez déjà signalé cette offre');
      }
    } else if (meta.ipHash) {
      const existing = await this.prisma.offerReport.findFirst({
        where: { offerId, reporterUserId: null, reporterIpHash: meta.ipHash },
        select: { id: true },
      });
      if (existing) {
        // Same answer as a real submission. Telling an anonymous reporter that
        // their IP already reported this is more information than they need.
        return { ok: true };
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.offerReport.create({
        data: {
          offerId,
          reporterUserId,
          reporterIpHash: meta.ipHash ?? null,
          reason: input.reason,
          details: input.details ?? null,
        },
      });

      // Denormalized counters so the admin triage queue is one indexed read
      // rather than a group-by over every report ever filed.
      //
      // updateMany rather than update, even though the id is unique and this
      // is a platform-level action on someone else's offer: keeping ONE way to
      // write to a tenant table means the lint rule needs no exceptions, and an
      // exception list is where the real mistake eventually hides.
      await tx.offer.updateMany({
        where: { id: offerId },
        data: { reportCount: { increment: 1 } },
      });
      await tx.agency.update({
        where: { id: offer.agencyId },
        data: { openReportCount: { increment: 1 } },
      });

      await this.audit.record(
        {
          action: 'offer.reported',
          entityType: 'offer',
          entityId: offerId,
          agencyId: offer.agencyId,
          actorUserId: reporterUserId,
          after: { reason: input.reason },
          ipHash: meta.ipHash ?? null,
          requestId: meta.requestId,
        },
        tx,
      );
    });

    return { ok: true };
  }
}
