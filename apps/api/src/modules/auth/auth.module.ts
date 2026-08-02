import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';
import { OAuthService } from './oauth.service';
import { GoogleOAuthClient, HttpGoogleOAuthClient } from './google-oauth.client';

/**
 * `JwtModule.register({})` with no secret is intentional: each call passes its
 * own secret explicitly. Access and refresh tokens are signed with DIFFERENT
 * secrets, and a module-level default is how they quietly end up sharing one.
 */
@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    AuthService,
    TokenService,
    OAuthService,
    // Bound to an abstract class so tests can swap in a stub and exercise the
    // account-linking rules without touching the network.
    { provide: GoogleOAuthClient, useClass: HttpGoogleOAuthClient },
  ],
  exports: [TokenService, OAuthService],
})
export class AuthModule {}
