'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useLive } from '@/lib/realtime';
import { cx, IconBell } from '@/ui';

import { ACTION_ITEMS_CHANGED_EVENT } from './notifications/changed-event';
import { countActionItemsAction, type ActionCount } from './notifications/count-action';

const COUNT_DEBOUNCE_MS = 600;

/**
 * The bell in the global header — "Notifications with unread count" (screen
 * architecture §4, Global Header). The count is the Action Center's own row
 * count, fetched after mount and re-fetched when any table that feeds the
 * Action Center changes, through the same live channel the pages use. So it
 * is live without the layout paying for a read on every render, and it can
 * never disagree with the list a click opens.
 *
 * Until the first answer arrives it shows nothing — a "0" it has not
 * confirmed would be the false calm the dashboard refuses elsewhere.
 */
export function ActionBell() {
  const [count, setCount] = useState<ActionCount | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchCount = useCallback(() => {
    countActionItemsAction()
      .then(setCount)
      .catch(() => {
        /* keep the last known count; the inbox page is one click away */
      });
  }, []);

  const debouncedFetch = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(fetchCount, COUNT_DEBOUNCE_MS);
  }, [fetchCount]);

  useLive({ topics: ['approvals', 'finance', 'jobs', 'qa', 'tasks', 'conversations'], onChange: debouncedFetch });

  useEffect(() => {
    fetchCount();
    // A mark-read / snooze / resolve on the inbox page changes the count
    // without touching any subscribed table, so the page says so directly.
    window.addEventListener(ACTION_ITEMS_CHANGED_EVENT, fetchCount);
    return () => {
      window.removeEventListener(ACTION_ITEMS_CHANGED_EVENT, fetchCount);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [fetchCount]);

  const label =
    count === null
      ? 'Notifications'
      : count.total === 0
        ? 'Notifications — nothing needs attention'
        : `Notifications — ${count.total} item${count.total === 1 ? '' : 's'} need attention${count.urgent ? `, ${count.urgent} urgent` : ''}`;

  return (
    <Link
      href="/notifications"
      aria-label={label}
      title={label}
      className="relative flex h-10 w-10 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
    >
      <IconBell size={20} />
      {count && count.total > 0 ? (
        <span
          aria-hidden
          className={cx(
            'absolute -right-0.5 -top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums',
            count.urgent > 0 ? 'bg-danger text-white' : 'bg-brand text-brand-fg',
          )}
        >
          {count.total > 99 ? '99+' : count.total}
        </span>
      ) : null}
    </Link>
  );
}
