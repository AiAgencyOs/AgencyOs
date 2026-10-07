import { cx } from '../tokens';

/**
 * P1-BLUEPRINT-046 VersionDiff: the shared way to show "what changed between two versions". It renders sections of added / removed / modified entries with
 * text labels as well as colour (colour is never the only signal). Read-only: it has no handlers and changes nothing.
 */
export type VersionDiffSection = {
  key: string;
  label: string;
  added: readonly string[];
  removed: readonly string[];
  modified: readonly { name: string; from: string; to: string }[];
};

export function VersionDiff({ sections, fromLabel, toLabel, className }: { sections: readonly VersionDiffSection[]; fromLabel: string; toLabel: string; className?: string }) {
  if (sections.length === 0) return <p className="text-sm text-muted">No differences between {fromLabel} and {toLabel}.</p>;
  return (
    <div className={cx('flex flex-col gap-4', className)}>
      {sections.map((s) => (
        <section key={s.key} aria-label={s.label}>
          <h3 className="mb-1 text-sm font-semibold">{s.label}</h3>
          <ul className="flex flex-col gap-1 text-sm">
            {s.added.map((a) => (
              <li key={`a:${a}`} className="rounded border-l-2 border-success bg-success/5 px-2 py-1">
                <span className="mr-2 text-xs font-semibold uppercase">Added in {toLabel}</span>
                {a}
              </li>
            ))}
            {s.removed.map((r) => (
              <li key={`r:${r}`} className="rounded border-l-2 border-danger bg-danger/5 px-2 py-1">
                <span className="mr-2 text-xs font-semibold uppercase">Removed from {fromLabel}</span>
                {r}
              </li>
            ))}
            {s.modified.map((m) => (
              <li key={`m:${m.name}`} className="rounded border-l-2 border-warning bg-warning/5 px-2 py-1">
                <span className="mr-2 text-xs font-semibold uppercase">Changed: {m.name}</span>
                <span className="block text-muted">{fromLabel}: {m.from || 'nothing'}</span>
                <span className="block">{toLabel}: {m.to || 'nothing'}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
