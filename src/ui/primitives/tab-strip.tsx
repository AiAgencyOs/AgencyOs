'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cx } from '../tokens';

export type TabItem = {
  href: string;
  label: string;
  icon?: React.ReactNode;
  /** Match only this exact path (the Overview tab), not every path under it. */
  exact?: boolean;
  count?: number;
};

/**
 * The underlined, icon-led tab row every 360 page carries in the reference
 * (Overview · Tasks · Milestones · … · Settings). The current tab is decided
 * from the URL so a page cannot light the wrong one. Scrolls sideways on a
 * phone rather than wrapping into three rows.
 */
export function TabStrip({ tabs, label, className }: { tabs: readonly TabItem[]; label: string; className?: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label={label} className={cx('rounded-xl border border-line bg-surface shadow-xs', className)}>
      <ul className="scrollbar-none flex overflow-x-auto px-2">
        {tabs.map((tab) => {
          const active = tab.exact ? pathname === tab.href : pathname === tab.href || pathname.startsWith(`${tab.href}/`);
          return (
            <li key={tab.href} className="shrink-0">
              <Link
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                className={cx(
                  'relative flex h-11 items-center gap-2 px-3.5 text-[13px] font-medium transition-colors',
                  active ? 'text-brand' : 'text-muted hover:text-foreground',
                )}
              >
                {tab.icon ? <span className="shrink-0">{tab.icon}</span> : null}
                {tab.label}
                {typeof tab.count === 'number' ? (
                  <span className={cx('tabular rounded-full px-1.5 py-0.5 text-[10px] font-semibold', active ? 'bg-brand-soft text-brand' : 'bg-surface-sunken text-muted')}>
                    {tab.count}
                  </span>
                ) : null}
                <span aria-hidden className={cx('absolute inset-x-2 bottom-0 h-0.5 rounded-full', active ? 'bg-brand' : 'bg-transparent')} />
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
