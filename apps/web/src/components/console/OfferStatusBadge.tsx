import { getTranslations } from 'next-intl/server';
import type { OfferStatus } from '@rihlati/shared';
import { Badge } from '@/components/ui/badge';

const STYLE: Record<OfferStatus, string> = {
  draft: 'bg-slate-100 text-slate-600',
  pending_review: 'bg-amber-50 text-amber-700',
  published: 'bg-emerald-50 text-emerald-700',
  paused: 'bg-sky-50 text-sky-700',
  archived: 'bg-slate-100 text-slate-400',
  rejected: 'bg-red-50 text-red-700',
};

const LABEL_KEY: Record<OfferStatus, string> = {
  draft: 'statusDraft',
  pending_review: 'statusPending',
  published: 'statusPublished',
  paused: 'statusPaused',
  archived: 'statusArchived',
  rejected: 'statusRejected',
};

export async function OfferStatusBadge(props: { status: OfferStatus }) {
  const t = await getTranslations('offerForm');
  return (
    <Badge variant="outline" className={`border-transparent ${STYLE[props.status]}`}>
      {t(LABEL_KEY[props.status])}
    </Badge>
  );
}
