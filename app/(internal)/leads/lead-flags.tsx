import { Badge } from '@/ui';

/** What the list knows about a lead beyond its columns — SCR-006's consent, handoff, reply and duplicate indicators. */
export type LeadFlagsData = {
  consent: 'granted' | 'withdrawn' | 'none';
  handoff: boolean;
  /** "Never answered" / "Reply waiting" from the attention queue, when the lead is on it. */
  reply: string | null;
  duplicateCount: number;
};

/** Chips only; every one is derived from a stored row (see `lead-indicators-queries.ts`). */
export function LeadFlags({ flags }: { flags: LeadFlagsData }) {
  return (
    <span className="flex max-w-[8rem] flex-wrap gap-1">
      <Badge tone={flags.consent === 'granted' ? 'success' : flags.consent === 'withdrawn' ? 'danger' : 'neutral'} dot={false}>
        {flags.consent === 'granted' ? 'Consent given' : flags.consent === 'withdrawn' ? 'Consent withdrawn' : 'No consent'}
      </Badge>
      {flags.handoff ? <Badge tone="info" dot={false}>Human handoff</Badge> : null}
      {flags.reply ? <Badge tone="warning" dot={false}>{flags.reply}</Badge> : null}
      {flags.duplicateCount > 0 ? <Badge tone="warning" dot={false}>Duplicate ×{flags.duplicateCount + 1}</Badge> : null}
    </span>
  );
}
