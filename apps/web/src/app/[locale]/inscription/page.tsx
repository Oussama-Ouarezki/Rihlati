'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { register, type RegisterState } from '@/lib/auth-actions';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';

/**
 * Signup. A client component only for `useActionState`; the password is handled
 * entirely by the server action and never touches this component's state.
 *
 * Email and phone are BOTH optional, with at least one required — that rule
 * lives in `registerSchema` on the server, not here. Travelers in Algeria are
 * phone-first and often have no email they read; agency staff are the opposite.
 */
export default function SignupPage() {
  const t = useTranslations('signup');
  const [state, formAction, pending] = useActionState<RegisterState, FormData>(register, {
    error: null,
  });

  const fieldError = (name: string): string | null => state.fields?.[name]?.[0] ?? null;

  return (
    <div className="mx-auto max-w-sm py-12">
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">{t('title')}</CardTitle>
          <CardDescription>{t('subtitle')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Same redirect as login: Google signup and Google login are one
              flow, because the API decides create-or-link, not the browser. */}
          <Button
            variant="outline"
            size="lg"
            className="w-full"
            nativeButton={false} render={<a href="/auth/google/start" />}
          >
            <span aria-hidden className="text-lg">
              G
            </span>
            {t('google')}
          </Button>

          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <Separator className="flex-1" />
            {t('or')}
            <Separator className="flex-1" />
          </div>

          <form action={formAction} className="space-y-4">
            <Field
              name="displayName"
              label={t('displayName')}
              autoComplete="name"
              defaultValue={state.values?.displayName}
              error={fieldError('displayName')}
            />

            <Field
              name="phone"
              label={t('phone')}
              hint={t('phoneHint')}
              type="tel"
              dir="ltr"
              autoComplete="tel"
              defaultValue={state.values?.phone}
              error={fieldError('phone')}
            />

            <Field
              name="email"
              label={t('email')}
              hint={t('emailHint')}
              type="email"
              dir="ltr"
              autoComplete="email"
              defaultValue={state.values?.email}
              error={fieldError('email')}
            />

            <Field
              name="password"
              label={t('password')}
              hint={t('passwordHint')}
              type="password"
              dir="ltr"
              autoComplete="new-password"
              error={fieldError('password')}
            />

            {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}

            <Button type="submit" size="lg" disabled={pending} className="w-full">
              {pending ? t('submitting') : t('submit')}
            </Button>
          </form>

          <p className="text-center text-sm text-muted-foreground">
            {t('haveAccount')}{' '}
            <Link href="/connexion" className="font-medium text-primary underline-offset-4 hover:underline">
              {t('signIn')}
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function Field(props: {
  name: string;
  label: string;
  hint?: string;
  type?: string;
  dir?: 'ltr';
  autoComplete?: string;
  defaultValue?: string;
  error: string | null;
}) {
  const describedBy = props.error ? `${props.name}-error` : props.hint ? `${props.name}-hint` : undefined;

  return (
    <div className="space-y-1.5">
      <Label htmlFor={props.name}>{props.label}</Label>
      <Input
        id={props.name}
        name={props.name}
        type={props.type}
        dir={props.dir}
        autoComplete={props.autoComplete}
        // `key` forces React to take the new defaultValue after a failed
        // submit — without it the input keeps its first-render value.
        key={props.defaultValue ?? 'empty'}
        defaultValue={props.defaultValue ?? ''}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={describedBy}
      />
      {props.error ? (
        <p id={`${props.name}-error`} className="text-sm text-destructive">
          {props.error}
        </p>
      ) : props.hint ? (
        <p id={`${props.name}-hint`} className="text-xs text-muted-foreground">
          {props.hint}
        </p>
      ) : null}
    </div>
  );
}
