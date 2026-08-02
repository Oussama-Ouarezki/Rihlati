'use server';

import { revalidatePath } from 'next/cache';
import { LEAD_QUALITIES, LEAD_STAGES } from '@rihlati/shared';
import { formText } from './form';
import { authedFetch, getSession } from './session';

/**
 * CRM mutations as server actions: the browser posts a form, the token stays
 * in its httpOnly cookie, and the API re-checks everything (membership, agent
 * scoping, plan gates) exactly as it would for any caller. These actions are
 * couriers, not decision-makers.
 *
 * Enum values are checked against the shared lists before the API call — not
 * for security (the API validates again) but so a typo'd form ships a clear
 * error in dev instead of a confusing 422.
 */

export async function updateLead(leadId: string, formData: FormData): Promise<void> {
  const session = await getSession();
  const agencyId = session?.membership?.agencyId;
  if (!agencyId) return;

  const stage = formText(formData, 'stage');
  const quality = formText(formData, 'quality');

  const body: Record<string, string> = {};
  if ((LEAD_STAGES as readonly string[]).includes(stage)) body['stage'] = stage;
  if ((LEAD_QUALITIES as readonly string[]).includes(quality)) body['quality'] = quality;
  if (Object.keys(body).length === 0) return;

  await authedFetch(`/v1/agencies/${agencyId}/leads/${leadId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  // Every fetch is no-store, so clearing the RSC cache is all a refresh needs.
  revalidatePath('/', 'layout');
}

export async function addLeadNote(leadId: string, formData: FormData): Promise<void> {
  const session = await getSession();
  const agencyId = session?.membership?.agencyId;
  if (!agencyId) return;

  const noteBody = formText(formData, 'body');
  if (!noteBody) return;

  await authedFetch(`/v1/agencies/${agencyId}/leads/${leadId}/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: noteBody }),
  });

  revalidatePath('/', 'layout');
}
