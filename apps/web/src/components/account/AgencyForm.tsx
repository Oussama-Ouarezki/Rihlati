'use client';

import { useActionState, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { WILAYAS, type AgencyForMember } from '@rihlati/shared';
import type { AgencyFormState } from '@/lib/agency-actions';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/**
 * The editable text fields, as they exist on `AgencyForMember`. Keeping the
 * union explicit is what stops `initial()` reaching a non-string property.
 */
type TextField =
  | 'name'
  | 'legalName'
  | 'description'
  | 'phone'
  | 'whatsapp'
  | 'email'
  | 'websiteUrl'
  | 'addressLine'
  | 'city'
  | 'wilayaCode'
  | 'registreCommerce'
  | 'nif'
  | 'tourismLicence';

/**
 * One form for creating an agency and for editing it afterwards.
 *
 * The `slug` field only appears when creating: it is the agency's public URL,
 * and letting it change later would break every link already shared on WhatsApp
 * — which is how almost all of this traffic will arrive.
 */
export function AgencyForm(props: {
  action: (state: AgencyFormState, formData: FormData) => Promise<AgencyFormState>;
  agency?: AgencyForMember;
  submitLabel: string;
}) {
  const t = useTranslations('agencyForm');
  const locale = useLocale();
  const [state, formAction, pending] = useActionState<AgencyFormState, FormData>(props.action, {
    error: null,
    ok: false,
  });

  const creating = props.agency === undefined;

  /**
   * A rejected submission wins over the stored value, so a validation error
   * never silently discards what was just typed.
   *
   * Only the string-valued keys are read: `AgencyForMember` also carries
   * `limits`, an object, and stringifying that would put "[object Object]" in
   * an input. The type parameter is what makes that a compile error rather than
   * a thing you notice in the browser.
   */
  const initial = (field: TextField): string =>
    state.values?.[field] ?? props.agency?.[field] ?? '';
  const fieldError = (field: string): string | null => state.fields?.[field]?.[0] ?? null;


  // Built once per locale rather than per render: 58 wilayas rebuilt on every
  // keystroke in the name field is work for nothing.
  const wilayaLabels = useMemo(
    () =>
      Object.fromEntries(
        WILAYAS.map((wilaya) => [
          wilaya.code,
          `${wilaya.code} — ${locale === 'ar' ? wilaya.ar : wilaya.fr}`,
        ]),
      ),
    [locale],
  );

  // Derived from the name while creating, then left alone once touched — so a
  // first-time user never has to understand what a "slug" is.
  const [slug, setSlug] = useState(state.values?.['slug'] ?? '');
  const [slugTouched, setSlugTouched] = useState(Boolean(state.values?.['slug']));

  return (
    <form action={formAction} className="space-y-8">
      <Section title={t('sectionIdentity')} description={t('sectionIdentityHelp')}>
        <Field
          name="name"
          label={t('name')}
          required
          defaultValue={initial('name')}
          error={fieldError('name')}
          onChange={(value) => {
            if (creating && !slugTouched) setSlug(slugify(value));
          }}
        />

        {creating ? (
          <div className="space-y-1.5">
            <Label htmlFor="slug">{t('slug')}</Label>
            <div className="flex items-center gap-1" dir="ltr">
              <span className="shrink-0 text-sm text-muted-foreground">rihlati.dz/a/</span>
              <Input
                id="slug"
                name="slug"
                dir="ltr"
                value={slug}
                onChange={(event) => {
                  setSlugTouched(true);
                  setSlug(slugify(event.target.value));
                }}
                aria-invalid={fieldError('slug') ? true : undefined}
              />
            </div>
            {fieldError('slug') ? (
              <p className="text-sm text-destructive">{fieldError('slug')}</p>
            ) : (
              <p className="text-xs text-muted-foreground">{t('slugHint')}</p>
            )}
          </div>
        ) : null}

        <Field
          name="legalName"
          label={t('legalName')}
          hint={t('legalNameHint')}
          defaultValue={initial('legalName')}
          error={fieldError('legalName')}
        />

        <div className="space-y-1.5">
          <Label htmlFor="description">{t('description')}</Label>
          <Textarea
            id="description"
            name="description"
            rows={4}
            defaultValue={initial('description')}
            placeholder={t('descriptionPlaceholder')}
          />
          <p className="text-xs text-muted-foreground">{t('descriptionHint')}</p>
        </div>
      </Section>

      <Section title={t('sectionContact')} description={t('sectionContactHelp')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            name="phone"
            label={t('phone')}
            type="tel"
            dir="ltr"
            defaultValue={initial('phone')}
            error={fieldError('phone')}
          />
          <Field
            name="whatsapp"
            label={t('whatsapp')}
            hint={t('whatsappHint')}
            type="tel"
            dir="ltr"
            defaultValue={initial('whatsapp')}
            error={fieldError('whatsapp')}
          />
          <Field
            name="email"
            label={t('email')}
            type="email"
            dir="ltr"
            defaultValue={initial('email')}
            error={fieldError('email')}
          />
          <Field
            name="websiteUrl"
            label={t('websiteUrl')}
            hint={t('websiteUrlHint')}
            dir="ltr"
            defaultValue={initial('websiteUrl')}
            error={fieldError('websiteUrl')}
          />
        </div>
      </Section>

      <Section title={t('sectionLocation')} description={t('sectionLocationHelp')}>
        <div className="space-y-1.5">
          <Label>{t('wilaya')}</Label>
          {/* `items` is what lets the closed trigger read "16 — Alger" instead
              of the bare stored code "16". */}
          <Select
            name="wilayaCode"
            defaultValue={initial('wilayaCode') || undefined}
            items={wilayaLabels}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder={t('wilayaPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {WILAYAS.map((wilaya) => (
                <SelectItem key={wilaya.code} value={wilaya.code}>
                  {wilayaLabels[wilaya.code]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field name="city" label={t('city')} defaultValue={initial('city')} error={fieldError('city')} />
          <Field
            name="addressLine"
            label={t('addressLine')}
            defaultValue={initial('addressLine')}
            error={fieldError('addressLine')}
          />
        </div>
      </Section>

      <Section title={t('sectionLegal')} description={t('sectionLegalHelp')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            name="registreCommerce"
            label={t('registreCommerce')}
            dir="ltr"
            defaultValue={initial('registreCommerce')}
            error={fieldError('registreCommerce')}
          />
          <Field
            name="nif"
            label={t('nif')}
            dir="ltr"
            defaultValue={initial('nif')}
            error={fieldError('nif')}
          />
          <Field
            name="tourismLicence"
            label={t('tourismLicence')}
            hint={t('tourismLicenceHint')}
            dir="ltr"
            defaultValue={initial('tourismLicence')}
            error={fieldError('tourismLicence')}
          />
        </div>
      </Section>

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.ok ? <p className="text-sm text-emerald-700">{t('saved')}</p> : null}

      <Button type="submit" size="lg" disabled={pending}>
        {pending ? t('saving') : props.submitLabel}
      </Button>
    </form>
  );
}

function Section(props: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="font-semibold">{props.title}</h2>
        <p className="text-sm text-muted-foreground">{props.description}</p>
      </div>
      {props.children}
    </section>
  );
}

function Field(props: {
  name: string;
  label: string;
  hint?: string;
  type?: string;
  dir?: 'ltr';
  required?: boolean;
  defaultValue: string;
  error: string | null;
  onChange?: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={props.name}>{props.label}</Label>
      <Input
        id={props.name}
        name={props.name}
        type={props.type}
        dir={props.dir}
        required={props.required}
        defaultValue={props.defaultValue}
        onChange={props.onChange ? (event) => props.onChange!(event.target.value) : undefined}
        aria-invalid={props.error ? true : undefined}
      />
      {props.error ? (
        <p className="text-sm text-destructive">{props.error}</p>
      ) : props.hint ? (
        <p className="text-xs text-muted-foreground">{props.hint}</p>
      ) : null}
    </div>
  );
}

/**
 * Mirrors `agencySlugSchema` in the shared package: lowercase letters, digits
 * and single hyphens. This is a CONVENIENCE so the field fills itself in — the
 * server validates the same rule and is the one that decides.
 */
function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents: "Béjaïa" → "Bejaia"
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
