'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { translateFieldErrors } from '@/lib/validation-messages';
import { ChevronDown } from 'lucide-react';
import {
  OFFER_KINDS,
  attributeFieldsFor,
  WILAYAS,
  type AttributeField,
  type OfferForAgency,
  type OfferKind,
} from '@rihlati/shared';
import type { OfferFormState } from '@/lib/offer-actions';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';

const COUNTRY_CODES = ['SA', 'TR', 'TN', 'MA', 'EG', 'AE', 'QA', 'FR', 'ES', 'IT'] as const;

/**
 * One form for all seven offer kinds.
 *
 * The kind-specific half is generated from OFFER_ATTRIBUTE_FIELDS in
 * @rihlati/shared — the same descriptors a test pins against the Zod schemas.
 * So adding an offer kind never means writing a form: declare its fields and
 * this renders them, in all three languages, using the `attr.*` keys the
 * public offer page already uses.
 */
export function OfferForm(props: {
  action: (state: OfferFormState, formData: FormData) => Promise<OfferFormState>;
  /** Absent when creating. */
  offer?: OfferForAgency;
  /** Fixed on edit (changing kind would invalidate stored attributes). */
  kind: OfferKind;
  onKindChange?: (kind: OfferKind) => void;
}) {
  const t = useTranslations('offerForm');
  const tKinds = useTranslations('kinds');
  const tAttr = useTranslations('attr');
  const tValues = useTranslations('attrValues');
  const tCountries = useTranslations('countries');
  const tValidation = useTranslations('validation');

  const [state, formAction, pending] = useActionState<OfferFormState, FormData>(props.action, {
    error: null,
  });

  const offer = props.offer;
  const isEdit = Boolean(offer);
  const attributes: Record<string, unknown> = offer?.attributes ?? {};
  const hasAttributes = Object.keys(attributes).length > 0;

  /** Labels fall back to the raw key — a visible nudge to add the translation. */
  const attrLabel = (name: string): string => {
    try {
      return tAttr(name);
    } catch {
      return name;
    }
  };
  const valueLabel = (value: string): string => {
    try {
      return tValues(value);
    } catch {
      return value;
    }
  };

  return (
    <form action={formAction} className="space-y-6">
      {state.error ? (
        <div className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <p className="font-medium">{state.error}</p>
          {state.fields ? (
            <ul className="mt-1 list-disc ps-5 text-xs">
              {translateFieldErrors(tValidation, state.fields).map(([field, message]) => (
                <li key={field}>
                  {field}: {message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* ---- the essentials ---- */}
      <Card>
        <CardHeader>
          <CardTitle>{t('basics')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label>{t('kind')}</Label>
            {isEdit ? (
              <>
                <input type="hidden" name="kind" value={props.kind} />
                <p className="rounded-xl bg-muted px-3 py-2 text-sm">
                  {tKinds(props.kind)}
                  <span className="ms-2 text-xs text-muted-foreground">{t('kindLocked')}</span>
                </p>
              </>
            ) : (
              <Select
                name="kind"
                value={props.kind}
                onValueChange={(value) => props.onKindChange?.(value as OfferKind)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OFFER_KINDS.map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {tKinds(kind)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="title">{t('title')}</Label>
            <Input
              id="title"
              name="title"
              required
              minLength={8}
              maxLength={140}
              defaultValue={offer?.title ?? ''}
              placeholder={t('titlePlaceholder')}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="summary">{t('summary')}</Label>
            <Input id="summary" name="summary" maxLength={300} defaultValue={offer?.summary ?? ''} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="description">{t('description')}</Label>
            <Textarea
              id="description"
              name="description"
              rows={5}
              maxLength={8000}
              defaultValue={offer?.description ?? ''}
              placeholder={t('descriptionPlaceholder')}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="mediaUrl">{t('photoUrl')}</Label>
            <Input
              id="mediaUrl"
              name="mediaUrl"
              type="url"
              dir="ltr"
              defaultValue={offer?.media[0]?.url ?? ''}
              placeholder="https://…"
            />
            <span className="block text-xs text-muted-foreground">{t('photoHint')}</span>
          </div>
        </CardContent>
      </Card>

      {/* ---- price, dates, places: the filterable columns ---- */}
      <Card>
        <CardHeader>
          <CardTitle>{t('priceAndDates')}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="priceFrom">{t('priceFrom')}</Label>
            <Input
              id="priceFrom"
              name="priceFrom"
              type="number"
              min={0}
              step={1000}
              required
              defaultValue={offer ? offer.priceFromCentimes / 100 : ''}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="priceTo">{t('priceTo')}</Label>
            <Input
              id="priceTo"
              name="priceTo"
              type="number"
              min={0}
              step={1000}
              defaultValue={offer?.priceToCentimes ? offer.priceToCentimes / 100 : ''}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="departureDate">{t('departureDate')}</Label>
            <Input id="departureDate" name="departureDate" type="date" defaultValue={offer?.departureDate ?? ''} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="returnDate">{t('returnDate')}</Label>
            <Input id="returnDate" name="returnDate" type="date" defaultValue={offer?.returnDate ?? ''} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="durationDays">{t('durationDays')}</Label>
            <Input
              id="durationDays"
              name="durationDays"
              type="number"
              min={1}
              max={365}
              defaultValue={offer?.durationDays ?? ''}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="seatsTotal">{t('seatsTotal')}</Label>
            <Input
              id="seatsTotal"
              name="seatsTotal"
              type="number"
              min={1}
              max={10000}
              defaultValue={offer?.seatsTotal ?? ''}
            />
          </div>

          <div className="space-y-1.5">
            <Label>{t('departureWilaya')}</Label>
            <Select name="departureWilayaCode" defaultValue={offer?.departureWilayaCode ?? undefined}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                {WILAYAS.map((wilaya) => (
                  <SelectItem key={wilaya.code} value={wilaya.code}>
                    {wilaya.fr}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t('destinationCountry')}</Label>
            <Select name="destinationCountry" defaultValue={offer?.destinationCountry ?? undefined}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                {COUNTRY_CODES.map((code) => (
                  <SelectItem key={code} value={code}>
                    {tCountries(code)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="destinationCity">{t('destinationCity')}</Label>
            <Input id="destinationCity" name="destinationCity" maxLength={80} defaultValue={offer?.destinationCity ?? ''} />
          </div>

          <Label className="self-end pb-2">
            <Checkbox name="isFlexibleDates" defaultChecked={offer?.isFlexibleDates ?? false} />
            {t('flexibleDates')}
          </Label>
        </CardContent>
      </Card>

      {/* ---- the kind-specific half, generated from the shared descriptors ----
          Collapsed by default: every field here is optional (the schema in
          @rihlati/shared enforces that), so a first-time agency isn't faced
          with twenty blank boxes before they can save anything. Open by
          default on edit if some are already filled in, so nothing already
          entered hides silently. */}
      {/* `<summary>` must be `<details>`'s DIRECT child for the native
          disclosure toggle to work — so `<details>` wraps the summary AND
          the content, and `<Card>` wraps the whole thing purely for the
          visual frame. */}
      <Card className="p-0">
        <details className="group" open={hasAttributes}>
          <summary className="cursor-pointer list-none">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>
                  {tKinds(props.kind)}
                  <span className="ms-2 text-xs font-normal text-muted-foreground">
                    {t('attributesOptional')}
                  </span>
                </CardTitle>
                <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
              </div>
              <p className="text-xs text-muted-foreground">{t('attributesHint')}</p>
            </CardHeader>
          </summary>
          <CardContent className="grid gap-3 pb-(--card-spacing) sm:grid-cols-2">
            {attributeFieldsFor(props.kind).map((field) => (
              <AttributeInput
                key={field.name}
                field={field}
                label={attrLabel(field.name)}
                valueLabel={valueLabel}
                current={attributes[field.name]}
              />
            ))}
          </CardContent>
        </details>
      </Card>

      <Button type="submit" disabled={pending} size="lg" className="w-full sm:w-auto">
        {pending ? t('saving') : isEdit ? t('save') : t('create')}
      </Button>
    </form>
  );
}

function AttributeInput(props: {
  field: AttributeField;
  label: string;
  valueLabel: (value: string) => string;
  current: unknown;
}) {
  const { field, current } = props;
  const name = `attr.${field.name}`;

  if (field.type === 'boolean') {
    return (
      <Label className="sm:col-span-1">
        <Checkbox name={name} defaultChecked={current === true} />
        {props.label}
      </Label>
    );
  }

  if (field.type === 'select') {
    return (
      <div className="space-y-1.5">
        <Label>
          {props.label}
          {field.required ? ' *' : ''}
        </Label>
        <Select name={name} defaultValue={typeof current === 'string' ? current : undefined}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="—" />
          </SelectTrigger>
          <SelectContent>
            {field.options?.map((option) => (
              <SelectItem key={option} value={option}>
                {props.valueLabel(option)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }

  if (field.type === 'multiselect') {
    const selected = Array.isArray(current) ? (current as string[]) : [];
    return (
      <fieldset className="space-y-1.5 sm:col-span-2">
        <Label>{props.label}</Label>
        <div className="flex flex-wrap gap-2">
          {field.options?.map((option) => (
            <Label
              key={option}
              className="rounded-full bg-muted px-3 py-1 text-xs font-normal"
            >
              <Checkbox name={name} value={option} defaultChecked={selected.includes(option)} />
              {props.valueLabel(option)}
            </Label>
          ))}
        </div>
      </fieldset>
    );
  }

  if (field.type === 'tags') {
    const list = Array.isArray(current) ? (current as string[]).join(', ') : '';
    return (
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor={name}>{props.label}</Label>
        <Input id={name} name={name} defaultValue={list} placeholder="a, b, c" />
      </div>
    );
  }

  if (field.type === 'textarea') {
    return (
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor={name}>{props.label}</Label>
        <Textarea
          id={name}
          name={name}
          rows={2}
          maxLength={field.maxLength}
          defaultValue={typeof current === 'string' ? current : ''}
        />
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor={name}>
        {props.label}
        {field.required ? ' *' : ''}
      </Label>
      <Input
        id={name}
        name={name}
        type={field.type === 'number' ? 'number' : 'text'}
        required={field.required}
        min={field.min}
        max={field.max}
        maxLength={field.maxLength}
        defaultValue={
          typeof current === 'string' || typeof current === 'number' ? String(current) : ''
        }
      />
    </div>
  );
}
