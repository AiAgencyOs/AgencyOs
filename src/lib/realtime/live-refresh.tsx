'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { cx, IconRefresh, TONE_DOT, TONE_TEXT } from '@/ui';

import { describeStatus } from './connection';
import type { Topic } from './topics';
import { useLive } from './use-live';

/** Coalesce a burst of change events into one refresh. */
const REFRESH_DEBOUNCE_MS = 400;

/**
 * The live-data control every operational screen carries.
 *
 * Replaces `AutoRefresh` (interval polling with an honest "Updated Xs ago").
 * Same contract on the page's side — drop it in the page header, it re-runs
 * the page's own server reads — but the trigger is now a database change
 * notification rather than a clock, and the caption says which:
 *
 *   ● Live · Updated 3s ago · ↻       the channel is subscribed
 *   ● Reconnecting · …                the channel dropped; retrying, polling meanwhile
 *   ● Degraded · …                    retried too often; polling every 30s
 *
 * The dot is never green on its own say-so: LIVE is what the transport
 * reported, and the word is beside the dot so the state is readable without
 * colour. The manual Refresh stays — a person who wants to be sure should
 * not have to trust a dot.
 */
export function LiveRefresh({
  topics,
  className,
}: {
  /** What this screen shows — see `src/lib/realtime/topics.ts`. */
  topics: readonly Topic[];
  className?: string;
}) {
  const router = useRouter();
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const [, forceTick] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(() => {
    router.refresh();
    setLastRefreshedAt(new Date());
  }, [router]);

  const debouncedRefresh = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(refresh, REFRESH_DEBOUNCE_MS);
  }, [refresh]);

  const live = useLive({ topics, onChange: debouncedRefresh });

  useEffect(() => {
    setLastRefreshedAt(new Date());
    // The "Xs ago" caption re-renders on its own clock; this refetches nothing.
    const tickId = setInterval(() => forceTick((n) => n + 1), 5000);
    return () => {
      clearInterval(tickId);
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const described = describeStatus(live.status);
  const secondsAgo = lastRefreshedAt ? Math.max(0, Math.round((Date.now() - lastRefreshedAt.getTime()) / 1000)) : null;

  return (
    <span className={cx('flex items-center gap-2 text-[11px] text-faint', className)}>
      <span
        role="status"
        aria-live="polite"
        title={described.detail}
        className={cx(
          'inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2 py-0.5 font-medium',
          TONE_TEXT[described.tone],
        )}
      >
        <span
          aria-hidden
          className={cx('h-1.5 w-1.5 shrink-0 rounded-full', TONE_DOT[described.tone], live.status === 'live' && 'animate-pulse')}
        />
        {described.label}
      </span>
      <span className="hidden sm:inline">
        {secondsAgo === null ? null : secondsAgo < 5 ? 'Updated just now' : `Updated ${secondsAgo}s ago`}
      </span>
      <button
        type="button"
        onClick={refresh}
        aria-label="Refresh now"
        className="inline-flex items-center gap-1 font-medium text-muted underline-offset-2 hover:text-foreground hover:underline"
      >
        <IconRefresh size={12} />
        <span className="hidden sm:inline">Refresh</span>
      </button>
    </span>
  );
}
