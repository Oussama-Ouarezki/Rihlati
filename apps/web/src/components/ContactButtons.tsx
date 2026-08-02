'use client';

import { useTranslations } from 'next-intl';
import { PUBLIC_API_BASE } from '@/lib/api';

/**
 * The WhatsApp / call buttons — in Algeria this IS the conversion path for a
 * large share of travelers, which is exactly why each tap fires the metrics
 * beacon: without it the agency's chart would show views and inquiries but
 * miss the contacts that happened off-platform.
 *
 * `keepalive` lets the request survive the navigation the tap triggers, and
 * a beacon failure is swallowed — analytics must never block a contact.
 */
export function ContactButtons(props: {
  offerId: string;
  offerTitle: string;
  whatsapp: string | null;
  phone: string | null;
}) {
  const t = useTranslations('offer');

  const beacon = (type: 'whatsapp_click' | 'phone_click') => {
    void fetch(`${PUBLIC_API_BASE}/v1/offers/${props.offerId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type }),
      keepalive: true,
    }).catch(() => undefined);
  };

  if (!props.whatsapp && !props.phone) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {props.whatsapp ? (
        <a
          href={`https://wa.me/${props.whatsapp.replace('+', '')}?text=${encodeURIComponent(
            t('whatsappText', { title: props.offerTitle }),
          )}`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => beacon('whatsapp_click')}
          className="rounded-xl bg-emerald-600 px-5 py-2.5 font-semibold text-white hover:bg-emerald-700"
        >
          {t('contactWhatsapp')}
        </a>
      ) : null}
      {props.phone ? (
        <a
          href={`tel:${props.phone}`}
          onClick={() => beacon('phone_click')}
          className="rounded-xl border border-slate-300 px-5 py-2.5 font-semibold text-slate-700 hover:bg-slate-50"
        >
          {t('call')}
        </a>
      ) : null}
    </div>
  );
}
