import { NextResponse, type NextRequest } from 'next/server';
import type { AuthResult } from '@rihlati/shared';
import {
  ACCESS_COOKIE,
  ACCESS_MAX_AGE,
  REFRESH_COOKIE,
  REFRESH_MAX_AGE,
  cookieOptions,
} from '@/lib/session-cookies';
import { STATE_COOKIE, VERIFIER_COOKIE } from '../start/route';

/**
 * Step 2: Google sends the user back here with an authorization code.
 *
 * This route checks `state`, then hands the code to the API — which does the
 * actual token exchange and decides which account this identity is. The
 * browser never sees a Google token, and the API stays cookie-free.
 */
const API_BASE =
  process.env['API_URL'] ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:4000';
const SITE_URL = process.env['NEXT_PUBLIC_SITE_URL'] ?? 'http://localhost:3000';

function backToLogin(reason: string): NextResponse {
  const url = new URL('/connexion', SITE_URL);
  // A short reason code, never the provider's error text — that can echo
  // our client id back into the address bar.
  url.searchParams.set('oauth_error', reason);
  const response = NextResponse.redirect(url, 302);
  clearFlowCookies(response);
  return response;
}

function clearFlowCookies(response: NextResponse): void {
  response.cookies.delete(STATE_COOKIE);
  response.cookies.delete(VERIFIER_COOKIE);
  response.cookies.delete('rihlati_oauth_next');
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;

  // The user pressed "cancel" on the consent screen, or Google refused.
  if (params.get('error')) return backToLogin('cancelled');

  const code = params.get('code');
  const state = params.get('state');
  const expectedState = request.cookies.get(STATE_COOKIE)?.value;
  const verifier = request.cookies.get(VERIFIER_COOKIE)?.value;

  if (!code || !verifier) return backToLogin('incomplete');

  /**
   * The state check. Both must exist AND match — an attacker who can make a
   * victim's browser hit this URL with the attacker's own code would
   * otherwise log the victim into the attacker's account, and everything the
   * victim then does happens in a stranger's session.
   */
  if (!state || !expectedState || state !== expectedState) {
    return backToLogin('state');
  }

  let result: AuthResult;
  try {
    const response = await fetch(`${API_BASE}/v1/auth/oauth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        codeVerifier: verifier,
        redirectUri: `${SITE_URL}/auth/google/callback`,
      }),
      cache: 'no-store',
    });

    if (!response.ok) {
      // 403 = the provider would not vouch for the email, 422 = no verified
      // address at all. Both mean "use the password form"; the login page
      // turns the code into a translated sentence.
      return backToLogin(response.status === 403 || response.status === 422 ? 'unverified' : 'failed');
    }

    result = (await response.json()) as AuthResult;
  } catch {
    return backToLogin('failed');
  }

  const next = request.cookies.get('rihlati_oauth_next')?.value;
  const destination = next?.startsWith('/') ? next : '/console';

  const response = NextResponse.redirect(new URL(destination, SITE_URL), 302);
  // Same session cookies as a password login — from here on the two flows are
  // indistinguishable, which is the point.
  response.cookies.set(ACCESS_COOKIE, result.tokens.accessToken, cookieOptions(ACCESS_MAX_AGE));
  response.cookies.set(REFRESH_COOKIE, result.tokens.refreshToken, cookieOptions(REFRESH_MAX_AGE));
  clearFlowCookies(response);

  return response;
}
