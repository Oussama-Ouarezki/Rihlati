import { getLocale } from 'next-intl/server';
import { redirect } from '@/i18n/navigation';

/** /console is a shell — the inbox is the room agencies live in. */
export default async function ConsoleIndex() {
  redirect({ href: '/console/leads', locale: await getLocale() });
}
