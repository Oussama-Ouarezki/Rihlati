import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import {
  googleCallbackSchema,
  loginSchema,
  logoutSchema,
  refreshSchema,
  registerSchema,
  type AuthResult,
  type AuthTokens,
  type LoginInput,
  type LogoutInput,
  type RefreshInput,
  type GoogleCallbackInput,
  type LinkedProvider,
  type RegisterInput,
  type SessionUser,
} from '@rihlati/shared';
import { CurrentUser, Public } from '../../common/auth/auth.decorators';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { clientIp, userAgent, type AuthenticatedActor } from '../../common/http/request-context';
import { hashIp } from '../../common/crypto/hashing';
import { AuthService, type RequestMeta } from './auth.service';
import { TokenService } from './token.service';
import { OAuthService } from './oauth.service';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import { Inject } from '@nestjs/common';

/**
 * Controllers stay thin: validate, call the service, return. No business rules
 * here — a rule in a controller cannot be reused by a background job or tested
 * without an HTTP server.
 *
 * Every route here is `@Public()` except `/auth/me` and `/auth/logout`, and
 * every public one is rate limited. "Public" on an auth endpoint means the
 * whole internet may call it as fast as it likes unless you say otherwise.
 */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
    private readonly oauth: OAuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** 5 signups per hour per IP. A real person needs one. */
  @Public()
  @Throttle({ register: { limit: 5, ttl: 3_600_000 } })
  @Post('register')
  register(
    @Body(zodBody(registerSchema)) input: RegisterInput,
    @Req() req: Request,
  ): Promise<AuthResult> {
    return this.auth.register(input, this.meta(req));
  }

  /**
   * 10 attempts per 15 minutes per IP.
   *
   * Not per account: locking an account after N failures lets anyone lock a
   * competitor out of their own CRM by typing wrong passwords at them. Rate
   * limiting the SOURCE slows down guessing without handing out that weapon.
   */
  @Public()
  @Throttle({ login: { limit: 10, ttl: 900_000 } })
  @Post('login')
  login(
    @Body(zodBody(loginSchema)) input: LoginInput,
    @Req() req: Request,
  ): Promise<AuthResult> {
    return this.auth.login(input, this.meta(req));
  }

  /**
   * Public because an expired access token is exactly when you call this —
   * requiring a valid one would make it useless. The refresh token in the body
   * is the credential.
   */
  @Public()
  @Throttle({ refresh: { limit: 60, ttl: 3_600_000 } })
  @Post('refresh')
  refresh(
    @Body(zodBody(refreshSchema)) input: RefreshInput,
    @Req() req: Request,
  ): Promise<AuthTokens> {
    return this.tokens.rotate(input.refreshToken, this.meta(req));
  }

  @Post('logout')
  async logout(
    @Body(zodBody(logoutSchema)) input: LogoutInput,
    @CurrentUser() actor: AuthenticatedActor,
  ): Promise<{ ok: true }> {
    await this.tokens.revoke(actor.userId, {
      ...(input.refreshToken ? { refreshToken: input.refreshToken } : {}),
      // With no refresh token supplied, revoke this session's whole family —
      // otherwise "log out" would leave the session alive until it expired.
      familyId: actor.sessionFamilyId,
      allDevices: input.allDevices,
    });
    return { ok: true };
  }

  /**
   * Sign in with Google. The web app has already checked its `state` cookie
   * and holds the PKCE verifier; this exchanges the code with Google and
   * returns the same AuthResult a password login would.
   *
   * Public — the caller is by definition not logged in yet. Rate limited like
   * registration, since case 3 of the linking logic creates an account.
   */
  @Public()
  @Throttle({ oauth: { limit: 20, ttl: 3_600_000 } })
  @Post('oauth/google')
  google(
    @Body(zodBody(googleCallbackSchema)) input: GoogleCallbackInput,
    @Req() req: Request,
  ): Promise<AuthResult> {
    return this.oauth.signInWithGoogle(input, this.meta(req));
  }

  /** Which providers the current user has linked. */
  @Get('me/providers')
  providers(@CurrentUser() actor: AuthenticatedActor): Promise<LinkedProvider[]> {
    return this.oauth.linkedProviders(actor.userId);
  }

  @Get('me')
  me(@CurrentUser() actor: AuthenticatedActor): Promise<SessionUser> {
    return this.auth.me(actor.userId);
  }

  private meta(req: Request): RequestMeta {
    return {
      requestId: req.requestId,
      ...(userAgent(req) ? { userAgent: userAgent(req) } : {}),
      ipHash: hashIp(clientIp(req), this.config.JWT_ACCESS_SECRET),
    };
  }
}
