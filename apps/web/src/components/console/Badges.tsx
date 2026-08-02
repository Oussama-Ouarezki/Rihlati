import type { LeadQuality, LeadStage } from '@rihlati/shared';

/**
 * Color semantics, used consistently so an agent scanning the inbox reads
 * state without reading words: blues = in progress, green = money, slate =
 * finished/quiet, red = a judgement about a person (spam/troll).
 */
const STAGE_STYLE: Record<LeadStage, string> = {
  new: 'bg-brand-50 text-brand-700',
  contacted: 'bg-sky-50 text-sky-700',
  quoted: 'bg-indigo-50 text-indigo-700',
  negotiating: 'bg-amber-50 text-amber-700',
  booked: 'bg-violet-50 text-violet-700',
  paid: 'bg-emerald-50 text-emerald-700',
  travelled: 'bg-green-50 text-green-700',
  lost: 'bg-slate-100 text-slate-500',
};

const QUALITY_STYLE: Record<LeadQuality, string> = {
  unrated: 'bg-slate-100 text-slate-400',
  spam: 'bg-red-50 text-red-600',
  troll: 'bg-red-50 text-red-600',
  cold: 'bg-sky-50 text-sky-600',
  warm: 'bg-orange-50 text-orange-600',
  serious: 'bg-emerald-50 text-emerald-700',
  vip: 'bg-amber-100 text-amber-700',
};

export function StageBadge(props: { stage: string; label: string }) {
  const style = STAGE_STYLE[props.stage as LeadStage] ?? STAGE_STYLE.new;
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${style}`}>{props.label}</span>
  );
}

/**
 * `unrated` renders nothing: it is the default state of every lead, and a
 * badge that appears on every row is a badge nobody sees.
 */
export function QualityBadge(props: { quality: string; label?: string }) {
  if (props.quality === 'unrated') return null;
  const style = QUALITY_STYLE[props.quality as LeadQuality] ?? QUALITY_STYLE.unrated;
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${style}`}>
      {props.label ?? props.quality}
    </span>
  );
}
