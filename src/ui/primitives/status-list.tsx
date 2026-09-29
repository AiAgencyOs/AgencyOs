import { cx, TONE_CHIP, TONE_TEXT, type Tone } from '../tokens';

export type StatusRow = { label: React.ReactNode; state: React.ReactNode; tone: Tone; icon?: React.ReactNode };

/**
 * "System Status" — an icon chip, a name, and the state word on the right in
 * its tone. The word is always printed; nothing here is colour alone.
 */
export function StatusList({ rows, className }: { rows: readonly StatusRow[]; className?: string }) {
  return (
    <ul className={cx('flex flex-col', className)}>
      {rows.map((r, i) => (
        <li key={i} className="flex items-center gap-3 px-4 py-2.5 text-[13px] sm:px-5">
          <span className={cx('flex h-7 w-7 shrink-0 items-center justify-center rounded-full', TONE_CHIP[r.tone])}>
            {r.icon ?? <span className="h-1.5 w-1.5 rounded-full bg-current" />}
          </span>
          <span className="min-w-0 flex-1 truncate text-foreground">{r.label}</span>
          <span className={cx('shrink-0 text-xs font-medium', TONE_TEXT[r.tone])}>{r.state}</span>
        </li>
      ))}
    </ul>
  );
}
