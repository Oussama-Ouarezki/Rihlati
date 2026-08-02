/**
 * `FormData.get()` returns `string | File | null`, and `String(File)` is
 * "[object Object]". Every action was re-solving this inline until the linter
 * caught the third copy — when a mistake repeats, it gets a helper.
 */
export function formText(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value.trim() : '';
}
