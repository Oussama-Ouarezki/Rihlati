import { describe, expect, it } from 'vitest';
import {
  algerianPhoneSchema,
  formatPhoneForDisplay,
  isMobile,
  maskPhone,
  normalizeAlgerianPhone,
} from './phone';

describe('normalizeAlgerianPhone', () => {
  it('accepts every way a real person writes the same mobile number', () => {
    const expected = '+213551234567';
    for (const input of [
      '0551234567',
      '0551 23 45 67',
      '0551-23-45-67',
      '05.51.23.45.67',
      '+213551234567',
      '+213 551 234 567',
      '00213551234567',
      '213551234567',
      '  0551234567  ',
      '(0551) 234567',
    ]) {
      expect(normalizeAlgerianPhone(input), `input: ${input}`).toBe(expected);
    }
  });

  it('normalizes landlines (8-digit national numbers)', () => {
    expect(normalizeAlgerianPhone('021234567')).toBe('+21321234567');
    expect(normalizeAlgerianPhone('041 23 45 67')).toBe('+21341234567');
  });

  it('rejects numbers that cannot be Algerian', () => {
    for (const input of [
      '',
      'abc',
      '0551234',            // too short
      '05512345678',        // too long
      '0851234567',         // 8 is not a valid mobile prefix
      '+33612345678',       // French
      '+2135512345',        // wrong length after country code
      '0000000000',
    ]) {
      expect(normalizeAlgerianPhone(input), `input: ${input}`).toBeNull();
    }
  });
});

describe('algerianPhoneSchema', () => {
  it('normalizes as part of validation, so handlers only ever see E.164', () => {
    expect(algerianPhoneSchema.parse('0551 23 45 67')).toBe('+213551234567');
  });

  it('fails with a readable message', () => {
    const result = algerianPhoneSchema.safeParse('0851234567');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('invalide');
    }
  });
});

describe('isMobile', () => {
  it('distinguishes mobile from landline', () => {
    expect(isMobile('+213551234567')).toBe(true);
    expect(isMobile('+213661234567')).toBe(true);
    expect(isMobile('+213771234567')).toBe(true);
    expect(isMobile('+21321234567')).toBe(false);
    expect(isMobile('+33612345678')).toBe(false);
  });
});

describe('formatPhoneForDisplay', () => {
  it('renders the local format users recognize', () => {
    expect(formatPhoneForDisplay('+213551234567')).toBe('0551 23 45 67');
    expect(formatPhoneForDisplay('+21321234567')).toBe('021 23 45 67');
  });
});

describe('maskPhone', () => {
  it('never reveals the middle digits (rule #4: no PII in logs)', () => {
    const masked = maskPhone('+213551234567');
    expect(masked).not.toContain('5512');
    expect(masked.startsWith('+213')).toBe(true);
    expect(masked.endsWith('4567')).toBe(true);
  });
});
