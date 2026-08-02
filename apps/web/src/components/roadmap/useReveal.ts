'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Fires once when the element first scrolls into view, so the road can draw
 * itself and the markers can appear in sequence at the moment somebody
 * actually looks at them.
 *
 * An IntersectionObserver rather than a scroll listener: the browser does the
 * work off the main thread, and there is no handler running on every frame of
 * a scroll on a mid-range Android.
 *
 * Reduced motion short-circuits it to `true` immediately — the animation is
 * decoration, and someone who has asked for less motion should get the
 * finished state, not a frozen half-drawn road.
 */
export function useReveal<T extends Element>(): {
  ref: React.RefObject<T | null>;
  revealed: boolean;
} {
  const ref = useRef<T>(null);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setRevealed(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setRevealed(true);
          observer.disconnect(); // one-shot: re-animating on scroll-back is nausea, not delight
        }
      },
      { rootMargin: '0px 0px -10% 0px' },
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, revealed };
}
