'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useLive } from '@/lib/realtime';
import { IconAlert } from '@/ui';

import { readIncidentBannerAction, type IncidentBannerState } from './incident-banner-action';

const REFRESH_DEBOUNCE_MS = 600;

/**
 * The cross-app incident banner — SCR-067/068. Under the global header on
 * every internal page: the unacknowledged CRITICAL alerts and any engaged
 * emergency control, each a link to where a person acts on it. Fetched after
 * paint and kept current by the live channel (`alerts` topic), on the bell's
 * pattern. Nothing rendered until the first answer: a banner that flashed
 * "all clear" before it knew would be the false calm this exists to end.
 */
export function IncidentBanner() {
  const [state, setState] = useState<IncidentBannerState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchState = useCallback(() => {
    readIncidentBannerAction()
      .then(setState)
      .catch(() => {
        /* keep the last known state; the Operations page is one click away */
      });
  }, []);

  const debouncedFetch = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(fetchState, REFRESH_DEBOUNCE_MS);
  }, [fetchState]);

  useLive({ topics: ['alerts'], onChange: debouncedFetch });

  useEffect(() => {
    fetchState();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [fetchState]);

  if (!state || (state.critical.length === 0 && state.engaged.length === 0)) return null;

  return (
    <div role="alert" className="border-b border-danger/30 bg-danger-soft px-4 py-2 text-[13px] text-danger sm:px-6">
      <div className="mx-auto flex w-full max-w-[1400px] flex-wrap items-center gap-x-4 gap-y-1">
        <span className="flex items-center gap-1.5 font-semibold">
          <IconAlert size={14} />
          Incident
        </span>
        {state.engaged.length > 0 ? (
          <Link href="/governance/overrides" className="underline-offset-2 hover:underline">
            Emergency control engaged: {state.engaged.join(', ')}
          </Link>
        ) : null}
        {state.critical.slice(0, 2).map((a) => (
          <Link key={a.id} href="/operations#alerts" className="truncate underline-offset-2 hover:underline">
            {a.summary}
          </Link>
        ))}
        {state.critical.length > 2 ? (
          <Link href="/operations#alerts" className="underline-offset-2 hover:underline">
            +{state.critical.length - 2} more unacknowledged
          </Link>
        ) : null}
      </div>
    </div>
  );
}
