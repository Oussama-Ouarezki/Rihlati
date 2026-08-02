import { NextResponse, type NextRequest } from 'next/server';

/**
 * `/l/{code}` — the short link an agency pastes under its Facebook post.
 *
 * It lives on the WEB domain, not the API's, because this URL is the one
 * people see: `rihlati.dz/l/a1b2c3d4` is something a traveler will tap,
 * `api.rihlati.dz/...` is not.
 *
 * The route is deliberately thin: the API counts the click and decides the
 * destination (it knows whether the offer is still published), and this just
 * issues the redirect. 302, never 301 — a permanent redirect gets cached by
 * the browser and the click stops being counted from the second tap on.
 */
const API_BASE =
  process.env['API_URL'] ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:4000';

const SITE_URL = process.env['NEXT_PUBLIC_SITE_URL'] ?? 'http://localhost:3000';

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  const { code } = await context.params;

  try {
    const response = await fetch(`${API_BASE}/v1/tracked-links/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
      cache: 'no-store',
    });

    if (response.ok) {
      const { url } = (await response.json()) as { url: string };
      return NextResponse.redirect(url, 302);
    }
  } catch {
    // Fall through: a tracking failure must never strand a real visitor.
  }

  return NextResponse.redirect(SITE_URL, 302);
}
