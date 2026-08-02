'use client';

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { normalizeAlgerianPhone } from '@rihlati/shared';
import { PUBLIC_API_BASE } from '@/lib/api';
import { readRef } from './RefCapture';

/**
 * The marketplace's one conversion event, as a form.
 *
 * Validation runs the SAME shared code as the server (normalizeAlgerianPhone
 * from @rihlati/shared), so the browser can never accept a phone number the
 * API will refuse. Client validation is UX; the API remains the security —
 * this form could be deleted entirely and nothing would become possible that
 * isn't already (CLAUDE.md rule #2).
 */
export function InquiryForm(props: { offerId: string }) {
  const t = useTranslations('inquiry');
  const [status, setStatus] = useState<'idle' | 'sending' | 'done'>('idle');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [agencyName, setAgencyName] = useState('');

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    // FormData.get returns string | File | null — these are all text inputs,
    // but the type doesn't know that, and String(File) is "[object Object]".
    const text = (key: string): string => {
      const value = form.get(key);
      return typeof value === 'string' ? value.trim() : '';
    };

    const name = text('name');
    const phoneRaw = text('phone');
    const email = text('email');
    const message = text('message');
    const people = Number(text('peopleCount'));
    const consent = form.get('consent') === 'on';

    const nextErrors: Record<string, string> = {};
    if (name.length < 2) nextErrors['name'] = t('errName');
    const phone = normalizeAlgerianPhone(phoneRaw);
    if (!phone) nextErrors['phone'] = t('errPhone');
    if (!consent) nextErrors['consent'] = t('errConsent');
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setStatus('sending');
    try {
      const response = await fetch(`${PUBLIC_API_BASE}/v1/inquiries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          offerId: props.offerId,
          contactName: name,
          contactPhone: phone,
          ...(email ? { contactEmail: email } : {}),
          ...(message ? { message } : {}),
          ...(Number.isFinite(people) && people >= 1 ? { peopleCount: people } : {}),
          // Which post brought them here, if any. Unknown codes are ignored
          // server-side, so a stale ref can never block the inquiry.
          ...(readRef() ? { ref: readRef() } : {}),
          consent: true,
        }),
      });
      if (!response.ok) throw new Error(String(response.status));

      const receipt = (await response.json()) as { agencyName: string };
      setAgencyName(receipt.agencyName);
      setStatus('done');
    } catch {
      setStatus('idle');
      setErrors({ form: t('errGeneric') });
    }
  }

  if (status === 'done') {
    return (
      <div className="rounded-xl bg-emerald-50 p-6 text-center">
        <p className="text-lg font-semibold text-emerald-800">{t('successTitle')}</p>
        <p className="mt-1 text-emerald-700">{t('successBody', { agency: agencyName })}</p>
      </div>
    );
  }

  const input =
    'w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 focus:border-brand-600 focus:outline-none';
  const errorText = 'mt-1 text-sm text-red-600';

  return (
    <form onSubmit={(event) => void onSubmit(event)} noValidate className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">{t('title')}</h2>
        <p className="text-sm text-slate-500">{t('subtitle')}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-sm font-medium">{t('name')}</span>
          <input name="name" autoComplete="name" className={input} />
          {errors['name'] ? <p className={errorText}>{errors['name']}</p> : null}
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium">{t('phone')}</span>
          {/* dir=ltr even in Arabic: phone numbers read left-to-right everywhere */}
          <input name="phone" type="tel" inputMode="tel" dir="ltr" autoComplete="tel" className={input} />
          <p className="mt-1 text-xs text-slate-400">{t('phoneHint')}</p>
          {errors['phone'] ? <p className={errorText}>{errors['phone']}</p> : null}
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium">{t('email')}</span>
          <input name="email" type="email" dir="ltr" autoComplete="email" className={input} />
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium">{t('peopleCount')}</span>
          <input name="peopleCount" type="number" min={1} max={200} defaultValue={1} className={input} />
        </label>
      </div>

      <label className="block">
        <span className="mb-1 block text-sm font-medium">{t('message')}</span>
        <textarea name="message" rows={3} placeholder={t('messagePlaceholder')} className={input} />
      </label>

      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="consent" className="mt-1 h-4 w-4 accent-brand-600" />
        <span>{t('consent')}</span>
      </label>
      {errors['consent'] ? <p className={errorText}>{errors['consent']}</p> : null}
      {errors['form'] ? <p className={errorText}>{errors['form']}</p> : null}

      <button
        type="submit"
        disabled={status === 'sending'}
        className="w-full rounded-xl bg-brand-600 px-6 py-3 font-semibold text-white hover:bg-brand-700 disabled:opacity-60 sm:w-auto"
      >
        {status === 'sending' ? t('sending') : t('submit')}
      </button>
    </form>
  );
}
