import { Inject, Injectable } from '@nestjs/common';
import type { GoogleCallbackInput, ProviderIdentity } from '@rihlati/shared';
import { AppError } from '../../common/errors/app-error';
import { APP_CONFIG, type AppConfig } from '../../config/env';

/**
 * Talks to Google. Split out from OAuthService so the interesting logic —
 * which account this identity belongs to — can be tested without the network.
 */
export abstract class GoogleOAuthClient {
  abstract exchangeCode(input: GoogleCallbackInput): Promise<ProviderIdentity>;
}

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

interface GoogleTokenResponse {
  id_token?: string;
}

interface GoogleIdTokenClaims {
  iss?: string;
  aud?: string;
  exp?: number;
  sub?: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  picture?: string;
}

@Injectable()
export class HttpGoogleOAuthClient extends GoogleOAuthClient {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    super();
  }

  async exchangeCode(input: GoogleCallbackInput): Promise<ProviderIdentity> {
    const clientId = this.config.GOOGLE_CLIENT_ID;
    const clientSecret = this.config.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new AppError('FORBIDDEN', "La connexion Google n'est pas configurée");
    }

    const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: input.code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: input.redirectUri,
        grant_type: 'authorization_code',
        code_verifier: input.codeVerifier,
      }),
    });

    if (!response.ok) {
      // Google's error body can name the client id. Never forward it.
      throw new AppError('TOKEN_INVALID', 'Échec de la connexion Google');
    }

    const body = (await response.json()) as GoogleTokenResponse;
    if (!body.id_token) throw new AppError('TOKEN_INVALID', 'Réponse Google incomplète');

    return this.readIdToken(body.id_token, clientId);
  }

  /**
   * Reads the ID token's claims and checks issuer, audience and expiry.
   *
   * The SIGNATURE is deliberately not verified here, and that is correct for
   * this flow rather than a shortcut: OIDC Core §3.1.3.7 says a token
   * received by direct TLS communication with the provider's token endpoint
   * may rely on TLS server validation instead of the signature. We asked
   * Google directly over HTTPS a millisecond ago; nobody else was in the
   * conversation.
   *
   * > If we ever accept an ID token from the BROWSER — Google One Top /
   * > One Tap, or a mobile SDK — signature verification against Google's JWKS
   * > becomes mandatory, because then the token arrives from an untrusted
   * > party. Do not copy this function into that path.
   */
  private readIdToken(idToken: string, clientId: string): ProviderIdentity {
    const payload = idToken.split('.')[1];
    if (!payload) throw new AppError('TOKEN_INVALID', 'Token Google illisible');

    let claims: GoogleIdTokenClaims;
    try {
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as GoogleIdTokenClaims;
    } catch {
      throw new AppError('TOKEN_INVALID', 'Token Google illisible');
    }

    if (!claims.iss || !GOOGLE_ISSUERS.includes(claims.iss)) {
      throw new AppError('TOKEN_INVALID', 'Émetteur inattendu');
    }
    // Without this an attacker could present a token Google issued for a
    // DIFFERENT application and log in as its user.
    if (claims.aud !== clientId) {
      throw new AppError('TOKEN_INVALID', 'Token destiné à une autre application');
    }
    if (!claims.exp || claims.exp * 1000 < Date.now()) {
      throw new AppError('TOKEN_EXPIRED', 'Token Google expiré');
    }
    if (!claims.sub) throw new AppError('TOKEN_INVALID', 'Identité Google incomplète');

    return {
      provider: 'google',
      subject: claims.sub,
      email: claims.email?.trim().toLowerCase() ?? null,
      // Google sends this as a boolean, but some providers send the string
      // "true". Accept only an explicit true of either shape — anything else,
      // including undefined, means NOT verified.
      emailVerified: claims.email_verified === true || claims.email_verified === 'true',
      displayName: claims.name ?? null,
      avatarUrl: claims.picture ?? null,
    };
  }
}
