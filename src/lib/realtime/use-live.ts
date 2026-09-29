'use client';

import type { RealtimeChannel } from '@supabase/supabase-js';
import { useEffect, useMemo, useReducer, useRef } from 'react';

import { createClient } from '@/lib/db/client';

import { initialLiveState, pollIntervalMs, reduceLive, type LiveState } from './connection';
import { channelNameFor, tablesFor, type Topic } from './topics';

/**
 * A screen's subscription to the database.
 *
 * Supabase Realtime (Postgres logical replication → websocket) is the
 * transport, chosen because it is the one this stack already runs: no second
 * server, no second auth. The channel carries the signed-in user's JWT, so
 * Row Level Security decides which changes this browser is told about — the
 * same policies that decide which rows the page may read. A change is only
 * ever a SIGNAL here: the payload is discarded and the page re-runs its own
 * server reads, so nothing the browser renders came from anywhere but the
 * authoritative query that always rendered it.
 *
 * `onChange` fires on every change, on every reconnect (catch-up), on every
 * return to the tab, and on the status-appropriate poll interval. Callers
 * debounce it — a burst of ten row updates in a transaction is one refresh.
 */
export function useLive({
  topics,
  onChange,
  enabled = true,
}: {
  topics: readonly Topic[];
  onChange: () => void;
  enabled?: boolean;
}): LiveState {
  const [state, dispatch] = useReducer(reduceLive, undefined, initialLiveState);

  // The latest callback, read at fire time, so the subscription effect does
  // not tear down and rejoin the channel every render the parent re-creates
  // its handler.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const key = useMemo(() => [...new Set(topics)].sort().join('+'), [topics]);

  useEffect(() => {
    const tables = tablesFor(key ? (key.split('+') as Topic[]) : []);
    if (!enabled || tables.length === 0) {
      dispatch({ type: 'unsupported' });
      return;
    }

    const supabase = createClient();
    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    (async () => {
      // The browser client reads the session from cookies; the realtime
      // socket needs the access token explicitly or it joins as `anon` and
      // RLS tells it nothing. supabase-js keeps it fresh on refresh after this.
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (cancelled) return;
      if (session?.access_token) await supabase.realtime.setAuth(session.access_token);
      if (cancelled) return;

      channel = supabase.channel(channelNameFor(key.split('+') as Topic[]), {
        config: { private: false },
      });
      for (const { schema, table } of tables) {
        channel.on('postgres_changes', { event: '*', schema, table }, () => {
          dispatch({ type: 'event' });
          onChangeRef.current();
        });
      }
      channel.subscribe((status) => {
        if (cancelled) return;
        switch (status) {
          case 'SUBSCRIBED':
            dispatch({ type: 'subscribed' });
            break;
          case 'CHANNEL_ERROR':
          case 'TIMED_OUT':
            dispatch({ type: 'error' });
            break;
          case 'CLOSED':
            dispatch({ type: 'closed' });
            break;
        }
      });
    })().catch(() => {
      if (!cancelled) dispatch({ type: 'error' });
    });

    return () => {
      cancelled = true;
      if (channel) void supabase.removeChannel(channel);
    };
  }, [key, enabled]);

  // Catch-up: a rejoin means changes happened while nobody was listening.
  const catchUps = state.catchUps;
  useEffect(() => {
    if (catchUps > 0) onChangeRef.current();
  }, [catchUps]);

  // Returning to the tab is a catch-up of its own — the browser throttles
  // background sockets, and a screen stale for the last ten minutes should
  // not stay stale for another twenty seconds once someone is looking.
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === 'visible') onChangeRef.current();
    }
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  // The safety net, at the rate the status deserves.
  const interval = pollIntervalMs(state.status);
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') onChangeRef.current();
    }, interval);
    return () => clearInterval(id);
  }, [interval]);

  return state;
}
