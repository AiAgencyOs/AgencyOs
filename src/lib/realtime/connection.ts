/**
 * The connection's own state machine, with no socket in it.
 *
 * The transport (`use-live.ts`) reports what happened; this decides what it
 * means — which is the part that must be right and the part a unit test can
 * reach. Three rules it exists to keep:
 *
 *   1. A screen never claims LIVE unless a channel really said SUBSCRIBED.
 *      Before that it is "connecting", and after any failure it is
 *      "reconnecting" — the reference screenshots' green dot is earned, not
 *      decorative.
 *   2. A reconnect is a CATCH-UP. Between a drop and a rejoin the database
 *      kept changing and nobody was listening, so the rejoin must refetch —
 *      `catchUps` increments on every SUBSCRIBED after the first, and the
 *      component refreshes when it sees the number move.
 *   3. Repeated failure degrades rather than dies. After
 *      `DEGRADED_AFTER_FAILURES` the screen says so plainly and falls back to
 *      polling, which is slower but never stale by more than one interval.
 */

export type LiveStatus =
  /** Channel requested, no answer yet. */
  | 'connecting'
  /** Subscribed: changes arrive as they are committed. */
  | 'live'
  /** Lost the channel, the client is retrying. */
  | 'reconnecting'
  /** Retried too often; polling until the channel comes back. */
  | 'degraded'
  /** No transport (no topics, or the page opted out): polling only. */
  | 'polling';

export type LiveState = {
  status: LiveStatus;
  /** Consecutive failures since the last SUBSCRIBED. */
  failures: number;
  /** Whether the channel has ever been live — a rejoin, not a first join, needs a catch-up. */
  everLive: boolean;
  /** Increments on every re-subscribe; the component refreshes when it changes. */
  catchUps: number;
  /** Change notifications received, for the caption and for tests. */
  events: number;
};

export type LiveEvent =
  | { type: 'subscribed' }
  | { type: 'error' }
  | { type: 'closed' }
  | { type: 'event' }
  | { type: 'unsupported' };

export const DEGRADED_AFTER_FAILURES = 3;

export function initialLiveState(): LiveState {
  return { status: 'connecting', failures: 0, everLive: false, catchUps: 0, events: 0 };
}

export function reduceLive(state: LiveState, event: LiveEvent): LiveState {
  switch (event.type) {
    case 'subscribed':
      return {
        ...state,
        status: 'live',
        failures: 0,
        everLive: true,
        catchUps: state.everLive ? state.catchUps + 1 : state.catchUps,
      };
    case 'error':
    case 'closed': {
      // A close before we ever joined is a failure to join; a close after is
      // a drop. Both are the same to the reader: not live, retrying.
      const failures = state.failures + 1;
      return {
        ...state,
        failures,
        status: state.status === 'polling' ? 'polling' : failures >= DEGRADED_AFTER_FAILURES ? 'degraded' : 'reconnecting',
      };
    }
    case 'event':
      return { ...state, events: state.events + 1 };
    case 'unsupported':
      return { ...state, status: 'polling', failures: 0 };
  }
}

/**
 * How often to refetch anyway, per status. Live keeps a slow safety net — a
 * single dropped event cannot leave a screen stale for more than two minutes
 * — and everything else polls at the rate the old `AutoRefresh` used, so a
 * degraded screen is exactly as fresh as every screen was before push existed.
 */
export function pollIntervalMs(status: LiveStatus): number {
  switch (status) {
    case 'live':
      return 120_000;
    case 'connecting':
    case 'reconnecting':
      return 20_000;
    case 'degraded':
    case 'polling':
      return 30_000;
  }
}

/** The words a person reads, and the tone the dot takes. Never colour alone. */
export function describeStatus(status: LiveStatus): { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral'; detail: string } {
  switch (status) {
    case 'live':
      return { label: 'Live', tone: 'success', detail: 'Updates arrive as they are saved.' };
    case 'connecting':
      return { label: 'Connecting', tone: 'neutral', detail: 'Opening the live channel.' };
    case 'reconnecting':
      return { label: 'Reconnecting', tone: 'warning', detail: 'The live channel dropped; retrying. Data refreshes on reconnect.' };
    case 'degraded':
      return { label: 'Degraded', tone: 'danger', detail: 'Live updates unavailable; refreshing every 30 seconds instead.' };
    case 'polling':
      return { label: 'Polling', tone: 'neutral', detail: 'Refreshing every 30 seconds.' };
  }
}
