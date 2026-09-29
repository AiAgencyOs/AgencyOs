import { cx } from '../tokens';
import { Card, CardHeader } from './card';

export type DetailField = { label: string; value: React.ReactNode };

/**
 * The right-rail key/value card ("Project Details", "Lead Information") —
 * labels in a fixed column, values beside them, an Edit action in the corner.
 */
export function DetailPanel({
  title,
  rows,
  actions,
  children,
  className,
}: {
  title: React.ReactNode;
  rows: readonly DetailField[];
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardHeader title={title} actions={actions} />
      <DetailFields rows={rows} className="px-4 py-3 sm:px-5" />
      {children}
    </Card>
  );
}

export function DetailFields({ rows, className }: { rows: readonly DetailField[]; className?: string }) {
  return (
    <dl className={cx('grid grid-cols-[minmax(6rem,38%)_1fr] gap-x-3 gap-y-2.5 text-[13px]', className)}>
      {rows.map((r) => (
        <div key={r.label} className="contents">
          <dt className="text-muted">{r.label}</dt>
          <dd className="min-w-0 break-words font-medium text-foreground">{r.value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}
