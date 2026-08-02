import { getTranslations } from 'next-intl/server';
import type { CheckpointType } from '@rihlati/shared';
import { Badge } from '@/components/ui/badge';

const STYLE: Record<CheckpointType, string> = {
  none: 'bg-slate-100 text-slate-400',
  mandatory: 'bg-red-50 text-red-700',
  optional: 'bg-sky-50 text-sky-700',
};

export async function CheckpointTypeBadge(props: { checkpointType: CheckpointType }) {
  if (props.checkpointType === 'none') return null;
  const t = await getTranslations('checkpointTypes');
  return (
    <Badge variant="outline" className={`border-transparent ${STYLE[props.checkpointType]}`}>
      {t(props.checkpointType)}
    </Badge>
  );
}
