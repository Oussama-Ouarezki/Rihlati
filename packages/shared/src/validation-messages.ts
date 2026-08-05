/**
 * The keys a Zod schema in this package may emit as a field-level message.
 *
 * A schema never contains prose. It emits `'validation.nameTooShort'`, the API
 * passes that through untouched in `error.fields`, and each client looks the
 * key up in its own message file. The API has no idea whether the person
 * reading the response speaks Arabic or French, so it must not choose words.
 *
 * The same discipline already applies to top-level errors, which are codes
 * (`VALIDATION_FAILED`). Field messages were the one place it had broken:
 * they were written in French, and an Arabic reader who mistyped a password
 * got a French sentence under the box.
 *
 * This list exists so the mistake cannot come back quietly —
 * `validation-messages.test.ts` fails if a schema uses a key that is not here,
 * or if any locale is missing a translation for one that is.
 */
export const VALIDATION_MESSAGE_KEYS = [
  'amountNotInteger',
  'answerEmpty',
  'checkedNoteTooShort',
  'clientConsentRequired',
  'clientOrContactRequired',
  'codeInvalid',
  'consentRequired',
  'dateFormat',
  'dateInvalid',
  'departureRequired',
  'durationMinAboveMax',
  'emailOrPhoneRequired',
  'fileInvalid',
  'fileMissing',
  'idInvalid',
  'imageFormatUnsupported',
  'imageTooLarge',
  'linkLabelRequired',
  'nameTooShort',
  'noChanges',
  'noteEmpty',
  'passwordTooLong',
  'passwordTooShort',
  'phoneInvalid',
  'priceMaxBelowMin',
  'priceMinAboveMax',
  'questionTooShort',
  'rejectionReasonTooShort',
  'requiredForVerification',
  'returnBeforeDeparture',
  'slugFormat',
  'slugReserved',
  'slugTaken',
  'slugTooShort',
  'startAfterEnd',
  'timeFormat',
  'titleTooShort',
  'urlInvalid',
  'wilayaInvalid',
] as const;

export type ValidationMessageKey = (typeof VALIDATION_MESSAGE_KEYS)[number];

/** The prefix that marks a field message as translatable rather than prose. */
export const VALIDATION_MESSAGE_PREFIX = 'validation.';

/**
 * Splits a raw field message into "a key to translate" or "prose to print".
 *
 * Not everything in `error.fields` comes from our schemas: Zod's own built-in
 * messages (`.email()`, `.max(120)`) are English prose we did not write. Those
 * fall through untranslated for now — see the open question in
 * [[Validation at the Boundary]].
 */
export function validationMessageKey(raw: string): ValidationMessageKey | null {
  if (!raw.startsWith(VALIDATION_MESSAGE_PREFIX)) return null;
  const key = raw.slice(VALIDATION_MESSAGE_PREFIX.length);
  return (VALIDATION_MESSAGE_KEYS as readonly string[]).includes(key)
    ? (key as ValidationMessageKey)
    : null;
}
