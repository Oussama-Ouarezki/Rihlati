'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { OfferKind } from '@rihlati/shared';
import { Link } from '@/i18n/navigation';
import { createOffer } from '@/lib/offer-actions';
import { OfferForm } from '@/components/console/OfferForm';

/**
 * A client component because the kind selector swaps the whole second half of
 * the form live — picking "visa" must replace the Omra hotel fields
 * immediately, not after a round trip.
 */
export default function NewOfferPage() {
  const t = useTranslations('offerForm');
  const [kind, setKind] = useState<OfferKind>('omra');

  return (
    <div className="space-y-4">
      <Link href="/console/offers" className="text-sm text-slate-500 hover:text-brand-700">
        {t('backToList')}
      </Link>
      <h2 className="text-xl font-bold">{t('new')}</h2>
      <p className="text-sm text-slate-500">{t('reviewNote')}</p>

      <OfferForm action={createOffer} kind={kind} onKindChange={setKind} />
    </div>
  );
}
