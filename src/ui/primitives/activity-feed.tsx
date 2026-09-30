import Link from 'next/link';

import { cx, TONE_CHIP, type Tone } from '../tokens';
import { Card, CardHeader } from './card';
import { EmptyState } from './empty-state';

export type ActivityItem = {
  id: string;
  title: React.ReactNode;
  detail?: React.ReactNode;
  /** Already formatted by the agency clock — this component owns no time zone. */
  when: string;
  icon?: React.ReactNode;
  tone?: Tone;
  href?: string;
  /** A control under the row — a governed door the page rendered (bucket F: acknowledge / escalate on a feed item). */
  action?: React.ReactNode;
};

/**
 * "Recent Activity" — an icon chip, a sentence, a time. Every item is a real
 * timestamped fact the page read; the feed invents nothing.
 */
export function ActivityFeed({
  title = 'Recent activity',
  items,
  viewAllHref,
  emptyTitle = 'Nothing yet',
  emptyDescription,
  compact,
  className,
}: {
  title?: React.ReactNode;
  items: readonly ActivityItem[];
  viewAllHref?: string;
  emptyTitle?: string;
  emptyDescription?: string;
  compact?: boolean;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardHeader title={title} actions={viewAllHref ? <ViewAll href={viewAllHref} /> : undefined} />
      {items.length === 0 ? (
        <EmptyState title={emptyTitle} description={emptyDescription} />
      ) : (
        <ul className={cx('flex flex-col', compact ? 'divide-y divide-line' : 'gap-0')}>
          {items.map((item) => {
            const row = (
              <>
                <span className={cx('mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full', TONE_CHIP[item.tone ?? 'neutral'])}>
                  {item.icon ?? <span className="h-1.5 w-1.5 rounded-full bg-current" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium leading-snug text-foreground">{item.title}</span>
                  {item.detail ? <span className="block truncate text-xs text-muted">{item.detail}</span> : null}
                </span>
                <span className="shrink-0 whitespace-nowrap text-[11px] text-faint">{item.when}</span>
              </>
            );
            return (
              <li key={item.id}>
                {item.href ? (
                  <Link href={item.href} className="flex items-start gap-3 px-4 py-2.5 transition-colors hover:bg-surface-hover sm:px-5">
                    {row}
                  </Link>
                ) : (
                  <div className="flex items-start gap-3 px-4 py-2.5 sm:px-5">{row}</div>
                )}
                {item.action ? <div className="px-4 pb-2.5 pl-14 sm:px-5 sm:pl-[3.75rem]">{item.action}</div> : null}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/** The small brand-coloured "View all →" a card header carries in the reference. */
export function ViewAll({ href, label = 'View All' }: { href: string; label?: string }) {
  return (
    <Link href={href} className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">
      {label}
      <span aria-hidden>→</span>
    </Link>
  );
}
