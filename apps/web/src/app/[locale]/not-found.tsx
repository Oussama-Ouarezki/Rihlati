import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';

export default async function NotFound() {
  const t = await getTranslations('common');
  return (
    <div className="flex flex-col items-center gap-4 py-20 text-center">
      <p className="text-5xl">🧭</p>
      <h1 className="text-xl font-semibold">{t('notFound')}</h1>
      <Link href="/" className="font-medium text-brand-700 hover:underline">
        {t('backHome')}
      </Link>
    </div>
  );
}
