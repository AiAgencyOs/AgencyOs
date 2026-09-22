'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cx } from '@/ui';

export function SettingsTabs({ tabs }: { tabs: readonly { href: string; label: string }[] }) {
  const pathname = usePathname();

  return (
    <div role="tablist" aria-label="Settings sections" className="flex flex-wrap gap-1 rounded-xl border border-line bg-surface p-1">
      {tabs.map((tab) => {
        const active = tab.href === '/settings' ? pathname === '/settings' : pathname.startsWith(tab.href);
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
