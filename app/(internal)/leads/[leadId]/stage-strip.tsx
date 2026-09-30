import { leadStageStrip } from '@/lib/admin/lead-stage-strip';
import { Badge, cx, IconCheck } from '@/ui';

/** The reference's seven-segment status strip, read from the lead's real status and its deal's stage (mapping in lead-stage-strip.ts). */
export function LeadStageStrip({ leadStatus, dealStage }: { leadStatus: string; dealStage: string | null }) {
  const { segments, parked } = leadStageStrip({ leadStatus, dealStage });
  return (
    <div className="flex flex-col gap-2">
      <ol aria-label="Lead stage" className="scrollbar-none flex overflow-x-auto rounded-xl border border-line bg-surface p-1 text-[13px] font-medium">
        {segments.map((s) => (
          <li
            key={s.label}
            aria-current={s.state === 'current' || s.state === 'lost' ? 'step' : undefined}
            className={cx(
              'flex min-w-[7rem] flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2.5',
              s.state === 'current' && 'bg-brand-soft text-brand',
              s.state === 'done' && 'bg-success-soft/60 text-success',
              s.state === 'lost' && 'bg-danger-soft text-danger',
              s.state === 'upcoming' && (s.label === 'Lost' ? 'text-danger/70' : 'text-muted'),
            )}
          >
            {s.state === 'done' ? <IconCheck size={13} /> : null}
            {s.label}
          </li>
        ))}
      </ol>
      {parked ? <Badge tone="warning">Parked in nurture, off this path until it is reopened</Badge> : null}
    </div>
  );
}
