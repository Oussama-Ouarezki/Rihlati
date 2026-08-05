'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { AdminAgencyListItem } from '@rihlati/shared';
import type { AdminDecisionState } from '@/lib/admin-actions';
import { translateFieldError } from '@/lib/validation-messages';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

const EMPTY: AdminDecisionState = { error: null, ok: false };

/**
 * One agency awaiting a decision.
 *
 * The layout is deliberately dull: it is a form for reading numbers off a
 * document and typing what you saw. The one design opinion in it is that
 * neither button submits on its own — each opens a panel that demands a
 * sentence first. Verification is the promise the whole marketplace rests on,
 * so a one-click "approve" is the wrong shape, even when it is faster.
 */
export function ReviewCard(props: {
  agency: AdminAgencyListItem;
  verifyAction: (state: AdminDecisionState, formData: FormData) => Promise<AdminDecisionState>;
  rejectAction: (state: AdminDecisionState, formData: FormData) => Promise<AdminDecisionState>;
  waitingDays: number | null;
  wilaya: string | null;
}) {
  const t = useTranslations('admin');
  const tValidation = useTranslations('validation');
  const [panel, setPanel] = useState<'none' | 'verify' | 'reject'>('none');

  const [verifyState, verify, verifying] = useActionState(props.verifyAction, EMPTY);
  const [rejectState, reject, rejecting] = useActionState(props.rejectAction, EMPTY);

  const agency = props.agency;
  const state = panel === 'verify' ? verifyState : rejectState;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="truncate">{agency.name}</CardTitle>
            <CardDescription className="truncate">
              {agency.legalName ?? agency.slug}
            </CardDescription>
          </div>
          {props.waitingDays !== null ? (
            <span
              className={
                props.waitingDays >= 7
                  ? 'rounded-full bg-red-50 px-3 py-1 text-xs font-medium text-red-900'
                  : 'rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700'
              }
            >
              {t('waiting', { days: props.waitingDays })}
            </span>
          ) : null}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* What is actually being checked. */}
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <Field label={t('rc')} value={agency.registreCommerce} mono />
          <Field label={t('nif')} value={agency.nif} mono />
          <Field label={t('licence')} value={agency.tourismLicence} mono />
          <Field label={t('wilaya')} value={props.wilaya} />
          <Field label={t('address')} value={agency.addressLine} bidi="auto" />
          <Field label={t('city')} value={agency.city} bidi="auto" />
          <Field label={t('phone')} value={agency.phone} bidi="ltr" />
          <Field label={t('website')} value={agency.websiteUrl} bidi="ltr" />
          <Field
            label={t('owner')}
            bidi="auto"
            value={
              agency.owner
                ? [agency.owner.displayName, agency.owner.email, agency.owner.phone]
                    .filter(Boolean)
                    .join(' · ')
                : null
            }
          />
        </dl>

        {state.error ? (
          <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-900">{state.error}</p>
        ) : null}

        {panel === 'none' ? (
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => setPanel('verify')}>
              {t('verify')}
            </Button>
            <Button type="button" variant="outline" onClick={() => setPanel('reject')}>
              {t('reject')}
            </Button>
          </div>
        ) : null}

        {panel === 'verify' ? (
          <form action={verify} className="space-y-3 rounded-2xl bg-slate-50 p-4">
            <input type="hidden" name="agencyId" value={agency.id} />
            <div className="space-y-1">
              <Label htmlFor={`checked-${agency.id}`}>{t('checkedNoteLabel')}</Label>
              {/* The whole reason this field is required — say so, here. */}
              <p className="text-xs text-slate-600">{t('checkedNoteHelp')}</p>
              <Textarea
                id={`checked-${agency.id}`}
                name="checkedNote"
                rows={3}
                required
                minLength={10}
                placeholder={t('checkedNotePlaceholder')}
              />
              <FieldError t={tValidation} message={state.fields?.['checkedNote']?.[0]} />
            </div>
            <div className="flex gap-2">
              <Button type="submit" disabled={verifying}>
                {verifying ? t('working') : t('confirmVerify')}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setPanel('none')}>
                {t('cancel')}
              </Button>
            </div>
          </form>
        ) : null}

        {panel === 'reject' ? (
          <form action={reject} className="space-y-3 rounded-2xl bg-slate-50 p-4">
            <input type="hidden" name="agencyId" value={agency.id} />
            <div className="space-y-1">
              <Label htmlFor={`reason-${agency.id}`}>{t('reasonLabel')}</Label>
              {/* Owner-visible. Saying so above the box is the whole safeguard. */}
              <p className="text-xs text-slate-600">{t('reasonHelp')}</p>
              <Textarea
                id={`reason-${agency.id}`}
                name="reason"
                rows={3}
                required
                minLength={10}
                placeholder={t('reasonPlaceholder')}
              />
              <FieldError t={tValidation} message={state.fields?.['reason']?.[0]} />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`note-${agency.id}`}>{t('internalNoteLabel')}</Label>
              <p className="text-xs text-slate-600">{t('internalNoteHelp')}</p>
              <Textarea id={`note-${agency.id}`} name="internalNote" rows={2} />
            </div>
            <div className="flex gap-2">
              <Button type="submit" variant="destructive" disabled={rejecting}>
                {rejecting ? t('working') : t('confirmReject')}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setPanel('none')}>
                {t('cancel')}
              </Button>
            </div>
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * BIDI ISOLATION — the reason `<bdi>` is here and `dir` is not on the card.
 *
 * In Arabic the page runs right-to-left, and the bidi algorithm then moves a
 * leading "+" to the other end: `+213661234567` displays as `213661234567+`,
 * and `12 rue Didouche Mourad` becomes `rue Didouche Mourad 12`. On a screen
 * whose entire job is reading identifiers off a document accurately, that is
 * not cosmetic — it is the wrong number.
 *
 * Two different fixes, because there are two different cases:
 *   - `ltr`  — an RC, a NIF, a URL, a phone. Always Latin script and digits,
 *              whatever language the reader speaks. Force the direction.
 *   - `auto` — an address, a city, a person's name. USER-ENTERED, and it may
 *              arrive in Arabic or in French. Forcing `ltr` here would break
 *              the Arabic ones exactly as badly as leaving it broke the French
 *              ones, so let the browser decide from the first strong character.
 *
 * `<bdi>` rather than `dir` on the `<dd>`: it isolates direction without
 * changing the block's text alignment, so the value stays aligned with its
 * label instead of jumping to the other side of the column.
 */
function Field(props: {
  label: string;
  value: string | null;
  mono?: boolean;
  bidi?: 'ltr' | 'auto';
}) {
  // A mono field is always an identifier, so it is always left-to-right.
  const direction = props.mono === true ? 'ltr' : props.bidi;

  return (
    <div className="min-w-0">
      <dt className="text-xs uppercase tracking-wide text-slate-500">{props.label}</dt>
      <dd className={`truncate ${props.mono ? 'font-mono text-xs' : ''} ${props.value ? '' : 'text-slate-400'}`}>
        {props.value === null ? (
          '—'
        ) : direction ? (
          <bdi dir={direction}>{props.value}</bdi>
        ) : (
          props.value
        )}
      </dd>
    </div>
  );
}

function FieldError(props: { t: (key: string) => string; message: string | undefined }) {
  const text = translateFieldError(props.t, props.message);
  return text ? <p className="text-sm text-red-700">{text}</p> : null;
}
