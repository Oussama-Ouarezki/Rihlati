'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import type {
  AdminAgencyListItem,
  AgencyStatus,
  ApiErrorBody,
  Page,
} from '@rihlati/shared';
import { formText } from './form';
import { authedFetch } from './session';

/**
 * THE BACK OFFICE, FROM THE WEB SIDE.
 *
 * Nothing here decides whether the caller is staff. The page hides itself from
 * a non-admin, and that is UX only — the API answers 403 to the same requests
 * whatever this file believes (rule #2). If you ever find yourself adding a
 * permission check here *instead of* in the API, stop: the browser is not
 * where permissions live.
 */

export interface AdminDecisionState {
  error: string | null;
  fields?: Record<string, string[]>;
  ok: boolean;
}

export async function listAgenciesForReview(
  status: AgencyStatus = 'pending_review',
): Promise<AdminAgencyListItem[]> {
  const response = await authedFetch(
    `/v1/admin/agencies?status=${encodeURIComponent(status)}&limit=50`,
  );
  // 403 for a non-admin is the expected answer, not a crash: the page renders
  // "not for you" rather than an error screen.
  if (!response.ok) return [];
  const page = (await response.json()) as Page<AdminAgencyListItem>;
  return page.items;
}

/** Grant the badge. `checkedNote` is required by the API, not by this form. */
export async function verifyAgency(
  _previous: AdminDecisionState,
  formData: FormData,
): Promise<AdminDecisionState> {
  const agencyId = formText(formData, 'agencyId');
  if (!agencyId) return { error: await genericError(), ok: false };

  return decide(`/v1/admin/agencies/${agencyId}/verify`, {
    checkedNote: formText(formData, 'checkedNote') ?? '',
  });
}

/**
 * Refuse, with a reason the agency owner reads word for word in their console.
 * `internalNote` never leaves the audit log.
 */
export async function rejectAgency(
  _previous: AdminDecisionState,
  formData: FormData,
): Promise<AdminDecisionState> {
  const agencyId = formText(formData, 'agencyId');
  if (!agencyId) return { error: await genericError(), ok: false };

  const internalNote = formText(formData, 'internalNote');
  return decide(`/v1/admin/agencies/${agencyId}/reject`, {
    reason: formText(formData, 'reason') ?? '',
    ...(internalNote ? { internalNote } : {}),
  });
}

async function decide(
  path: string,
  body: Record<string, string>,
): Promise<AdminDecisionState> {
  const t = await getTranslations('admin');

  const response = await authedFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as ApiErrorBody | null;
    return {
      error: errorMessage(payload?.error?.code, t),
      ...(payload?.error?.fields ? { fields: payload.error.fields } : {}),
      ok: false,
    };
  }

  revalidatePath('/admin', 'page');
  return { error: null, ok: true };
}

function errorMessage(
  code: string | undefined,
  t: Awaited<ReturnType<typeof getTranslations<'admin'>>>,
): string {
  switch (code) {
    case 'INVALID_STATUS_TRANSITION':
      // Almost always "another admin got there first" — worth saying plainly,
      // because the reviewer's next move is to reload, not to retry.
      return t('errAlreadyDecided');
    case 'FORBIDDEN':
      return t('errSelfReview');
    case 'PLATFORM_ADMIN_ONLY':
      return t('errNotAdmin');
    case 'VALIDATION_FAILED':
      return t('errValidation');
    default:
      return t('errGeneric');
  }
}

async function genericError(): Promise<string> {
  return (await getTranslations('admin'))('errGeneric');
}
