import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { redact } from '../logging/logger';

/**
 * THE AUDIT LOG
 *
 * Append-only. Written for anything that changes trust, money, permissions, or
 * a judgement about a person.
 *
 * Why bother before there are users? Because the questions it answers cannot be
 * answered retroactively. "Who marked this client as a troll?" "Who changed
 * this price after the traveler paid?" "Did staff read this agency's leads?"
 * If the row was not written at the time, the answer is gone forever — and
 * these are exactly the questions that arrive as an angry phone call.
 *
 * It is also a security control: it is how you find out what a compromised
 * account touched.
 */

export type AuditAction =
  // identity
  | 'user.registered' | 'user.logged_in' | 'user.login_failed'
  | 'user.token_reuse_detected' | 'user.logged_out' | 'user.oauth_linked'
  // agencies
  | 'agency.created' | 'agency.updated' | 'agency.submitted_for_review'
  | 'agency.verified' | 'agency.rejected' | 'agency.suspended'
  | 'agency.plan_changed' | 'agency.offer_limit_overridden'
  | 'agency.faq_created' | 'agency.faq_updated' | 'agency.faq_deleted'
  | 'member.invited' | 'member.role_changed' | 'member.removed'
  // offers
  | 'offer.created' | 'offer.updated' | 'offer.status_changed' | 'offer.deleted'
  | 'offer.duplicate_flagged' | 'offer.duplicate_resolved'
  | 'offer.reported' | 'offer.report_reviewed'
  // leads — every one of these is a judgement about a real person
  | 'lead.created' | 'lead.stage_changed' | 'lead.quality_changed'
  | 'lead.assigned' | 'lead.note_added' | 'lead.deleted'
  // reservations — the manifest
  | 'reservation.created' | 'reservation.status_changed' | 'reservation.trip_link_issued'
  | 'offer_milestone.completion_changed'
  // trip programme — milestones & per-checkpoint attendance
  | 'offer_milestone.created' | 'offer_milestone.updated' | 'offer_milestone.deleted'
  | 'offer_milestone.reordered'
  | 'milestone_check_in.status_changed'
  // tracked links
  | 'tracked_link.created' | 'tracked_link.deleted'
  // reviews
  | 'review.created' | 'review.moderated' | 'review.replied';

export interface AuditEntry {
  action: AuditAction;
  entityType: string;
  entityId: string;
  actorUserId?: string | null;
  agencyId?: string | null;
  before?: unknown;
  after?: unknown;
  ipHash?: string | null;
  requestId?: string | null;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Write an audit row INSIDE the caller's transaction.
   *
   * Pass the transaction client whenever the audited change is itself a write.
   * If the change commits and the audit row does not, you have an unexplained
   * price change — which is worse than no audit log at all, because you will
   * trust it.
   */
  async record(entry: AuditEntry, tx?: Prisma.TransactionClient): Promise<void> {
    const client = tx ?? this.prisma;
    await client.auditLog.create({
      data: {
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        actorUserId: entry.actorUserId ?? null,
        agencyId: entry.agencyId ?? null,
        // The audit log is a database table, and rule #4's ban on logging
        // secrets applies to it exactly as much as to stdout. `before`/`after`
        // are raw rows, so they go through the same redaction.
        before: entry.before === undefined ? undefined : (redact(entry.before) as Prisma.InputJsonValue),
        after: entry.after === undefined ? undefined : (redact(entry.after) as Prisma.InputJsonValue),
        ipHash: entry.ipHash ?? null,
        requestId: entry.requestId ?? null,
      },
    });
  }

  /**
   * Only the fields that actually changed, so a diff is readable at a glance
   * and the table does not store a copy of every row on every edit.
   *
   * Both sides are plain records rather than a shared generic. A stored row and
   * the patch applied to it genuinely have different types — `departureDate` is
   * a `Date` in the database and a `"2027-03-01"` string in the request — and
   * forcing them into one type parameter only produced casts at every call
   * site. This is a diff for a log, not a typed merge; comparing with
   * `Object.is` and writing JSON is all it is meant to do.
   */
  static diff(
    before: Record<string, unknown>,
    after: Record<string, unknown>,
  ): { before: Record<string, unknown>; after: Record<string, unknown> } {
    const changedBefore: Record<string, unknown> = {};
    const changedAfter: Record<string, unknown> = {};

    for (const [key, nextValue] of Object.entries(after)) {
      // `undefined` means "not part of this patch", not "set to nothing".
      if (nextValue === undefined) continue;
      if (!Object.is(before[key], nextValue)) {
        changedBefore[key] = before[key];
        changedAfter[key] = nextValue;
      }
    }

    return { before: changedBefore, after: changedAfter };
  }
}
