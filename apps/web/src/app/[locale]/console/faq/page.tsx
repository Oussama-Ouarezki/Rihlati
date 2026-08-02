import { getTranslations } from 'next-intl/server';
import { LOCALES, type AgencyFaqItemForMember } from '@rihlati/shared';
import { authedGet, getSession, redirectToLogin } from '@/lib/session';
import { createFaq, deleteFaq, toggleFaq } from '@/lib/faq-actions';

export const dynamic = 'force-dynamic';

/**
 * The FAQ editor — "answer your repeated questions once". Shows on the public
 * agency page today; becomes the chatbot's knowledge base later, which is why
 * it's worth an agency's time before the chatbot exists.
 */
export default async function FaqPage() {
  const session = await getSession();
  if (!session?.membership) await redirectToLogin();
  const agencyId = session!.membership!.agencyId;

  const t = await getTranslations('console');
  const entries = await authedGet<AgencyFaqItemForMember[]>(`/v1/agencies/${agencyId}/faq`);

  const input =
    'w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm focus:border-brand-600 focus:outline-none';

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold">{t('faqTitle')}</h2>
        <p className="text-sm text-slate-500">{t('faqIntro')}</p>
      </div>

      {/* ---- add ---- */}
      <form action={createFaq} className="space-y-3 rounded-2xl border border-slate-200 p-4">
        <label className="block">
          <span className="mb-1 block text-xs text-slate-500">{t('question')}</span>
          <input name="question" minLength={5} maxLength={300} required className={input} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-slate-500">{t('answer')}</span>
          <textarea name="answer" rows={3} maxLength={2000} required className={input} />
        </label>
        <div className="flex items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-slate-500">{t('language')}</span>
            <select name="locale" defaultValue="fr" className={input}>
              {LOCALES.map((locale) => (
                <option key={locale} value={locale}>
                  {locale === 'fr' ? 'Français' : locale === 'ar' ? 'العربية' : 'English'}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="rounded-xl bg-brand-600 px-5 py-2 text-sm font-semibold text-white hover:bg-brand-700"
          >
            {t('add')}
          </button>
        </div>
      </form>

      {/* ---- list ---- */}
      {entries.length === 0 ? (
        <p className="text-sm text-slate-400">{t('faqEmpty')}</p>
      ) : (
        <ul className="space-y-2">
          {entries.map((entry) => {
            const toggleAction = toggleFaq.bind(null, entry.id, !entry.isEnabled);
            const deleteAction = deleteFaq.bind(null, entry.id);
            return (
              <li
                key={entry.id}
                className={`rounded-2xl border p-4 ${
                  entry.isEnabled ? 'border-slate-200' : 'border-dashed border-slate-200 opacity-60'
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-60 flex-1">
                    <p className="font-medium">{entry.question}</p>
                    <p className="mt-1 whitespace-pre-line text-sm text-slate-600">{entry.answer}</p>
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 uppercase text-slate-500">
                      {entry.locale}
                    </span>
                    <span className={entry.isEnabled ? 'text-emerald-600' : 'text-slate-400'}>
                      {entry.isEnabled ? t('visible') : t('hidden')}
                    </span>
                    <form action={toggleAction}>
                      <button type="submit" className="rounded-full border border-slate-200 px-3 py-1 hover:bg-slate-50">
                        {entry.isEnabled ? t('hide') : t('show')}
                      </button>
                    </form>
                    <form action={deleteAction}>
                      <button type="submit" className="rounded-full border border-red-100 px-3 py-1 text-red-600 hover:bg-red-50">
                        {t('delete')}
                      </button>
                    </form>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
