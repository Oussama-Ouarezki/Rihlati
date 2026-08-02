/**
 * THE WEB SESSION — where tokens live in the browser
 *
 * Decision (documented in the vault's Auth Flow note): tokens are stored in
 * httpOnly cookies and NEVER exposed to browser JavaScript.
 *
 *   - Login/logout are SERVER ACTIONS that set/clear the cookies.
 *   - Console reads are server components; writes are server actions. Both
 *     attach `Authorization: Bearer` on the server, so the API itself never
 *     sees a cookie — which is what keeps the API free of CSRF entirely.
 *   - Refresh rotation happens in middleware.ts, the one place Next can both
 *     read and SET cookies before a page renders.
 *
 * Rejected: tokens in localStorage (any XSS exfiltrates a 30-day session) and
 * access-token-in-JS-memory (workable, but "no tokens in JS at all" is
 * simpler to reason about and this app can afford it because mutations run in
 * server actions anyway).
 */

export const ACCESS_COOKIE = 'rihlati_access';
export const REFRESH_COOKIE = 'rihlati_refresh';

export const ACCESS_MAX_AGE = 15 * 60; // mirrors the API's JWT_ACCESS_TTL
export const REFRESH_MAX_AGE = 30 * 24 * 3600;

export function cookieOptions(maxAge: number) {
  return {
    httpOnly: true as const,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge,
  };
}

/**
 * Reads `exp` from a JWT WITHOUT verifying it. That is safe here and only
 * here: the middleware merely decides "is it time to refresh?" — the API
 * verifies the signature on every real request, and a forged `exp` gains an
 * attacker nothing but an early refresh attempt that will fail.
 */
export function tokenExpiresSoon(token: string, withinSeconds = 60): boolean {
  try {
    const payload = token.split('.')[1];
    if (!payload) return true;
    const decoded = JSON.parse(
      atob(payload.replace(/-/g, '+').replace(/_/g, '/')),
    ) as { exp?: number };
    if (!decoded.exp) return true;
    return decoded.exp * 1000 < Date.now() + withinSeconds * 1000;
  } catch {
    return true;
  }
}
