'use server';

import { revalidatePath } from 'next/cache';
import { formText } from './form';
import { authedFetch, getSession } from './session';

/** Tracked-link mutations — couriers to the API, like every console action. */

export async function createTrackedLink(formData: FormData): Promise<void> {
  const session = await getSession();
  const agencyId = session?.membership?.agencyId;
  if (!agencyId) return;

  const label = formText(formData, 'label');
  const offerId = formText(formData, 'offerId');
  if (label.length < 2) return;

  await authedFetch(`/v1/agencies/${agencyId}/tracked-links`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label, ...(offerId ? { offerId } : {}) }),
  });

  revalidatePath('/', 'layout');
}

export async function deleteTrackedLink(linkId: string): Promise<void> {
  const session = await getSession();
  const agencyId = session?.membership?.agencyId;
  if (!agencyId) return;

  await authedFetch(`/v1/agencies/${agencyId}/tracked-links/${linkId}`, { method: 'DELETE' });

  revalidatePath('/', 'layout');
}
