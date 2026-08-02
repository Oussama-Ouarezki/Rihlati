import { ERROR_STATUS, type ErrorCode } from '@rihlati/shared';

/**
 * The only error type handlers should throw on purpose.
 *
 * Why not Nest's `NotFoundException`, `ForbiddenException` and friends? Because
 * they carry an HTTP status and an English sentence, and this app needs a
 * machine-readable code the Arabic and French clients can translate
 * themselves. The status is derived from the code, in one table, so no handler
 * gets to invent one.
 *
 * Anything NOT an AppError that reaches the exception filter is a bug, and is
 * reported as an incident (rule #4).
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly fields?: Record<string, string[]>;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message?: string,
    options?: { fields?: Record<string, string[]>; details?: Record<string, unknown> },
  ) {
    super(message ?? code);
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.fields = options?.fields;
    this.details = options?.details;
  }
}

/**
 * The single way to say "you can't have this row".
 *
 * Use it for BOTH "there is no such row" and "that row belongs to another
 * agency". They must be indistinguishable to the caller — same status, same
 * code, same message, same timing-insensitive path. A different answer for the
 * second case turns the API into a tool for enumerating other agencies' data
 * (CLAUDE.md rule #3).
 */
export function notFound(what = 'Ressource'): AppError {
  return new AppError('NOT_FOUND', `${what} introuvable`);
}
