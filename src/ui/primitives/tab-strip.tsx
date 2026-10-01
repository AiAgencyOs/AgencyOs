'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';

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
export function TabStrip({
  tabs,
  label,
  className,
  moreTabs = [],
  moreLabel = 'More',
}: {
  tabs: readonly TabItem[];
  label: string;
  className?: string;
  /** Tabs the reference does not show in its primary row: reached from a "More" menu so no route is stranded. */
  moreTabs?: readonly TabItem[];
  moreLabel?: string;
}) {
  const pathname = usePathname();
  const isActive = (tab: TabItem) => (tab.exact ? pathname === tab.href : pathname === tab.href || pathname.startsWith(`${tab.href}/`));
  return (
    <nav aria-label={label} className={cx('rounded-xl border border-line bg-surface shadow-xs', className)}>
      <ul className="scrollbar-none flex overflow-x-auto px-2">
        {tabs.map((tab) => {
          const active = isActive(tab);
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
        {moreTabs.length > 0 ? (
          <li className="shrink-0">
            <MoreMenu tabs={moreTabs} label={moreLabel} pathname={pathname} isActive={isActive} />
          </li>
        ) : null}
      </ul>
    </nav>
  );
}

/**
 * The "More" tab: a button that opens a short list of the remaining sections.
 * The list is fixed-positioned under the button so the strip's own sideways
 * scroll (phone) cannot clip it; Escape and a click elsewhere close it.
 */
function MoreMenu({ tabs, label, pathname, isActive }: { tabs: readonly TabItem[]; label: string; pathname: string; isActive: (tab: TabItem) => boolean }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const current = tabs.find(isActive);

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const rect = button.current?.getBoundingClientRect();
    if (rect) setPos({ top: rect.bottom + 4, left: Math.max(8, Math.min(rect.left, window.innerWidth - 232)) });
    const onDown = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && menu.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={menuId}
        aria-haspopup="true"
        onClick={() => setOpen((v) => !v)}
        className={cx('relative flex h-11 items-center gap-1.5 px-3.5 text-[13px] font-medium transition-colors', current ? 'text-brand' : 'text-muted hover:text-foreground')}
      >
        {label}
        {current ? <span className="rounded-full bg-brand-soft px-1.5 py-0.5 text-[10px] font-semibold text-brand">{current.label}</span> : null}
        <span aria-hidden className="text-[10px]">▾</span>
        <span aria-hidden className={cx('absolute inset-x-2 bottom-0 h-0.5 rounded-full', current ? 'bg-brand' : 'bg-transparent')} />
      </button>
      {open && pos ? (
        <div
          ref={menu}
          id={menuId}
          style={{ top: pos.top, left: pos.left }}
          className="fixed z-50 max-h-[70vh] w-56 overflow-y-auto rounded-xl border border-line bg-surface p-1.5 shadow-md"
        >
          <ul>
            {tabs.map((tab) => {
              const active = isActive(tab);
              return (
                <li key={tab.href}>
                  <Link
                    href={tab.href}
                    aria-current={active ? 'page' : undefined}
                    className={cx('flex h-9 items-center gap-2 rounded-lg px-2.5 text-[13px] font-medium', active ? 'bg-brand-soft text-brand' : 'text-foreground hover:bg-surface-hover')}
                  >
                    {tab.icon ? <span className="shrink-0 text-muted">{tab.icon}</span> : null}
                    {tab.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </>
  );
}
