'use server';

import { revalidatePath } from 'next/cache';
import { LOCALES } from '@rihlati/shared';
import { formText } from './form';
import { authedFetch, getSession } from './session';

/** FAQ mutations — couriers to the API, same pattern as lead-actions.ts. */

export async function createFaq(formData: FormData): Promise<void> {
  const session = await getSession();
  const agencyId = session?.membership?.agencyId;
  if (!agencyId) return;

  const question = formText(formData, 'question');
  const answer = formText(formData, 'answer');
  const locale = formText(formData, 'locale') || 'fr';
  if (question.length < 5 || !answer) return;

  await authedFetch(`/v1/agencies/${agencyId}/faq`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question,
      answer,
      locale: (LOCALES as readonly string[]).includes(locale) ? locale : 'fr',
    }),
  });

  revalidatePath('/', 'layout');
}

export async function toggleFaq(faqId: string, enable: boolean): Promise<void> {
  const session = await getSession();
  const agencyId = session?.membership?.agencyId;
  if (!agencyId) return;

  await authedFetch(`/v1/agencies/${agencyId}/faq/${faqId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ isEnabled: enable }),
  });

  revalidatePath('/', 'layout');
}

export async function deleteFaq(faqId: string): Promise<void> {
  const session = await getSession();
  const agencyId = session?.membership?.agencyId;
  if (!agencyId) return;

  await authedFetch(`/v1/agencies/${agencyId}/faq/${faqId}`, { method: 'DELETE' });

  revalidatePath('/', 'layout');
}
