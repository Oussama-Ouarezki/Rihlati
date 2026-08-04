import { z } from 'zod';
import { localeSchema, type AgencyRole } from '../enums';
import { algerianPhoneSchema } from '../phone';

/**
 * AUTH REQUEST SHAPES
 *
 * One account type for everybody. A traveler and an agency employee are the
 * same `User` row; what makes someone "agency staff" is a Membership, not a
 * flag on the account. So there is ONE register endpoint and ONE login.
 *
 * Why that matters: the owner of an agency is usually also a traveler. Two
 * account types would force them to have two passwords, and would double every
 * piece of auth code — which is where auth bugs come from.
 */

/**
 * Minimum password length is 10, not 8.
 *
 * No uppercase/symbol rule on purpose: those rules push people to `Password1!`
 * and are worse than length. Length is the only requirement that reliably buys
 * entropy. (Rejecting known-breached passwords would beat both — a later job.)
 */
export const passwordSchema = z
  .string()
  .min(10, 'Le mot de passe doit contenir au moins 10 caractères')
  .max(200, 'Mot de passe trop long');

export const emailSchema = z.string().trim().toLowerCase().email().max(254);

/**
 * Register with an email, a phone, or both — but at least one.
 *
 * Travelers in Algeria are phone-first and many have no email they check.
 * Agency staff are email-first. Forcing either one on both would cost real
 * signups.
 */
export const registerSchema = z
  .object({
    email: emailSchema.optional(),
    phone: algerianPhoneSchema.optional(),
    password: passwordSchema,
    displayName: z.string().trim().min(2, 'Nom trop court').max(80),
    locale: localeSchema.default('fr'),
  })
  .refine((v) => Boolean(v.email) || Boolean(v.phone), {
    message: 'Un email ou un numéro de téléphone est requis',
    path: ['email'],
  });

export type RegisterInput = z.infer<typeof registerSchema>;

/**
 * `identifier` is an email OR a phone number, in one field.
 *
 * Deliberately one field: asking users to pick "log in with email / with phone"
 * is a decision they should not have to make. The server works out which it is.
 * It is NOT normalized here — normalization happens server-side after we know
 * which kind it is, so that a typo'd phone still reaches the same generic
 * "invalid credentials" answer instead of a different validation error.
 */
export const loginSchema = z.object({
  identifier: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(200),
});

export type LoginInput = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({
  refreshToken: z.string().min(20).max(500),
});
export type RefreshInput = z.infer<typeof refreshSchema>;

/**
 * What a user may change about their own account.
 *
 * Note what is absent, and why each absence is deliberate:
 *   - `avatarUrl` — a picture is uploaded as BYTES, never as a URL the client
 *     picks. Letting a client set the URL means it can point a profile picture
 *     at any server on the internet, turning every page that renders it into a
 *     tracking beacon (or worse, a way to host content under our domain's
 *     reputation). The server names the file. See the uploads endpoints.
 *   - `email` / `phone` — changing an identifier is an account-recovery
 *     decision, not a profile edit. It needs the current password and a
 *     verification round trip, so it gets its own endpoint when delivery exists.
 *   - `isPlatformAdmin`, `emailVerifiedAt`, … — server-owned, always.
 */
export const updateProfileSchema = z
  .object({
    displayName: z.string().trim().min(2, 'Nom trop court').max(80).optional(),
    locale: localeSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Aucune modification' });

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

export const logoutSchema = z.object({
  refreshToken: z.string().min(20).max(500).optional(),
  /** Log out of every device, not just this one. */
  allDevices: z.boolean().default(false),
});
export type LogoutInput = z.infer<typeof logoutSchema>;

// ---------------------------------------------------------------------------
// RESPONSES
// ---------------------------------------------------------------------------

/**
 * What a successful login returns.
 *
 * The access token is short-lived and sent on every request. The refresh token
 * is long-lived, used once, and swapped for a new pair — see the Auth Flow note
 * in the vault for why rotation is what makes a stolen token detectable.
 */
export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Seconds until `accessToken` stops working. Lets clients refresh early. */
  expiresIn: number;
  tokenType: 'Bearer';
}

/** One agency this user belongs to, and what they may do there. */
export interface SessionMembership {
  agencyId: string;
  agencySlug: string;
  agencyName: string;
  role: AgencyRole;
  agencyStatus: string;
}

/**
 * The current user, as returned by `GET /auth/me`.
 *
 * Note what is NOT here: no password hash, no refresh tokens, no internal
 * counters. This interface is the allow-list — the API builds it field by
 * field rather than spreading a Prisma row, so a column added to the database
 * later cannot leak by accident.
 */
export interface SessionUser {
  id: string;
  email: string | null;
  phone: string | null;
  displayName: string;
  locale: string;
  avatarUrl: string | null;
  isPlatformAdmin: boolean;
  emailVerified: boolean;
  phoneVerified: boolean;
  memberships: SessionMembership[];
}

export interface AuthResult {
  user: SessionUser;
  tokens: AuthTokens;
}
