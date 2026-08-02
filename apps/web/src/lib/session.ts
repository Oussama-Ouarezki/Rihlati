import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { getLocale } from 'next-intl/server';
import type { SessionMembership, SessionUser } from '@rihlati/shared';
import { redirect } from '@/i18n/navigation';
import { ACCESS_COOKIE } from './session-cookies';

const API_BASE =
  process.env['API_URL'] ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:4000';

export interface Session {
  user: SessionUser;
  /** The first agency membership — v1 has no multi-agency switcher yet. */
  membership: SessionMembership | null;
  accessToken: string;
}

/**
 * The current session, or null. `cache()` deduplicates it per request, so the
 * layout and the page asking the same question costs one API call, not two.
 */
export const getSession = cache(async (): Promise<Session | null> => {
  const store = await cookies();
  const accessToken = store.get(ACCESS_COOKIE)?.value;
  if (!accessToken) return null;

  const response = await fetch(`${API_BASE}/v1/auth/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
  });
  if (!response.ok) return null;

  const user = (await response.json()) as SessionUser;
  return { user, membership: user.memberships[0] ?? null, accessToken };
});

export async function redirectToLogin(): Promise<never> {
  const locale = await getLocale();
  redirect({ href: '/connexion', locale });
  throw new Error('unreachable'); // redirect() throws; this satisfies the type
}

/**
 * Authenticated call to the API, server-side only. The Bearer header is
 * attached here and nowhere else — grep for ACCESS_COOKIE to audit every
 * place a token is read.
 */
export async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const store = await cookies();
  const accessToken = store.get(ACCESS_COOKIE)?.value;
  if (!accessToken) await redirectToLogin();

  return fetch(`${API_BASE}${path}`, {
    ...init,
    cache: 'no-store',
    headers: {
      ...init?.headers,
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
}

export async function authedGet<T>(path: string): Promise<T> {
  const response = await authedFetch(path);
  if (response.status === 401) await redirectToLogin();
  if (!response.ok) {
    throw new Error(
      `API ${response.status} on ${path} (requestId: ${response.headers.get('x-request-id') ?? '—'})`,
    );
  }
  return (await response.json()) as T;
}
