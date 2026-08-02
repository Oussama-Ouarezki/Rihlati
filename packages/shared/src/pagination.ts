import { z } from 'zod';

/**
 * Every list endpoint paginates. Always. An endpoint that returns "all leads"
 * works fine with 20 rows and takes the site down at 200 000.
 *
 * Cursor-based, not page-numbered: with `?page=500` the database still has to
 * count through 500 pages of rows, and new rows shift everything. A cursor is
 * "give me what comes after this id", which stays fast forever and never
 * shows the same row twice.
 */

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export const paginationSchema = z.object({
  /** Opaque cursor from the previous response's `nextCursor`. */
  cursor: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export type PaginationInput = z.infer<typeof paginationSchema>;

export interface Page<T> {
  items: T[];
  /** null when there is nothing more to fetch. */
  nextCursor: string | null;
}

export function emptyPage<T>(): Page<T> {
  return { items: [], nextCursor: null };
}

/**
 * Fetch `limit + 1` rows, pass them here. If the extra row exists there is
 * another page, and its id becomes the cursor.
 */
export function buildPage<T extends { id: string }>(rows: T[], limit: number): Page<T> {
  if (rows.length <= limit) {
    return { items: rows, nextCursor: null };
  }
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: last ? last.id : null };
}
