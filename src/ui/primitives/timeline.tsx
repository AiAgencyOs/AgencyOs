import { cx, TONE_DOT, type Tone } from '../tokens';

export type TimelineStep = { label: string; caption?: string; state: 'done' | 'current' | 'upcoming' };

/**
 * The horizontal milestone timeline — a dot per step joined by a rule, done
 * steps filled, the current one ringed, the rest hollow. Labels sit under
 * the dots. Scrolls sideways on a phone.
 */
export function Timeline({ steps, className }: { steps: readonly TimelineStep[]; className?: string }) {
  return (
    <ol className={cx('scrollbar-none flex overflow-x-auto pb-1', className)}>
      {steps.map((s, i) => {
        const last = i === steps.length - 1;
        const tone: Tone = s.state === 'done' ? 'success' : s.state === 'current' ? 'brand' : 'neutral';
        return (
          <li key={`${s.label}-${i}`} className="flex min-w-[8.5rem] flex-1 flex-col">
            <div className="flex items-center">
              <span
                aria-hidden
                className={cx(
                  'flex h-4 w-4 shrink-0 items-center justify-center rounded-full ring-2',
                  s.state === 'upcoming' ? 'bg-surface ring-line-strong' : cx(TONE_DOT[tone], 'ring-transparent'),
                  s.state === 'current' && 'ring-brand/30 ring-4',
                )}
              >
                {s.state === 'done' ? (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12l5 5L20 7" />
                  </svg>
                ) : null}
              </span>
              {!last ? <span aria-hidden className={cx('h-0.5 flex-1', s.state === 'done' ? 'bg-success' : 'border-t-2 border-dashed border-line-strong')} /> : null}
            </div>
            <span className="mt-2 pr-3">
              <span className={cx('block text-[13px] font-medium', s.state === 'upcoming' ? 'text-muted' : 'text-foreground')}>{s.label}</span>
              {s.caption ? <span className="block text-[11px] text-muted">{s.caption}</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
