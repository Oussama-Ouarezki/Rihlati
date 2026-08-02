import { cn } from '@/lib/utils';

/**
 * What the three marker colours mean. Small, quiet, and above the road rather
 * than below it — a legend read after the fact is a legend nobody read.
 */
export function RoadmapLegend(props: {
  labels: { completed: string; current: string; upcoming: string };
}) {
  const entries = [
    { key: 'completed', dot: 'bg-emerald-500', label: props.labels.completed },
    { key: 'current', dot: 'bg-brand-600', label: props.labels.current },
    { key: 'upcoming', dot: 'bg-white ring-1 ring-slate-300', label: props.labels.upcoming },
  ] as const;

  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
      {entries.map((entry) => (
        <li key={entry.key} className="flex items-center gap-1.5">
          <span className={cn('size-2.5 rounded-full', entry.dot)} aria-hidden />
          {entry.label}
        </li>
      ))}
    </ul>
  );
}
