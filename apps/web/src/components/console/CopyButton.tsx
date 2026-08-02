'use client';

import { useState } from 'react';

/**
 * Copy-to-clipboard. The whole point of a tracked link is pasting it into a
 * Facebook post, so the copy button IS the feature's main interaction —
 * worth the one client component.
 */
export function CopyButton(props: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard
          .writeText(props.value)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => undefined); // insecure context or denied permission
      }}
      className="rounded-full border border-brand-200 px-3 py-1 text-xs font-medium text-brand-700 hover:bg-brand-50"
    >
      {copied ? '✓' : props.label}
    </button>
  );
}
