'use client';

import { useEffect, useState } from 'react';

import { cx } from '@/ui';

export type LeadTab = { id: string; label: string; icon?: React.ReactNode };

/**
 * The tab strip under a lead's header. The lead page is one workspace, not
 * nine routes, so each tab jumps to the section that owns it and the strip
 * lights the section last chosen (or scrolled to by a link elsewhere on the
 * page). Sections that are collapsed <details> are opened on the way.
 */
export function LeadTabs({ tabs, initial }: { tabs: readonly LeadTab[]; initial: string }) {
  const [active, setActive] = useState(initial);

  useEffect(() => {
    const fromHash = () => {
      const id = window.location.hash.slice(1);
      if (tabs.some((t) => t.id === id)) setActive(id);
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, [tabs]);

  function go(id: string) {
    setActive(id);
    const el = document.getElementById(id);
    if (el instanceof HTMLDetailsElement) el.open = true;
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.history.replaceState(null, '', `#${id}`);
  }

  return (
    <nav aria-label="Lead sections" className="rounded-xl border border-line bg-surface shadow-xs">
      <ul className="scrollbar-none flex overflow-x-auto px-2">
        {tabs.map((tab) => (
          <li key={tab.id} className="shrink-0">
            <button
              type="button"
              onClick={() => go(tab.id)}
              aria-current={active === tab.id ? 'true' : undefined}
              className={cx(
                'relative flex h-11 items-center gap-2 px-3.5 text-[13px] font-medium transition-colors',
                active === tab.id ? 'text-brand after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full after:bg-brand' : 'text-muted hover:text-foreground',
              )}
            >
              {tab.icon ? <span className="shrink-0 [&>svg]:h-4 [&>svg]:w-4">{tab.icon}</span> : null}
              {tab.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
