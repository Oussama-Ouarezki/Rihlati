'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import type { ApiErrorBody } from '@rihlati/shared';
import { LOCALES } from '@rihlati/shared';
import { formText } from './form';
import { translateFieldError } from './validation-messages';
import { authedFetch, getSession } from './session';

export interface AccountState {
  error: string | null;
  ok: boolean;
}

const OK: AccountState = { error: null, ok: true };

/** Name and interface language. The picture has its own action — see below. */
export async function updateProfile(
  _previous: AccountState,
  formData: FormData,
): Promise<AccountState> {
  const t = await getTranslations('account');

  const displayName = formText(formData, 'displayName');
  const locale = formText(formData, 'locale');

  const response = await authedFetch('/v1/auth/me', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      displayName,
      ...((LOCALES as readonly string[]).includes(locale) ? { locale } : {}),
    }),
  });

  if (!response.ok) return { error: await messageFor(response, t), ok: false };

  revalidatePath('/', 'layout');
  return OK;
}

/**
 * The picture.
 *
 * The file goes browser → Next server → API as multipart, and the API returns
 * the URL it chose. The browser never names the URL, and the `Authorization`
 * header is attached on the server as with every other write.
 *
 * Note there is no `Content-Type` header set here: fetch derives the multipart
 * boundary from the FormData itself, and setting it by hand produces a body the
 * API cannot parse. That is a two-hour bug if you have not hit it before.
 */
export async function updateAvatar(
  _previous: AccountState,
  formData: FormData,
): Promise<AccountState> {
  const t = await getTranslations('account');

  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) return { error: t('errNoFile'), ok: false };

  const body = new FormData();
  body.append('file', file);

  const response = await authedFetch('/v1/auth/me/avatar', { method: 'POST', body });
  if (!response.ok) return { error: await messageFor(response, t), ok: false };

  revalidatePath('/', 'layout');
  return OK;
}

export async function removeAvatar(): Promise<void> {
  await authedFetch('/v1/auth/me/avatar', { method: 'DELETE' });
  revalidatePath('/', 'layout');
}

// ---------------------------------------------------------------------------
// AGENCY LOGO
// ---------------------------------------------------------------------------

export async function updateAgencyLogo(
  _previous: AccountState,
  formData: FormData,
): Promise<AccountState> {
  const t = await getTranslations('account');

  const session = await getSession();
  const agencyId = session?.membership?.agencyId;
  // Belt and braces: the API is the authority and would 404 anyway. This just
  // avoids a pointless round trip.
  if (!agencyId) return { error: t('errGeneric'), ok: false };

  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) return { error: t('errNoFile'), ok: false };

  const body = new FormData();
  body.append('file', file);

  const response = await authedFetch(`/v1/agencies/${agencyId}/logo`, { method: 'POST', body });
  if (!response.ok) return { error: await messageFor(response, t), ok: false };

  revalidatePath('/', 'layout');
  return OK;
}

export async function removeAgencyLogo(): Promise<void> {
  const session = await getSession();
  const agencyId = session?.membership?.agencyId;
  if (!agencyId) return;

  await authedFetch(`/v1/agencies/${agencyId}/logo`, { method: 'DELETE' });
  revalidatePath('/', 'layout');
}

/**
 * Turns the API's typed error code into a sentence in the reader's language.
 *
 * The API never sends translated prose (it has no idea whether this user reads
 * Arabic or French) — it sends a CODE, and the client owns the wording. When a
 * field-level message exists it wins, because "image trop lourde" is more
 * useful than "la modification a échoué".
 */
async function messageFor(
  response: Response,
  t: Awaited<ReturnType<typeof getTranslations<'account'>>>,
): Promise<string> {
  const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
  const tValidation = await getTranslations('validation');
  const fieldMessage = translateFieldError(
    tValidation,
    Object.values(body?.error?.fields ?? {})[0]?.[0],
  );
  if (fieldMessage) return fieldMessage;

  switch (body?.error?.code) {
    case 'RATE_LIMITED':
      return t('errRateLimited');
    case 'VALIDATION_FAILED':
      return t('errValidation');
    default:
      return t('errGeneric');
  }
}
