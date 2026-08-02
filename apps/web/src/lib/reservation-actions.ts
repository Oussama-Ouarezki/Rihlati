'use server';

import { revalidatePath } from 'next/cache';
import { RESERVATION_STATUSES, normalizeAlgerianPhone } from '@rihlati/shared';
import { formText } from './form';
import { authedFetch, getSession } from './session';

/** Manifest mutations — couriers to the API, like every console action. */

export async function setReservationStatus(reservationId: string, status: string): Promise<void> {
  const session = await getSession();
  const agencyId = session?.membership?.agencyId;
  if (!agencyId) return;
  if (!(RESERVATION_STATUSES as readonly string[]).includes(status)) return;

  await authedFetch(`/v1/agencies/${agencyId}/reservations/${reservationId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });

  revalidatePath('/', 'layout');
}

export async function createManualReservation(offerId: string, formData: FormData): Promise<void> {
  const session = await getSession();
  const agencyId = session?.membership?.agencyId;
  if (!agencyId) return;

  const contactName = formText(formData, 'name');
  const phone = normalizeAlgerianPhone(formText(formData, 'phone'));
  const peopleCount = Number(formText(formData, 'people'));
  const notes = formText(formData, 'notes');
  if (contactName.length < 2 || !phone) return;

  await authedFetch(`/v1/agencies/${agencyId}/reservations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      offerId,
      contactName,
      contactPhone: phone,
      peopleCount: Number.isFinite(peopleCount) && peopleCount >= 1 ? peopleCount : 1,
      ...(notes ? { notes } : {}),
    }),
  });

  revalidatePath('/', 'layout');
}

/** The CRM → manifest bridge, from the lead detail page. */
export async function reserveFromLead(leadId: string): Promise<void> {
  const session = await getSession();
  const agencyId = session?.membership?.agencyId;
  if (!agencyId) return;

  await authedFetch(`/v1/agencies/${agencyId}/reservations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leadId }),
  });

  revalidatePath('/', 'layout');
}

/**
 * Mint this family's /mon-voyage link if they haven't got one. Idempotent on
 * the API side — an existing code is returned, never rotated, because it may
 * already be sitting in a WhatsApp thread.
 */
export async function issueTripLink(reservationId: string): Promise<void> {
  const session = await getSession();
  const agencyId = session?.membership?.agencyId;
  if (!agencyId) return;

  await authedFetch(`/v1/agencies/${agencyId}/reservations/${reservationId}/trip-link`, {
    method: 'POST',
  });

  revalidatePath('/', 'layout');
}
