import { createHash, randomBytes } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { cookieOptions } from '@/lib/session-cookies';

/**
 * Step 1 of Sign in with Google: build the authorization URL and remember the
 * two secrets that make the round trip safe.
 *
 *   `state`         — random, stored in an httpOnly cookie and compared on the
 *                     way back. Without it, an attacker can hand a victim a
 *                     crafted callback URL and log them into the ATTACKER's
 *                     Google account (login CSRF), then watch what they do.
 *
 *   `code_verifier` — PKCE. The authorization code is useless to anyone who
 *                     intercepts it without this value, which never leaves the
 *                     server. Google recommends it for all clients now, not
 *                     just mobile ones.
 *
 * Both live in httpOnly cookies for the same reason session tokens do: the
 * browser must carry them, and browser JavaScript must not be able to read them.
 */
const CLIENT_ID = process.env['GOOGLE_CLIENT_ID'] ?? '';
const SITE_URL = process.env['NEXT_PUBLIC_SITE_URL'] ?? 'http://localhost:3000';

export const STATE_COOKIE = 'rihlati_oauth_state';
export const VERIFIER_COOKIE = 'rihlati_oauth_verifier';
/** Long enough for a slow consent screen, short enough to limit replay. */
const FLOW_MAX_AGE = 10 * 60;

export function GET(request: NextRequest): NextResponse {
  if (!CLIENT_ID) {
    // Not configured: send them back to the password form rather than to a
    // Google error page that mentions our client id.
    return NextResponse.redirect(new URL('/connexion', SITE_URL), 302);
  }

  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  // Where Google sends the user back. Must match the token exchange exactly,
  // and must be registered in the Google Cloud console.
  const redirectUri = `${SITE_URL}/auth/google/callback`;

  const authorizeUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authorizeUrl.searchParams.set('client_id', CLIENT_ID);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('response_type', 'code');
  // `openid email profile` — the minimum. Never request scopes you do not
  // use: the consent screen lists every one, and a long list loses signups.
  authorizeUrl.searchParams.set('scope', 'openid email profile');
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');

  const response = NextResponse.redirect(authorizeUrl.toString(), 302);
  response.cookies.set(STATE_COOKIE, state, cookieOptions(FLOW_MAX_AGE));
  response.cookies.set(VERIFIER_COOKIE, verifier, cookieOptions(FLOW_MAX_AGE));

  // Preserve where the user was heading, if the caller passed it.
  const next = request.nextUrl.searchParams.get('next');
  if (next?.startsWith('/')) {
    response.cookies.set('rihlati_oauth_next', next, cookieOptions(FLOW_MAX_AGE));
  }

  return response;
}
