import Link from 'next/link';

import { cx, type Tone } from '../tokens';

export type PipelineStage = { label: string; count: number; tone?: Tone; href?: string };

const STAGE_TINT: Record<Tone, string> = {
  neutral: 'bg-surface-sunken text-foreground',
  brand: 'bg-brand-soft text-brand',
  accent: 'bg-accent-soft text-foreground',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-info-soft text-info',
};

/**
 * The chevron funnel — "12 Leads › 8 Qualified › 5 Quoted › …" — each stage a
 * count over a label, coloured by tone, linking to the list it counts.
 */
export function PipelineStrip({ stages, className }: { stages: readonly PipelineStage[]; className?: string }) {
  return (
    <ol className={cx('scrollbar-none flex gap-1 overflow-x-auto', className)}>
      {stages.map((s, i) => {
        const first = i === 0;
        const last = i === stages.length - 1;
        const shape = first
          ? 'polygon(0 0, calc(100% - 12px) 0, 100% 50%, calc(100% - 12px) 100%, 0 100%)'
          : last
            ? 'polygon(0 0, 100% 0, 100% 100%, 0 100%, 12px 50%)'
            : 'polygon(0 0, calc(100% - 12px) 0, 100% 50%, calc(100% - 12px) 100%, 0 100%, 12px 50%)';
        const body = (
          <span
            className={cx('flex h-14 min-w-[5.25rem] flex-1 flex-col items-center justify-center', STAGE_TINT[s.tone ?? 'neutral'], first ? 'rounded-l-lg' : '', last ? 'rounded-r-lg' : '')}
            style={{ clipPath: shape }}
          >
            <span className="tabular text-lg font-semibold leading-none">{s.count}</span>
            <span className="mt-1 text-[11px] font-medium opacity-80">{s.label}</span>
          </span>
        );
        return (
          <li key={s.label} className="flex min-w-0 flex-1">
            {s.href ? (
              <Link href={s.href} className="flex min-w-0 flex-1 rounded-lg transition-opacity hover:opacity-80">
                {body}
              </Link>
            ) : (
              body
            )}
          </li>
        );
      })}
    </ol>
  );
}
