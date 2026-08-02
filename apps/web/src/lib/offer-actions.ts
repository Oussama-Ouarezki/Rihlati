'use server';

import { revalidatePath } from 'next/cache';
import { getLocale } from 'next-intl/server';
import {
  OFFER_KINDS,
  attributeFieldsFor,
  buildAttributes,
  type OfferKind,
} from '@rihlati/shared';
import { redirect } from '@/i18n/navigation';
import { formText } from './form';
import { authedFetch, getSession } from './session';

/**
 * Offer create/edit as server actions.
 *
 * These are couriers: they shape a FormData into the JSON the API expects and
 * forward it. Every rule — the publish quota, the review gate, who may touch
 * what — stays in the API, which re-validates the whole body with the same
 * Zod schema this form was generated from.
 */

export interface OfferFormState {
  error: string | null;
  fields?: Record<string, string[]>;
}

interface ApiError {
  error: { message: string; fields?: Record<string, string[]> };
}

/** Pulls the shared fields plus the kind's own attribute inputs. */
function readOfferForm(formData: FormData, kind: OfferKind) {
  const raw: Record<string, string | string[]> = {};
  for (const field of attributeFieldsFor(kind)) {
    if (field.type === 'multiselect') {
      raw[field.name] = formData
        .getAll(`attr.${field.name}`)
        .filter((value): value is string => typeof value === 'string');
    } else {
      raw[field.name] = formText(formData, `attr.${field.name}`);
    }
  }

  const priceFrom = Number(formText(formData, 'priceFrom'));
  const priceTo = Number(formText(formData, 'priceTo'));
  const duration = Number(formText(formData, 'durationDays'));
  const seats = Number(formText(formData, 'seatsTotal'));
  const mediaUrl = formText(formData, 'mediaUrl');

  return {
    title: formText(formData, 'title'),
    summary: formText(formData, 'summary') || undefined,
    description: formText(formData, 'description') || undefined,
    // DZD in the form, centimes on the wire — money is integer centimes
    // everywhere past this line (CLAUDE.md).
    priceFromCentimes: Number.isFinite(priceFrom) ? Math.round(priceFrom * 100) : 0,
    ...(Number.isFinite(priceTo) && priceTo > 0
      ? { priceToCentimes: Math.round(priceTo * 100) }
      : {}),
    ...(formText(formData, 'departureDate') ? { departureDate: formText(formData, 'departureDate') } : {}),
    ...(formText(formData, 'returnDate') ? { returnDate: formText(formData, 'returnDate') } : {}),
    ...(Number.isFinite(duration) && duration > 0 ? { durationDays: duration } : {}),
    isFlexibleDates: formData.get('isFlexibleDates') === 'on',
    ...(formText(formData, 'departureWilayaCode')
      ? { departureWilayaCode: formText(formData, 'departureWilayaCode') }
      : {}),
    ...(formText(formData, 'destinationCountry')
      ? { destinationCountry: formText(formData, 'destinationCountry') }
      : {}),
    ...(formText(formData, 'destinationCity')
      ? { destinationCity: formText(formData, 'destinationCity') }
      : {}),
    ...(Number.isFinite(seats) && seats > 0 ? { seatsTotal: seats } : {}),
    attributes: buildAttributes(kind, raw),
    ...(mediaUrl ? { media: [{ url: mediaUrl, kind: 'image' as const, order: 0 }] } : {}),
  };
}

/** Surfaces the API's field errors instead of a generic failure. */
async function toState(response: Response): Promise<OfferFormState> {
  try {
    const body = (await response.json()) as ApiError;
    return {
      error: body.error.message,
      ...(body.error.fields ? { fields: body.error.fields } : {}),
    };
  } catch {
    return { error: `HTTP ${response.status}` };
  }
}

export async function createOffer(
  _previous: OfferFormState,
  formData: FormData,
): Promise<OfferFormState> {
  const session = await getSession();
  const agencyId = session?.membership?.agencyId;
  if (!agencyId) return { error: 'unauthenticated' };

  const kind = formText(formData, 'kind') as OfferKind;
  if (!(OFFER_KINDS as readonly string[]).includes(kind)) return { error: 'invalid kind' };

  const response = await authedFetch(`/v1/agencies/${agencyId}/offers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, ...readOfferForm(formData, kind) }),
  });

  if (!response.ok) return toState(response);

  const created = (await response.json()) as { id: string };
  revalidatePath('/', 'layout');
  redirect({ href: `/console/offers/${created.id}`, locale: await getLocale() });
  return { error: null }; // unreachable; redirect throws
}

export async function updateOffer(
  offerId: string,
  kind: OfferKind,
  _previous: OfferFormState,
  formData: FormData,
): Promise<OfferFormState> {
  const session = await getSession();
  const agencyId = session?.membership?.agencyId;
  if (!agencyId) return { error: 'unauthenticated' };

  // `kind` is never sent on update: changing it would invalidate every stored
  // attribute, and the API omits it from updateOfferSchema for that reason.
  const response = await authedFetch(`/v1/agencies/${agencyId}/offers/${offerId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(readOfferForm(formData, kind)),
  });

  if (!response.ok) return toState(response);

  revalidatePath('/', 'layout');
  return { error: null };
}

/**
 * Status changes. An agency can only reach `pending_review`, `paused` and
 * `archived` — publishing is Rihlati's call, and the API enforces that
 * regardless of what this action sends.
 */
export async function changeOfferStatus(offerId: string, status: string): Promise<void> {
  const session = await getSession();
  const agencyId = session?.membership?.agencyId;
  if (!agencyId) return;

  await authedFetch(`/v1/agencies/${agencyId}/offers/${offerId}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });

  revalidatePath('/', 'layout');
}

export async function deleteOffer(offerId: string): Promise<void> {
  const session = await getSession();
  const agencyId = session?.membership?.agencyId;
  if (!agencyId) return;

  await authedFetch(`/v1/agencies/${agencyId}/offers/${offerId}`, { method: 'DELETE' });

  revalidatePath('/', 'layout');
  redirect({ href: '/console/offers', locale: await getLocale() });
}
