import { z } from 'zod';

/**
 * ENVIRONMENT VALIDATION
 *
 * The API refuses to start if configuration is missing or wrong. That is the
 * point: the alternative is booting successfully with `JWT_ACCESS_SECRET`
 * undefined, signing tokens with the string "undefined", and finding out in
 * production. A crash at boot is loud, cheap, and happens on your machine.
 *
 * Nothing here is optional-with-a-default when the default would be insecure.
 */

/** Refuses the placeholder values people leave behind after copying .env.example. */
const secretSchema = z
  .string()
  .min(32, 'Secret trop court — générez-en un avec: openssl rand -base64 48')
  .refine(
    (v) => !['changeme', 'secret', 'password', 'development', 'test'].includes(v.toLowerCase()),
    { message: 'Secret trop évident' },
  );

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),

    DATABASE_URL: z.string().url().startsWith('postgresql://'),

    JWT_ACCESS_SECRET: secretSchema,
    JWT_REFRESH_SECRET: secretSchema,
    JWT_ACCESS_TTL: z.string().default('15m'),
    JWT_REFRESH_TTL: z.string().default('30d'),

    /** Comma-separated. Empty in production is a configuration error, not "allow all". */
    CORS_ORIGINS: z.string().default('http://localhost:3000'),

    /**
     * Where the web app lives. Not a secret — it is the public site address —
     * but the API needs it to build tracked-link redirect targets.
     */
    WEB_URL: z.string().url().default('http://localhost:3000'),

    /**
     * Sign in with Google. Both or neither — a client id without a secret
     * fails at the token exchange with a confusing error from Google, so the
     * refinement below rejects the half-configured case at boot instead.
     */
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),

    SENTRY_DSN: z.string().optional(),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  })
  .refine((v) => Boolean(v.GOOGLE_CLIENT_ID) === Boolean(v.GOOGLE_CLIENT_SECRET), {
    message:
      'GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET vont ensemble — configurez les deux ou aucun',
    path: ['GOOGLE_CLIENT_SECRET'],
  })
  .refine((v) => v.JWT_ACCESS_SECRET !== v.JWT_REFRESH_SECRET, {
    message:
      'JWT_ACCESS_SECRET et JWT_REFRESH_SECRET doivent être différents — sinon un token ' +
      "d'accès volé peut être présenté comme un refresh token",
    path: ['JWT_REFRESH_SECRET'],
  });

export type RawEnv = z.infer<typeof envSchema>;

export interface AppConfig extends Omit<RawEnv, 'CORS_ORIGINS'> {
  corsOrigins: string[];
  isProduction: boolean;
  isTest: boolean;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    // Print the failing KEYS, never the values — a bad secret is still a secret
    // and this output goes to CI logs (rule #1).
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Configuration invalide (.env):\n${problems}`);
  }

  const env = parsed.data;
  const corsOrigins = env.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (env.NODE_ENV === 'production' && corsOrigins.length === 0) {
    throw new Error('CORS_ORIGINS est vide en production. Listez les domaines autorisés.');
  }
  if (env.NODE_ENV === 'production' && corsOrigins.includes('*')) {
    throw new Error("CORS_ORIGINS='*' en production autorise n'importe quel site à appeler l'API.");
  }
  if (env.NODE_ENV === 'production' && !env.SENTRY_DSN) {
    // Rule #4. An unmonitored production API means users are your error tracker.
    throw new Error('SENTRY_DSN manquant en production (CLAUDE.md règle #4).');
  }

  const { CORS_ORIGINS: _ignored, ...rest } = env;
  return {
    ...rest,
    corsOrigins,
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
  };
}

/** DI token. Inject with `@Inject(APP_CONFIG) private readonly config: AppConfig`. */
export const APP_CONFIG = Symbol('APP_CONFIG');
