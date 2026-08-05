'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CopyPlus, Layers } from 'lucide-react';
import type { MilestoneItem, ProgrammeCopySource } from '@rihlati/shared';
import {
  copyProgrammeFromOffer,
  duplicateMilestoneDay,
  type MilestoneFormState,
} from '@/lib/milestone-actions';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/**
 * THE TWO TIME-SAVERS on the programme editor — see
 * obsidian/Backend/Trip Programme.md §7.6.
 *
 * An Omra programme is repetitive by nature: five near-identical days in
 * Makkah, and next season's trip is last season's with new dates. Typing that
 * out again is the moment an agency abandons the structured programme and goes
 * back to a paragraph of prose in the description — which is the thing this
 * whole feature exists to replace. So these are not conveniences bolted on the
 * side; they are what makes the list survive contact with a real 14-day trip.
 *
 * Both are ADDITIVE and say so in their button text. Neither ever moves or
 * deletes an existing step, so the undo is "delete the rows it just made" —
 * visible and possible. A bulk action that rewrote the programme underneath
 * the agency would have no undo at all.
 */
export function ProgrammeBulkActions(props: {
  offerId: string;
  milestones: MilestoneItem[];
  copySources: ProgrammeCopySource[];
}) {
  const hasProgramme = props.milestones.length > 0;
  const hasSources = props.copySources.length > 0;

  if (!hasProgramme && !hasSources) return null;

  // Side by side only when there are two. A lone card at half width on an
  // empty programme — the exact moment "copy last season's" is most useful —
  // reads as an afterthought next to a column of blank space.
  return (
    <div className={hasProgramme && hasSources ? 'grid gap-4 sm:grid-cols-2' : 'grid gap-4'}>
      {hasProgramme ? (
        <DuplicateDayCard offerId={props.offerId} milestones={props.milestones} />
      ) : null}
      {hasSources ? (
        <CopyFromOfferCard offerId={props.offerId} sources={props.copySources} />
      ) : null}
    </div>
  );
}

/** The shared error box. Translates the one code an agency really hits. */
function BulkError(props: { state: MilestoneFormState }) {
  const t = useTranslations('programme');
  if (!props.state.error) return null;

  const message =
    props.state.code === 'MILESTONE_LIMIT_REACHED' ? t('limitReached') : props.state.error;

  return (
    <p className="rounded-xl bg-destructive/10 px-3 py-2 text-xs text-destructive">{message}</p>
  );
}

function DuplicateDayCard(props: { offerId: string; milestones: MilestoneItem[] }) {
  const t = useTranslations('programme');
  const action = duplicateMilestoneDay.bind(null, props.offerId);
  const [state, formAction, pending] = useActionState<MilestoneFormState, FormData>(action, {
    error: null,
  });

  // Only days that actually have steps can be a source — offering an empty day
  // to duplicate is offering a button that can only fail.
  const countByDay = new Map<number, number>();
  for (const milestone of props.milestones) {
    countByDay.set(milestone.dayOffset, (countByDay.get(milestone.dayOffset) ?? 0) + 1);
  }
  const sourceDays = [...countByDay.keys()].sort((a, b) => a - b);
  const firstDay = sourceDays[0] ?? 0;
  const maxDay = Math.max(...props.milestones.map((milestone) => milestone.dayOffset));

  // Target may be any existing day, plus one past the end — "add another day
  // just like this one" is the common case, and it needs a day that is not
  // there yet.
  const targetDays = Array.from({ length: maxDay + 2 }, (_, day) => day);

  // Controlled so the target can follow the source: picking day 6 proposes
  // day 7 without forcing it, which is the sequence agencies build in.
  const [sourceDay, setSourceDay] = useState(String(firstDay));
  const [targetDay, setTargetDay] = useState(String(firstDay + 1));

  // Base UI's SelectValue prints the raw `value` unless it is handed a
  // formatter. Without these the trigger reads "3", not "Jour 4".
  const sourceLabel = (value: string) =>
    `${t('dayLabel', { day: Number(value) + 1 })} (${countByDay.get(Number(value)) ?? 0})`;
  const targetLabel = (value: string) =>
    Number(value) > maxDay
      ? `${t('dayLabel', { day: Number(value) + 1 })} — ${t('newDay')}`
      : t('dayLabel', { day: Number(value) + 1 });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Layers className="size-4 text-brand-700" />
          {t('duplicateDay')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="space-y-3">
          <BulkError state={state} />
          <p className="text-xs text-muted-foreground">{t('duplicateDayHint')}</p>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t('duplicateFrom')}</Label>
              <Select
                name="sourceDayOffset"
                value={sourceDay}
                onValueChange={(value) => {
                  const next = String(value);
                  setSourceDay(next);
                  setTargetDay(String(Number(next) + 1));
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue>{(value: string) => sourceLabel(value)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {sourceDays.map((day) => (
                    <SelectItem key={day} value={String(day)}>
                      {sourceLabel(String(day))}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>{t('duplicateTo')}</Label>
              <Select
                name="targetDayOffset"
                value={targetDay}
                onValueChange={(value) => setTargetDay(String(value))}
              >
                <SelectTrigger className="w-full">
                  <SelectValue>{(value: string) => targetLabel(value)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {targetDays.map((day) => (
                    <SelectItem key={day} value={String(day)}>
                      {targetLabel(String(day))}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <Button type="submit" variant="outline" size="sm" disabled={pending}>
            {pending ? t('saving') : t('duplicateDayAction')}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function CopyFromOfferCard(props: { offerId: string; sources: ProgrammeCopySource[] }) {
  const t = useTranslations('programme');
  const action = copyProgrammeFromOffer.bind(null, props.offerId);
  const [state, formAction, pending] = useActionState<MilestoneFormState, FormData>(action, {
    error: null,
  });

  const [sourceOfferId, setSourceOfferId] = useState(props.sources[0]?.offerId ?? '');
  const selected = props.sources.find((source) => source.offerId === sourceOfferId);

  // Without this formatter the trigger shows the offer's UUID.
  const sourceLabel = (value: string) => {
    const source = props.sources.find((candidate) => candidate.offerId === value);
    if (!source) return '';
    // A middot, not a dash: offer titles routinely contain their own em-dash
    // ("Omra Ramadan 2027 — 15 jours depuis Alger") and a second one makes the
    // count look like part of the title.
    return `${source.title} · ${t('stepCount', { count: source.milestoneCount })}`;
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <CopyPlus className="size-4 text-brand-700" />
          {t('copyFromOffer')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="space-y-3">
          <BulkError state={state} />
          <p className="text-xs text-muted-foreground">{t('copyFromOfferHint')}</p>

          <div className="space-y-1.5">
            <Label>{t('copySource')}</Label>
            <Select
              name="sourceOfferId"
              value={sourceOfferId}
              onValueChange={(value) => setSourceOfferId(String(value))}
            >
              <SelectTrigger className="w-full">
                <SelectValue>{(value: string) => sourceLabel(value)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {props.sources.map((source) => (
                  <SelectItem key={source.offerId} value={source.offerId}>
                    {sourceLabel(source.offerId)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Button type="submit" variant="outline" size="sm" disabled={pending || !sourceOfferId}>
            {pending
              ? t('saving')
              : t('copyFromOfferAction', { count: selected?.milestoneCount ?? 0 })}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
