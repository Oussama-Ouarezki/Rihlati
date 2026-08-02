'use client';

import { useEffect } from 'react';

/**
 * Remembers the `?ref=` a tracked link carried in, so the inquiry form can
 * report it even if the traveler browses to three other offers first.
 *
 * `sessionStorage`, not a cookie and not localStorage:
 *   - a cookie would be sent to the server on every request, and this is
 *     marketing metadata, not something the API needs unprompted
 *   - localStorage would persist for months, so a visit in June would still
 *     credit March's Facebook post — that is not attribution, it is fiction
 *
 * One visit, one session, one credited source.
 */
export function RefCapture(props: { code: string | null }) {
  useEffect(() => {
    if (!props.code) return;
    try {
      sessionStorage.setItem('rihlati_ref', props.code);
    } catch {
      // Private mode or storage disabled: attribution is a nice-to-have.
    }
  }, [props.code]);

  return null;
}

/** Read back by the inquiry form. Never throws. */
export function readRef(): string | undefined {
  try {
    return sessionStorage.getItem('rihlati_ref') ?? undefined;
  } catch {
    return undefined;
  }
}
