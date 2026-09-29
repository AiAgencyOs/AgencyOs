'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { cx } from '../tokens';

/**
 * Near-real-time refresh for a server-rendered page, without a realtime
 * transport. No websocket/SSE/Supabase-channel infrastructure exists in this
 * codebase yet (a real architectural addition), so this is the honest
 * middle ground: `router.refresh()` on an interval re-runs the page's own
 * server reads, which is the same authoritative data the page always showed —
 * just fetched again without the admin having to navigate away and back.
 *
 * It never claims to be "LIVE" — the reference screenshots' live/reconnecting
 * indicator language describes a push transport this page does not have.
 * What it shows instead is true: when the visible data was last confirmed
 * current, and a manual way to do it right now.
 */
export function AutoRefresh({
  intervalMs = 30000,
  className,
}: {
  /** How often to re-fetch while the tab is visible. */
  intervalMs?: number;
  className?: string;
}) {
  const router = useRouter();
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const [, forceTick] = useState(0);

  useEffect(() => {
    setLastRefreshedAt(new Date());
  }, []);

  useEffect(() => {
    function refresh() {
      router.refresh();
      setLastRefreshedAt(new Date());
    }

    const id = setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, intervalMs);

    // Refresh immediately on returning to the tab, rather than waiting out
    // whatever fraction of `intervalMs` elapsed while it was hidden — a
    // dashboard that was stale for the last ten minutes should not stay
    // stale for another twenty seconds once someone is looking at it again.
    function onVisible() {
      if (document.visibilityState === 'visible') refresh();
    }
    document.addEventListener('visibilitychange', onVisible);

    // Re-render every few seconds just to keep the "Xs ago" caption honest —
    // this does not itself refetch anything.
    const tickId = setInterval(() => forceTick((n) => n + 1), 5000);

    return () => {
      clearInterval(id);
      clearInterval(tickId);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // `router` (from `useRouter()`) is stable across renders in the Next.js
    // app router, so omitting it from the dependency array does not risk a
    // stale closure the way it would for a normal prop or state value.
  }, [intervalMs, router]);

  const secondsAgo = lastRefreshedAt ? Math.max(0, Math.round((Date.now() - lastRefreshedAt.getTime()) / 1000)) : null;

  return (
    <span className={cx('flex items-center gap-1.5 text-[11px] text-faint', className)}>
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
      {secondsAgo === null ? null : secondsAgo < 5 ? 'Updated just now' : `Updated ${secondsAgo}s ago`}
      <button
        type="button"
        onClick={() => {
          router.refresh();
          setLastRefreshedAt(new Date());
        }}
        className="font-medium text-muted underline-offset-2 hover:text-foreground hover:underline"
      >
        Refresh
      </button>
    </span>
  );
}
