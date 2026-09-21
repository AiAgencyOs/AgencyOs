'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cx } from '@/ui';

/**
 * A second tab strip, scoped to Phase 3 itself — Master §8's decision trail
 * split across focused surfaces rather than one 800-line page.
 *
 * Every section this splits across still reads from the same
 * `readDesignTrail` this page has always used and writes through the same
 * eleven Server Actions in `design-forms.tsx`. This is a navigation change,
 * not a new capability — the single-page version answered every item Phase 3
 * Admin visibility asks for; this only makes each answer easier to find.
 */
export function DesignSubNav({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const base = `/projects/${projectId}/design`;
  const tabs = [
    { href: base, label: 'Overview' },
    { href: `${base}/themes`, label: 'Themes' },
    { href: `${base}/colors`, label: 'Colors' },
    { href: `${base}/final`, label: 'Final selection' },
  ];

  return (
    <div role="tablist" aria-label="Design sections" className="flex flex-wrap gap-1 rounded-xl border border-line bg-surface p-1">
      {tabs.map((tab) => {
        const active = tab.href === base ? pathname === base : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            role="tab"
            aria-selected={active}
            className={cx(
              'flex min-h-9 items-center justify-center rounded-lg px-3 text-[13px] font-medium transition-colors',
              active ? 'bg-brand text-brand-fg shadow-xs' : 'text-muted hover:bg-surface-hover',
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
