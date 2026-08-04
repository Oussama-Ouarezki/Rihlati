'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { LOCALES } from '@rihlati/shared';
import { updateProfile, type AccountState } from '@/lib/account-actions';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/**
 * Name and interface language.
 *
 * Email and phone are shown but not editable: changing the identifier you log
 * in with is an account-recovery action, not a profile edit — it needs the
 * current password and a verification round trip, and neither exists yet.
 */
export function ProfileForm(props: {
  displayName: string;
  locale: string;
  email: string | null;
  phone: string | null;
}) {
  const t = useTranslations('account');
  const [state, formAction, pending] = useActionState<AccountState, FormData>(updateProfile, {
    error: null,
    ok: false,
  });

  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="displayName">{t('displayName')}</Label>
        <Input id="displayName" name="displayName" defaultValue={props.displayName} />
      </div>

      <div className="space-y-1.5">
        <Label>{t('language')}</Label>
        {/* `items` maps each value to its label. Without it the closed trigger
            shows the raw stored value — the user picks "Français" and the box
            then reads "fr". */}
        <Select name="locale" defaultValue={props.locale} items={LOCALE_LABELS(t)}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LOCALES.map((locale) => (
              <SelectItem key={locale} value={locale}>
                {t(`locale_${locale}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <ReadOnly label={t('email')} value={props.email} empty={t('notSet')} />
        <ReadOnly label={t('phone')} value={props.phone} empty={t('notSet')} />
      </div>
      <p className="text-xs text-muted-foreground">{t('identifierHint')}</p>

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.ok ? <p className="text-sm text-emerald-700">{t('saved')}</p> : null}

      <Button type="submit" disabled={pending}>
        {pending ? t('saving') : t('save')}
      </Button>
    </form>
  );
}

const LOCALE_LABELS = (
  t: ReturnType<typeof useTranslations<'account'>>,
): Record<string, string> =>
  Object.fromEntries(LOCALES.map((locale) => [locale, t(`locale_${locale}`)]));

function ReadOnly(props: { label: string; value: string | null; empty: string }) {
  return (
    <div className="space-y-1.5">
      <Label>{props.label}</Label>
      <p dir={props.value ? 'ltr' : undefined} className="truncate rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-600">
        {props.value ?? props.empty}
      </p>
    </div>
  );
}
