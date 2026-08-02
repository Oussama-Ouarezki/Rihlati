import { createNavigation } from 'next-intl/navigation';
import { routing } from './routing';

/**
 * Locale-aware replacements for Next's Link/router. Use THESE everywhere —
 * a plain next/link would drop the /ar prefix and silently flip an Arabic
 * reader back to French mid-navigation.
 */
export const { Link, redirect, usePathname, useRouter, getPathname } = createNavigation(routing);
