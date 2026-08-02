'use client';

import { useActionState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { login, type LoginState } from '@/lib/auth-actions';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';

/**
 * The login page — a client component only for `useActionState` (pending
 * state + error display). The credentials themselves are handled by the
 * server action; nothing here ever sees a token.
 */
export default function LoginPage() {
  const t = useTranslations('console');
  const [state, formAction, pending] = useActionState<LoginState, FormData>(login, {
    error: null,
  });

  // The Google callback redirects back with a short reason code rather than a
  // provider error string — that could echo our client id into the URL bar.
  const oauthError = useSearchParams().get('oauth_error');
  const oauthMessage =
    oauthError === 'unverified' ? t('errUnverified')
    : oauthError === 'cancelled' ? t('errCancelled')
    : oauthError ? t('errFailed')
    : null;

  return (
    <div className="mx-auto max-w-sm py-12">
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">{t('loginTitle')}</CardTitle>
          <CardDescription>{t('loginSubtitle')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {oauthMessage ? (
            <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">{oauthMessage}</p>
          ) : null}

          {/* A plain link, not a fetch: the OAuth dance is a browser redirect
              and the route sets the state + PKCE cookies on the way out. */}
          <Button variant="outline" size="lg" className="w-full" render={<a href="/auth/google/start" />}>
            <span aria-hidden className="text-lg">G</span>
            {t('google')}
          </Button>

          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <Separator className="flex-1" />
            {t('or')}
            <Separator className="flex-1" />
          </div>

          <form action={formAction} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="identifier">{t('identifier')}</Label>
              <Input
                id="identifier"
                name="identifier"
                dir="ltr"
                autoComplete="username"
                // Survives a failed attempt — retyping your email because the
                // password was wrong is a small insult repeated forever.
                defaultValue={state.identifier ?? ''}
                key={state.identifier ?? 'empty'}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="password">{t('password')}</Label>
              <Input id="password" name="password" type="password" dir="ltr" autoComplete="current-password" />
            </div>

            {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}

            <Button type="submit" size="lg" disabled={pending} className="w-full">
              {pending ? t('signingIn') : t('submit')}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
