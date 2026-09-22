'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cx } from '@/ui';

/**
 * Before this, `/projects/:id/design` and `/projects/:id/plan` were real,
 * working routes with no link to them anywhere in the application — reachable
 * only by typing the URL. This is that link, plus the slot Development
 * (SCR-039/040) needed.
 */
export function ProjectSubNav({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const base = `/projects/${projectId}`;
  const tabs = [
    { href: base, label: 'Overview' },
    { href: `${base}/board`, label: 'Board' },
    { href: `${base}/plan`, label: 'Plan' },
    { href: `${base}/scope`, label: 'Scope' },
    { href: `${base}/design`, label: 'Design' },
    { href: `${base}/prototype`, label: 'Prototype' },
    { href: `${base}/development`, label: 'Development' },
    { href: `${base}/repository`, label: 'Repository' },
    { href: `${base}/builds`, label: 'Builds' },
    { href: `${base}/qa`, label: 'QA' },
    { href: `${base}/calendar`, label: 'Calendar' },
    { href: `${base}/files`, label: 'Files' },
    { href: `${base}/team`, label: 'Team' },
    { href: `${base}/activity`, label: 'Activity' },
  ];

  return (
    <div role="tablist" aria-label="Project sections" className="flex flex-wrap gap-1 rounded-xl border border-line bg-surface p-1">
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
