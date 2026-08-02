import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

/**
 * PASSWORD HASHING — Argon2id
 *
 * Not bcrypt, not SHA-256, and absolutely never plain SHA. A password hash has
 * to be SLOW and memory-hungry so that stealing the database does not hand the
 * attacker every password. Argon2id is the current recommendation and it is
 * the one that resists GPU cracking, which bcrypt increasingly does not.
 *
 * These parameters cost roughly 19 MiB and ~50 ms per hash. That is meant to
 * feel slightly slow — it is the whole defence.
 */
const ARGON_OPTIONS = {
  memoryCost: 19_456, // KiB — OWASP minimum for Argon2id
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plain: string): Promise<string> {
  return argonHash(plain, ARGON_OPTIONS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argonVerify(hash, plain);
  } catch {
    // A malformed stored hash must read as "wrong password", never as a 500 —
    // a 500 here would tell an attacker which accounts have unusual hashes.
    return false;
  }
}

/**
 * Burn the same CPU time as a real password check, then fail.
 *
 * Call this when the account does not exist, or exists without a password.
 * Without it, logging in as a nonexistent user answers in 2 ms and as a real
 * user in 50 ms — and that gap alone lets anyone enumerate which phone numbers
 * have accounts on Rihlati. We always pay the cost.
 *
 * The decoy hash is computed once at first use (a real Argon2 hash of a random
 * string, so `verify` does the full work instead of throwing on a malformed
 * input and returning early).
 */
let decoyHash: Promise<string> | null = null;

export async function fakeVerifyPassword(plain: string): Promise<false> {
  decoyHash ??= argonHash(randomBytes(24).toString('hex'), ARGON_OPTIONS);
  await argonVerify(await decoyHash, plain).catch(() => false);
  return false;
}

// ---------------------------------------------------------------------------
// TOKENS
// ---------------------------------------------------------------------------

/** 256 bits of randomness, URL-safe. Used for refresh tokens. */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Refresh tokens are stored HASHED, like passwords — but with plain SHA-256,
 * not Argon2.
 *
 * Why the difference? A password is low-entropy and guessable, so the hash must
 * be slow. A 256-bit random token is not guessable at any speed, so slowness
 * buys nothing and would make every refresh request cost 50 ms. What we need
 * here is only that a leaked database dump contains no usable tokens.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// IP ADDRESSES
// ---------------------------------------------------------------------------

/**
 * IP addresses are personal data. We store a keyed hash, never the address.
 *
 * That still gives us what we actually need — "is this the same visitor as
 * before?" for rate limiting and abuse detection — while a database leak
 * yields nothing that maps back to a person's connection. The salt makes it
 * infeasible to just hash all 4 billion IPv4 addresses and look them up.
 */
export function hashIp(ip: string | undefined, salt: string): string | null {
  if (!ip) return null;
  return createHash('sha256').update(`${salt}|${ip}`).digest('hex').slice(0, 32);
}

/** sha256 hex of arbitrary text. Used for offer fingerprints. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * 128 bits of randomness, URL-safe, 22 characters — the code in a capability
 * URL like /mon-voyage/{code}.
 *
 * Shorter than `generateOpaqueToken` on purpose: this one gets pasted into a
 * WhatsApp message by a human, so length is a usability cost. 128 bits is
 * still unguessable at any rate an attacker could reach through a rate-limited
 * endpoint, and unlike a refresh token it is stored in the clear — it has to
 * be, because the URL is the lookup key. That is only acceptable because of
 * how little the page behind it exposes; see Trip Programme.md §5.
 */
export function generateCapabilityCode(): string {
  return randomBytes(16).toString('base64url');
}
