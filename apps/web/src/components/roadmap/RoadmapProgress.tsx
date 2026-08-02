/**
 * "4 of 9 steps done". A bar, a fraction, and nothing else.
 *
 * Deliberately not a percentage on its own: "44%" of a trip is a meaningless
 * number to a traveller, while "step 4 of 9" is exactly the thing they wanted
 * to know. The percentage only drives the bar's width.
 */
export function RoadmapProgress(props: {
  done: number;
  total: number;
  /** Already-formatted, e.g. "4 étapes sur 9 terminées". */
  label: string;
}) {
  const percent = props.total === 0 ? 0 : Math.round((props.done / props.total) * 100);

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium text-slate-600">{props.label}</span>
        <span className="text-xs font-semibold tabular-nums text-brand-700">{percent}%</span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-slate-200"
        role="progressbar"
        aria-valuenow={props.done}
        aria-valuemin={0}
        aria-valuemax={props.total}
        aria-label={props.label}
      >
        <div
          className="h-full rounded-full bg-brand-600 transition-[width] duration-1000 ease-out"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
