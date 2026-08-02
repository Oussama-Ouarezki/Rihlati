'use server';

import { cookies } from 'next/headers';
import { getLocale, getTranslations } from 'next-intl/server';
import type { AuthResult } from '@rihlati/shared';
import { redirect } from '@/i18n/navigation';
import { formText } from './form';
import {
  ACCESS_COOKIE,
  ACCESS_MAX_AGE,
  REFRESH_COOKIE,
  REFRESH_MAX_AGE,
  cookieOptions,
} from './session-cookies';

const API_BASE =
  process.env['API_URL'] ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:4000';

export interface LoginState {
  error: string | null;
  /**
   * Echoed back so a failed attempt does not wipe what the user typed.
   * The PASSWORD is deliberately never echoed — it would end up in the
   * rendered HTML, and therefore in any page cache or screenshot.
   */
  identifier?: string;
}

/**
 * Login as a server action: the password crosses exactly two wires (browser →
 * Next server → API) and the resulting tokens land in httpOnly cookies
 * without ever existing in browser JavaScript.
 */
export async function login(_previous: LoginState, formData: FormData): Promise<LoginState> {
  const t = await getTranslations('console');

  const identifier = formText(formData, 'identifier');
  const password = formText(formData, 'password');
  if (!identifier || !password) return { error: t('errInvalid'), identifier };

  const response = await fetch(`${API_BASE}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, password }),
    cache: 'no-store',
  });

  if (!response.ok) {
    // INVALID_CREDENTIALS and RATE_LIMITED both land here; the generic
    // message is deliberate — the login form must not narrate which it was.
    return { error: t('errInvalid'), identifier };
  }

  const result = (await response.json()) as AuthResult;

  const store = await cookies();
  store.set(ACCESS_COOKIE, result.tokens.accessToken, cookieOptions(ACCESS_MAX_AGE));
  store.set(REFRESH_COOKIE, result.tokens.refreshToken, cookieOptions(REFRESH_MAX_AGE));

  redirect({ href: '/console', locale: await getLocale() });
  return { error: null }; // unreachable; redirect throws
}

export async function logout(): Promise<void> {
  const store = await cookies();
  const accessToken = store.get(ACCESS_COOKIE)?.value;
  const refreshToken = store.get(REFRESH_COOKIE)?.value;

  // Revoke server-side FIRST: clearing cookies alone would leave a live
  // 30-day refresh token in the database, revocable by nobody.
  if (accessToken) {
    await fetch(`${API_BASE}/v1/auth/logout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(refreshToken ? { refreshToken } : {}),
      cache: 'no-store',
    }).catch(() => undefined); // an unreachable API must not trap the user logged in
  }

  store.delete(ACCESS_COOKIE);
  store.delete(REFRESH_COOKIE);

  redirect({ href: '/connexion', locale: await getLocale() });
}
