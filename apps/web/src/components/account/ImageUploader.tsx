'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { AccountState } from '@/lib/account-actions';
import { Button } from '@/components/ui/button';

/**
 * Pick a picture, see it immediately, upload it.
 *
 * Used for both the profile picture and the agency logo — the only differences
 * are the shape of the preview and which action it posts to, so they are props
 * rather than two near-identical components.
 *
 * The client-side checks below (`accept`, the size test) are CONVENIENCE, not
 * security: they save a doomed 5 MB upload over a mobile connection and give an
 * instant answer. The API re-checks every one of them, and re-encodes the image
 * regardless, because anything decided in a browser can be skipped.
 */
export function ImageUploader(props: {
  action: (state: AccountState, formData: FormData) => Promise<AccountState>;
  removeAction: () => Promise<void>;
  currentUrl: string | null;
  /** Shown when there is no picture yet — initials for a person, a glyph for an agency. */
  fallback: string;
  shape: 'circle' | 'square';
  label: string;
}) {
  const t = useTranslations('account');
  const [state, formAction, pending] = useActionState<AccountState, FormData>(props.action, {
    error: null,
    ok: false,
  });

  const inputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [tooLarge, setTooLarge] = useState(false);

  // Object URLs are a manual allocation: without the revoke, picking ten files
  // in a row leaks ten blobs for the lifetime of the page.
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  // Once the server has the new picture, drop the local preview so what is on
  // screen is what is actually stored — including the server's own cropping.
  useEffect(() => { if (state.ok) setPreview(null); }, [state.ok]);

  const shown = preview ?? props.currentUrl;
  const rounded = props.shape === 'circle' ? 'rounded-full' : 'rounded-2xl';

  return (
    <form ref={formRef} action={formAction} className="flex items-center gap-4">
      <div
        className={`flex size-20 shrink-0 items-center justify-center overflow-hidden border border-slate-200 bg-slate-50 ${rounded}`}
      >
        {shown ? (
          // A plain <img>, not next/image: half the time the source is a
          // `blob:` URL for the local preview, which the image optimizer
          // cannot fetch or resize.
          <img src={shown} alt="" className="size-full object-cover" />
        ) : (
          <span className="text-xl font-semibold text-slate-400">{props.fallback}</span>
        )}
      </div>

      <div className="min-w-0 space-y-2">
        <input
          ref={inputRef}
          type="file"
          name="file"
          // A hint to the file picker, nothing more — the dialog lets anyone
          // choose "all files", and the API is what actually decides.
          accept="image/jpeg,image/png,image/webp,image/avif"
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;

            if (file.size > 5 * 1024 * 1024) {
              setTooLarge(true);
              event.target.value = '';
              return;
            }
            setTooLarge(false);
            setPreview(URL.createObjectURL(file));
            // Submit straight away: a separate "upload" button after choosing a
            // file is a step people forget, then wonder why nothing saved.
            formRef.current?.requestSubmit();
          }}
        />

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => inputRef.current?.click()}
          >
            {pending ? t('uploading') : props.label}
          </Button>

          {props.currentUrl ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => void props.removeAction()}>
              {t('removePhoto')}
            </Button>
          ) : null}
        </div>

        <p className="text-xs text-muted-foreground">{t('photoHint')}</p>

        {tooLarge ? <p className="text-sm text-destructive">{t('errTooLarge')}</p> : null}
        {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      </div>
    </form>
  );
}
