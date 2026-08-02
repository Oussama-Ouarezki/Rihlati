'use server';

import { revalidatePath } from 'next/cache';
import { getLocale } from 'next-intl/server';
import {
  CHECKPOINT_ATTENDANCE_STATUSES,
  CHECKPOINT_TYPES,
  MILESTONE_KINDS,
  type CheckpointType,
  type MilestoneKind,
} from '@rihlati/shared';
import { redirect } from '@/i18n/navigation';
import { formText } from './form';
import { authedFetch, getSession } from './session';

/**
 * Trip Programme mutations — couriers to the API, like every console action.
 * See obsidian/Backend/Trip Programme.md for the design these forms drive.
 */

export interface MilestoneFormState {
  error: string | null;
  fields?: Record<string, string[]>;
}

interface ApiError {
  error: { message: string; fields?: Record<string, string[]> };
}

async function toState(response: Response): Promise<MilestoneFormState> {
  try {
    const body = (await response.json()) as ApiError;
    return { error: body.error.message, ...(body.error.fields ? { fields: body.error.fields } : {}) };
  } catch {
    return { error: `HTTP ${response.status}` };
  }
}

function readMilestoneForm(formData: FormData) {
  const dayOffset = Number(formText(formData, 'dayOffset'));

  return {
    title: formText(formData, 'title'),
    description: formText(formData, 'description') || undefined,
    kind: formText(formData, 'kind') as MilestoneKind,
    dayOffset: Number.isFinite(dayOffset) && dayOffset >= 0 ? dayOffset : 0,
    ...(formText(formData, 'timeOfDay') ? { timeOfDay: formText(formData, 'timeOfDay') } : {}),
    ...(formText(formData, 'locationName') ? { locationName: formText(formData, 'locationName') } : {}),
    ...(formText(formData, 'meetingPoint') ? { meetingPoint: formText(formData, 'meetingPoint') } : {}),
    ...(formText(formData, 'mapUrl') ? { mapUrl: formText(formData, 'mapUrl') } : {}),
    checkpointType: formText(formData, 'checkpointType') as CheckpointType,
  };
}

export async function createMilestone(
  offerId: string,
  _previous: MilestoneFormState,
  formData: FormData,
): Promise<MilestoneFormState> {
  const session = await getSession();
  const agencyId = session?.membership?.agencyId;
  if (!agencyId) return { error: 'unauthenticated' };

  const kind = formText(formData, 'kind');
  if (!(MILESTONE_KINDS as readonly string[]).includes(kind)) return { error: 'invalid kind' };
  const checkpointType = formText(formData, 'checkpointType');
  if (!(CHECKPOINT_TYPES as readonly string[]).includes(checkpointType)) {
    return { error: 'invalid checkpointType' };
  }

  const response = await authedFetch(`/v1/agencies/${agencyId}/offers/${offerId}/milestones`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(readMilestoneForm(formData)),
  });

  if (!response.ok) return toState(response);

  revalidatePath('/', 'layout');
  return { error: null };
}

export async function updateMilestone(
  offerId: string,
  milestoneId: string,
  _previous: MilestoneFormState,
  formData: FormData,
): Promise<MilestoneFormState> {
  const session = await getSession();
  const agencyId = session?.membership?.agencyId;
  if (!agencyId) return { error: 'unauthenticated' };

  const response = await authedFetch(
    `/v1/agencies/${agencyId}/offers/${offerId}/milestones/${milestoneId}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(readMilestoneForm(formData)),
    },
  );

  if (!response.ok) return toState(response);

  revalidatePath('/', 'layout');
  return { error: null };
}

export async function deleteMilestone(offerId: string, milestoneId: string): Promise<void> {
  const session = await getSession();
  const agencyId = session?.membership?.agencyId;
  if (!agencyId) return;

  await authedFetch(`/v1/agencies/${agencyId}/offers/${offerId}/milestones/${milestoneId}`, {
    method: 'DELETE',
  });

  revalidatePath('/', 'layout');
  redirect({ href: `/console/offers/${offerId}/programme`, locale: await getLocale() });
}

/**
 * Up/down reordering, one swap at a time — simpler and more reliable on a
 * console than drag-and-drop, and it's the same `reorder` endpoint either way.
 */
export async function moveMilestone(
  offerId: string,
  orderedIds: string[],
  milestoneId: string,
  direction: 'up' | 'down',
): Promise<void> {
  const session = await getSession();
  const agencyId = session?.membership?.agencyId;
  if (!agencyId) return;

  const index = orderedIds.indexOf(milestoneId);
  const swapWith = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || swapWith < 0 || swapWith >= orderedIds.length) return;

  const next = [...orderedIds];
  const a = next[index];
  const b = next[swapWith];
  if (a === undefined || b === undefined) return;
  next[index] = b;
  next[swapWith] = a;

  await authedFetch(`/v1/agencies/${agencyId}/offers/${offerId}/milestones/reorder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderedIds: next }),
  });

  revalidatePath('/', 'layout');
}

/** The check-in tap, scoped to one checkpoint milestone. */
export async function setCheckpointAttendance(
  milestoneId: string,
  reservationId: string,
  status: string,
): Promise<void> {
  const session = await getSession();
  const agencyId = session?.membership?.agencyId;
  if (!agencyId) return;
  if (!(CHECKPOINT_ATTENDANCE_STATUSES as readonly string[]).includes(status)) return;

  await authedFetch(`/v1/agencies/${agencyId}/milestones/${milestoneId}/check-ins/${reservationId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });

  revalidatePath('/', 'layout');
}

/**
 * Tick a step off as it happens — the tap that advances every traveler's
 * "vous êtes ici" marker at once. `isDone: false` is the undo.
 */
export async function setMilestoneCompletion(
  offerId: string,
  milestoneId: string,
  isDone: boolean,
): Promise<void> {
  const session = await getSession();
  const agencyId = session?.membership?.agencyId;
  if (!agencyId) return;

  await authedFetch(
    `/v1/agencies/${agencyId}/offers/${offerId}/milestones/${milestoneId}/completion`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isDone }),
    },
  );

  revalidatePath('/', 'layout');
}
