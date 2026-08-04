import { validationMessageKey } from '@rihlati/shared';

/**
 * A `useTranslations('validation')` or `getTranslations('validation')` result.
 * Typed structurally so this file imports neither, and can therefore be used
 * from a server action and a client component alike.
 */
type Translator = (key: string) => string;

/**
 * Turns one entry of the API's `error.fields` into a sentence in the reader's
 * language.
 *
 * The API sends keys, not prose — see `validation-messages.ts` in
 * `@rihlati/shared` for why. Anything that is not a key we recognise is passed
 * through unchanged: that is Zod's own built-in wording (`.email()`, `.max()`),
 * which is English everywhere today and is a known gap, not a decision.
 */
export function translateFieldError(t: Translator, raw: string | undefined): string | null {
  if (!raw) return null;
  const key = validationMessageKey(raw);
  return key ? t(key) : raw;
}

/** The same, for the whole `fields` object — used by the forms that list every error. */
export function translateFieldErrors(
  t: Translator,
  fields: Record<string, string[]> | undefined,
): [field: string, message: string][] {
  return Object.entries(fields ?? {}).map(([field, messages]) => [
    field,
    messages.map((message) => translateFieldError(t, message) ?? message).join(', '),
  ]);
}
