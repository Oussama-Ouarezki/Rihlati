import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { SessionUser } from '@rihlati/shared';

/**
 * Everything the app attaches to a request lives here, in one declaration,
 * so there is a single answer to "what is on `req`?".
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
      /** Set by JwtAuthGuard. Absent on public routes with no token. */
      auth?: AuthenticatedActor;
    }
  }
}

/**
 * Who is making this request.
 *
 * NOTE what is missing: no `agencyId`, no `role`. Those are not properties of
 * a person — they are properties of a person *at one agency*, and they are
 * resolved per request by the membership guard from the database. Putting them
 * here (or in the JWT) would mean a fired employee keeps their access until
 * their token expires.
 */
export interface AuthenticatedActor {
  userId: string;
  isPlatformAdmin: boolean;
  /** The token's jti-equivalent: the family this session belongs to. */
  sessionFamilyId: string;
}

/**
 * Attaches a request id before anything else runs.
 *
 * The id is echoed in every log line AND in every error response, so when
 * someone says "it failed at 3pm", you ask for the id on their screen and go
 * straight to the exact lines. Rule #4 is unusable without it.
 *
 * An inbound `x-request-id` is honoured only if it looks like one, so a client
 * cannot inject newlines or 10 KB of text into your logs.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.header('x-request-id');
  const valid = inbound && /^[A-Za-z0-9._-]{8,64}$/.test(inbound) ? inbound : null;

  req.requestId = valid ?? randomUUID();
  res.setHeader('x-request-id', req.requestId);
  next();
}

/**
 * The caller's IP, honouring a proxy header only when the app is configured to
 * trust one. `req.ip` already handles this correctly once `trust proxy` is set
 * in main.ts — reading `x-forwarded-for` by hand is how people accidentally
 * let clients spoof their own IP and bypass rate limits.
 */
export function clientIp(req: Request): string | undefined {
  return req.ip;
}

export function userAgent(req: Request): string | undefined {
  // Truncated: a user agent is attacker-controlled text going into the database.
  return req.header('user-agent')?.slice(0, 300);
}

/** Narrow helper so services never build a SessionUser by spreading a row. */
export type { SessionUser };
