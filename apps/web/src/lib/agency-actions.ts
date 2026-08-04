'use server';

import { revalidatePath } from 'next/cache';
import { getLocale, getTranslations } from 'next-intl/server';
import type { AgencyForMember, ApiErrorBody } from '@rihlati/shared';
import { redirect } from '@/i18n/navigation';
import { formText } from './form';
import { authedFetch, getSession } from './session';

export interface AgencyFormState {
  error: string | null;
  fields?: Record<string, string[]>;
  ok: boolean;
  /** Echoed back so a rejected form does not wipe a long address. */
  values?: Record<string, string>;
}

/**
 * The fields an agency fills in about itself.
 *
 * `slug` is here for creation only — it is the public URL, and changing it
 * later breaks every link anyone has shared, so `updateAgencySchema` omits it
 * on the server too.
 */
const TEXT_FIELDS = [
  'name',
  'legalName',
  'description',
  'phone',
  'whatsapp',
  'email',
  'websiteUrl',
  'addressLine',
  'city',
  'wilayaCode',
  'registreCommerce',
  'nif',
  'tourismLicence',
] as const;

function readFields(formData: FormData): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of TEXT_FIELDS) {
    const value = formText(formData, field);
    if (value) values[field] = value;
  }
  return values;
}

/**
 * Create the agency. The caller becomes its owner, and it starts in `draft` —
 * invisible to travelers until a human at Rihlati checks the RC and licence.
 *
 * Note what this action does NOT send: no `status`, no `plan`, no `verifiedAt`.
 * They are not in the server's schema either, so an agency cannot verify
 * itself — which is the only reason the "verified" badge is worth anything to a
 * traveler about to hand over 400 000 DZD.
 */
export async function createAgency(
  _previous: AgencyFormState,
  formData: FormData,
): Promise<AgencyFormState> {
  const t = await getTranslations('agencyForm');
  const values = readFields(formData);
  const slug = formText(formData, 'slug');

  const response = await authedFetch('/v1/agencies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...values, slug }),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
    return {
      error: createErrorMessage(body?.error?.code, t),
      ...(body?.error?.fields ? { fields: body.error.fields } : {}),
      ok: false,
      values: { ...values, slug },
    };
  }

  revalidatePath('/', 'layout');
  redirect({ href: '/console/agence', locale: await getLocale() });
  return { error: null, ok: true }; // unreachable; redirect throws
}

export async function updateAgency(
  _previous: AgencyFormState,
  formData: FormData,
): Promise<AgencyFormState> {
  const t = await getTranslations('agencyForm');

  const session = await getSession();
  const agencyId = session?.membership?.agencyId;
  if (!agencyId) return { error: t('errGeneric'), ok: false };

  const values = readFields(formData);

  const response = await authedFetch(`/v1/agencies/${agencyId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(values),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
    return {
      error: createErrorMessage(body?.error?.code, t),
      ...(body?.error?.fields ? { fields: body.error.fields } : {}),
      ok: false,
      values,
    };
  }

  revalidatePath('/', 'layout');
  return { error: null, ok: true };
}

/** Ask Rihlati to verify. Owner only — the API enforces that, not this form. */
export async function submitAgencyForReview(): Promise<void> {
  const session = await getSession();
  const agencyId = session?.membership?.agencyId;
  if (!agencyId) return;

  await authedFetch(`/v1/agencies/${agencyId}/submit-for-review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });

  revalidatePath('/', 'layout');
}

export async function getMyAgency(): Promise<AgencyForMember | null> {
  const session = await getSession();
  const agencyId = session?.membership?.agencyId;
  if (!agencyId) return null;

  const response = await authedFetch(`/v1/agencies/${agencyId}`);
  if (!response.ok) return null;
  return (await response.json()) as AgencyForMember;
}

function createErrorMessage(
  code: string | undefined,
  t: Awaited<ReturnType<typeof getTranslations<'agencyForm'>>>,
): string {
  switch (code) {
    case 'SLUG_TAKEN':
      return t('errSlugTaken');
    case 'AGENCY_ALREADY_EXISTS':
      return t('errAlreadyOwns');
    case 'VALIDATION_FAILED':
      return t('errValidation');
    case 'RATE_LIMITED':
      return t('errRateLimited');
    case 'INSUFFICIENT_ROLE':
      return t('errRole');
    default:
      return t('errGeneric');
  }
}
