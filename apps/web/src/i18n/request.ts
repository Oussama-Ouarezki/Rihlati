import { hasLocale } from 'next-intl';
import { getRequestConfig } from 'next-intl/server';
import { routing } from './routing';

interface Messages {
  default: Record<string, unknown>;
}

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;

  const messages = ((await import(`../../messages/${locale}.json`)) as Messages).default;

  return { locale, messages };
});
