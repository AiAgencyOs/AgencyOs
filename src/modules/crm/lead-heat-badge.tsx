import { Badge } from '@/ui';

import type { LeadHeatLabel } from './lead-heat';

const TONE = { Hot: 'danger', Warm: 'warning', Cold: 'info' } as const;

/**
 * The Hot / Warm / Cold chip. The reasons ride on the hover title (and on a
 * screen reader's description) so the label is never a bare verdict. Plain
 * props, no server imports: usable from both server and client tables.
 */
export function LeadHeatBadge({ label, title }: { label: LeadHeatLabel; title: string }) {
  return (
    <span title={title} aria-label={`${label} lead. ${title.split('\n').slice(1).join('. ')}`}>
      <Badge tone={TONE[label]} dot>
        {label}
      </Badge>
    </span>
  );
}
