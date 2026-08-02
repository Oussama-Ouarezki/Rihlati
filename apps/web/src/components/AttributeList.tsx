import type { AbstractIntlMessages } from 'next-intl';

/**
 * Renders an offer's kind-specific `attributes` JSON as a readable list.
 *
 * One generic component for all seven offer kinds — possible because the API
 * strictly validates attributes per kind, so every key that reaches here is a
 * known key. Labels come from the `attr.*` messages; enum-ish values (meal
 * plans, room types…) from `attrValues.*`. A key without a label falls back
 * to the raw key, which is a visible nudge to add the translation rather than
 * a silent hole.
 */
export function AttributeList(props: {
  attributes: Record<string, unknown>;
  messages: AbstractIntlMessages;
}) {
  const attrLabels = (props.messages['attr'] ?? {}) as Record<string, string>;
  const valueLabels = (props.messages['attrValues'] ?? {}) as Record<string, string>;

  const entries = Object.entries(props.attributes).filter(([key, value]) => {
    if (value === undefined || value === null || value === '') return false;
    if (key === 'notes') return false; // free text, rendered below the grid
    if (value === false) return false; // "not included" is noise, silence it
    return true;
  });

  const notes = props.attributes['notes'];

  if (entries.length === 0 && !notes) return null;

  return (
    <div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        {entries.map(([key, value]) => {
          const label = attrLabels[key] ?? key;

          // `true` means "included": render as a checked item, no value.
          if (value === true) {
            return (
              <div key={key} className="flex items-center gap-2">
                <span className="text-emerald-600">✓</span>
                <span>{label}</span>
              </div>
            );
          }

          const display =
            typeof value === 'string' && valueLabels[value] !== undefined
              ? valueLabels[value]
              : formatScalar(key, value);

          return (
            <div key={key} className="flex justify-between gap-4 border-b border-slate-100 py-1">
              <dt className="text-slate-500">{label}</dt>
              <dd className="text-end font-medium">{display}</dd>
            </div>
          );
        })}
      </dl>

      {typeof notes === 'string' && notes ? (
        <p className="mt-3 whitespace-pre-line text-sm text-slate-500">{notes}</p>
      ) : null}
    </div>
  );
}

function formatScalar(key: string, value: unknown): string {
  if (typeof value === 'number') {
    if (key.endsWith('Stars')) return '★'.repeat(Math.max(1, Math.min(5, value)));
    if (key.endsWith('Meters')) return `${value} m`;
    return String(value);
  }
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}
