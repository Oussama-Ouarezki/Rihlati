'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  CHECKPOINT_TYPES,
  MILESTONE_KINDS,
  MILESTONE_TITLE_MAX,
  type MilestoneItem,
} from '@rihlati/shared';
import type { MilestoneFormState } from '@/lib/milestone-actions';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';

/**
 * One form for creating and editing a milestone. `checkpointType` is the
 * field that decides whether this step gets its own attendance screen — see
 * obsidian/Backend/Trip Programme.md §6 for what each value means.
 */
export function MilestoneForm(props: {
  action: (state: MilestoneFormState, formData: FormData) => Promise<MilestoneFormState>;
  /** Absent when creating. */
  milestone?: MilestoneItem;
  submitLabel: string;
}) {
  const t = useTranslations('programme');
  const tKinds = useTranslations('milestoneKinds');
  const tCheckpoint = useTranslations('checkpointTypes');

  const [state, formAction, pending] = useActionState<MilestoneFormState, FormData>(props.action, {
    error: null,
  });

  const milestone = props.milestone;

  // Purely a nudge: the server enforces the same limit. Agencies write long
  // descriptive titles by habit, and on the traveler's map a long title is an
  // unreadable tile — so show the cost while they type, not after they save.
  const [titleLength, setTitleLength] = useState(milestone?.title.length ?? 0);

  return (
    <form action={formAction} className="space-y-3">
      {state.error ? (
        <div className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <p className="font-medium">{state.error}</p>
          {state.fields ? (
            <ul className="mt-1 list-disc ps-5 text-xs">
              {Object.entries(state.fields).map(([field, messages]) => (
                <li key={field}>
                  {field}: {messages.join(', ')}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <div className="flex items-baseline justify-between gap-2">
            <Label htmlFor="title">{t('milestoneTitle')}</Label>
            <span
              className={
                titleLength > MILESTONE_TITLE_MAX - 10
                  ? 'text-xs font-medium text-orange-600'
                  : 'text-xs text-muted-foreground'
              }
            >
              {t('titleCounter', { count: titleLength, max: MILESTONE_TITLE_MAX })}
            </span>
          </div>
          <Input
            id="title"
            name="title"
            required
            minLength={2}
            maxLength={MILESTONE_TITLE_MAX}
            defaultValue={milestone?.title}
            onChange={(event) => setTitleLength(event.currentTarget.value.length)}
            placeholder={t('milestoneTitlePlaceholder')}
          />
          <p className="text-xs text-muted-foreground">{t('titleHint')}</p>
        </div>

        <div className="space-y-1.5">
          <Label>{t('kind')}</Label>
          <Select name="kind" defaultValue={milestone?.kind ?? 'other'}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MILESTONE_KINDS.map((kind) => (
                <SelectItem key={kind} value={kind}>
                  {tKinds(kind)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label>{t('checkpointType')}</Label>
          <Select name="checkpointType" defaultValue={milestone?.checkpointType ?? 'none'}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CHECKPOINT_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {tCheckpoint(type)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="dayOffset">{t('dayOffset')}</Label>
          <Input
            id="dayOffset"
            name="dayOffset"
            type="number"
            min={0}
            max={365}
            defaultValue={milestone?.dayOffset ?? 0}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="timeOfDay">{t('timeOfDay')}</Label>
          <Input id="timeOfDay" name="timeOfDay" type="time" defaultValue={milestone?.timeOfDay ?? ''} />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="locationName">{t('locationName')}</Label>
          <Input
            id="locationName"
            name="locationName"
            maxLength={200}
            defaultValue={milestone?.locationName ?? ''}
            placeholder={t('locationNamePlaceholder')}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="mapUrl">{t('mapUrl')}</Label>
          <Input
            id="mapUrl"
            name="mapUrl"
            type="url"
            maxLength={2048}
            defaultValue={milestone?.mapUrl ?? ''}
            placeholder="https://maps.app.goo.gl/…"
            dir="ltr"
          />
        </div>

        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="meetingPoint">{t('meetingPoint')}</Label>
          <Input
            id="meetingPoint"
            name="meetingPoint"
            maxLength={500}
            defaultValue={milestone?.meetingPoint ?? ''}
            placeholder={t('meetingPointPlaceholder')}
          />
        </div>

        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="description">{t('description')}</Label>
          <Textarea
            id="description"
            name="description"
            rows={2}
            maxLength={1000}
            defaultValue={milestone?.description ?? ''}
          />
        </div>
      </div>

      <Button type="submit" disabled={pending}>
        {pending ? t('saving') : props.submitLabel}
      </Button>
    </form>
  );
}
