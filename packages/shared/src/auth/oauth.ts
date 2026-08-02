import { z } from 'zod';

/**
 * SIGN IN WITH GOOGLE
 *
 * The flow is split between the two apps, on purpose:
 *
 *   web   /auth/google/start     → makes `state` + PKCE, redirects to Google
 *   Google                        → user consents
 *   web   /auth/google/callback  → checks `state`, POSTs the code to the API
 *   API   POST /v1/auth/oauth/google → exchanges the code with Google,
 *                                      finds or creates the user, returns
 *                                      the same AuthResult as a password login
 *
 * The API stays cookie-free and stateless; the web app owns cookies, exactly
 * as it does for password login (Decision 019). And the browser never holds a
 * Google token either — only the web server sees it.
 */

export const OAUTH_PROVIDERS = ['google', 'apple', 'facebook'] as const;
export const oauthProviderSchema = z.enum(OAUTH_PROVIDERS);
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

/**
 * What the web app sends after Google redirects back.
 *
 * `redirectUri` is echoed because Google requires the token exchange to use
 * the *same* redirect URI as the authorization request, and the web app knows
 * which locale-prefixed URL it used.
 */
export const googleCallbackSchema = z.object({
  code: z.string().min(10).max(2048),
  /** PKCE verifier — proves this is the same client that started the flow. */
  codeVerifier: z.string().min(43).max(128),
  redirectUri: z.string().url().max(500),
});
export type GoogleCallbackInput = z.infer<typeof googleCallbackSchema>;

/** Normalised identity, whichever provider it came from. */
export interface ProviderIdentity {
  provider: OAuthProvider;
  /** The provider's stable subject id. NEVER the email. */
  subject: string;
  email: string | null;
  /**
   * Whether the PROVIDER asserts it verified this address.
   *
   * Everything about safe account linking hangs on this flag: linking an
   * unverified email would let anyone who can make a provider assert
   * `someone@else.com` take over that account.
   */
  emailVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
}

/** Told to the client so the UI can say "linked to Google". */
export interface LinkedProvider {
  provider: OAuthProvider;
  emailAtLink: string | null;
  linkedAt: string;
}
