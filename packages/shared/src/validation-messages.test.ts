import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VALIDATION_MESSAGE_KEYS, validationMessageKey } from './validation-messages';

const SRC = __dirname;
const REPO = join(SRC, '../../..');
const WEB_MESSAGES = join(REPO, 'apps/web/messages');

/**
 * Both places a field message can be born: a shared schema, and the API's own
 * handlers (a rejected upload, a taken slug). They land in the same
 * `error.fields` and are printed by the same client code, so they must obey
 * the same rule.
 */
const EMITTERS = [SRC, join(REPO, 'apps/api/src')];

/** Every `.ts` under `src/`, tests excluded. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!entry.name.endsWith('.ts') || entry.name.includes('.test.')) return [];
    return [path];
  });
}

describe('validation message keys', () => {
  it('has no duplicates and stays sorted', () => {
    const sorted = [...VALIDATION_MESSAGE_KEYS].sort();
    expect([...VALIDATION_MESSAGE_KEYS]).toEqual(sorted);
    expect(new Set(VALIDATION_MESSAGE_KEYS).size).toBe(VALIDATION_MESSAGE_KEYS.length);
  });

  it('covers every key the schemas actually emit', () => {
    const used = new Set<string>();
    for (const file of EMITTERS.flatMap(sourceFiles)) {
      for (const match of readFileSync(file, 'utf8').matchAll(/'(validation\.[A-Za-z]+)'/g)) {
        used.add(match[1]!);
      }
    }

    // A schema emitting a key nobody translated prints the key itself on the
    // page — "validation.nameTooShort" under the input box.
    expect([...used].filter((raw) => validationMessageKey(raw) === null)).toEqual([]);
    expect(used.size).toBeGreaterThan(0);
  });

  it('rejects prose and unknown keys', () => {
    expect(validationMessageKey('Nom trop court')).toBeNull();
    expect(validationMessageKey('validation.somethingNobodyDefined')).toBeNull();
    expect(validationMessageKey('validation.nameTooShort')).toBe('nameTooShort');
  });

  /**
   * Reaching into the web app from the shared package is unusual, and it is
   * deliberate: this is the only place that can catch "a key was added and
   * Arabic was forgotten" mechanically. A missing translation is invisible in
   * French, which is exactly why it needs a test rather than a habit.
   */
  it('is translated in every locale the app ships', () => {
    for (const file of readdirSync(WEB_MESSAGES)) {
      const messages = JSON.parse(readFileSync(join(WEB_MESSAGES, file), 'utf8')) as {
        validation?: Record<string, string>;
      };
      const namespace = messages.validation ?? {};

      const missing = VALIDATION_MESSAGE_KEYS.filter((key) => !namespace[key]?.trim());
      expect(missing, `${file} is missing translations`).toEqual([]);

      const extra = Object.keys(namespace).filter(
        (key) => !(VALIDATION_MESSAGE_KEYS as readonly string[]).includes(key),
      );
      expect(extra, `${file} translates keys no schema emits`).toEqual([]);
    }
  });
});
