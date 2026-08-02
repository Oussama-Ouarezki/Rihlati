import { NextResponse, type NextRequest } from 'next/server';
import createMiddleware from 'next-intl/middleware';
import type { AuthTokens } from '@rihlati/shared';
import { routing } from './i18n/routing';
import {
  ACCESS_COOKIE,
  ACCESS_MAX_AGE,
  REFRESH_COOKIE,
  REFRESH_MAX_AGE,
  cookieOptions,
  tokenExpiresSoon,
} from './lib/session-cookies';

const intlMiddleware = createMiddleware(routing);

const API_BASE =
  process.env['API_URL'] ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:4000';

/** /console, /fr/console, /ar/console/leads… — the authenticated area. */
function isConsolePath(pathname: string): boolean {
  return /^(?:\/(?:fr|ar|en))?\/console(?:\/|$)/.test(pathname);
}

function loginPath(pathname: string): string {
  const match = /^\/(ar|en)(?:\/|$)/.exec(pathname);
  return match ? `/${match[1]}/connexion` : '/connexion';
}

/**
 * Locale routing for every page, plus session refresh for the console.
 *
 * Refresh lives HERE because middleware is the only stage where Next can
 * still set cookies before server components render. And it must run BEFORE
 * the response is built: cookies set only on the response reach the browser
 * but not the server components of THIS request — they read request cookies.
 * So on refresh we mutate `request.cookies` too, and the page renders with
 * the new token immediately instead of bouncing to login once per rotation.
 *
 * Losing a rotated refresh token is not an option: presenting the old one
 * again reads as theft to the API (family revoked, by design). Hence the
 * both-or-nothing handling below.
 */
export default async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  let refreshedTokens: AuthTokens | null = null;

  if (isConsolePath(pathname)) {
    const access = request.cookies.get(ACCESS_COOKIE)?.value;
    const refresh = request.cookies.get(REFRESH_COOKIE)?.value;

    if (!access || tokenExpiresSoon(access)) {
      if (!refresh) {
        // Nothing to refresh with; save a doomed render.
        return NextResponse.redirect(new URL(loginPath(pathname), request.url));
      }

      try {
        const response = await fetch(`${API_BASE}/v1/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: refresh }),
          cache: 'no-store',
        });

        if (response.ok) {
          refreshedTokens = (await response.json()) as AuthTokens;
          // Visible to this request's server components:
          request.cookies.set(ACCESS_COOKIE, refreshedTokens.accessToken);
          request.cookies.set(REFRESH_COOKIE, refreshedTokens.refreshToken);
        } else {
          // Revoked, expired, or reuse-detected: the session is over. Clear
          // the cookies so the next attempt starts clean instead of looping.
          const redirect = NextResponse.redirect(new URL(loginPath(pathname), request.url));
          redirect.cookies.delete(ACCESS_COOKIE);
          redirect.cookies.delete(REFRESH_COOKIE);
          return redirect;
        }
      } catch {
        // API unreachable: fall through with the old token rather than
        // logging the user out over a network blip.
      }
    }
  }

  const response = intlMiddleware(request);

  if (refreshedTokens) {
    // And persisted for the browser's next request:
    response.cookies.set(ACCESS_COOKIE, refreshedTokens.accessToken, cookieOptions(ACCESS_MAX_AGE));
    response.cookies.set(
      REFRESH_COOKIE,
      refreshedTokens.refreshToken,
      cookieOptions(REFRESH_MAX_AGE),
    );
  }

  return response;
}

export const config = {
  /**
   * EVERY route handler that lives OUTSIDE `src/app/[locale]/` must be
   * excluded here, or the i18n middleware rewrites it to `/fr/<path>` — a
   * page that does not exist — and it 404s.
   *
   * This has now bitten twice: tracked links (`/l/{code}`) and the Google
   * OAuth routes (`/auth/google/*`). Both are redirects with no locale of
   * their own; whatever they redirect TO gets localised normally.
   *
   * Add a route handler outside `[locale]`? Add it to this list.
   */
  matcher: ['/((?!api|l/|auth/|_next|_vercel|.*\\..*).*)'],
};
