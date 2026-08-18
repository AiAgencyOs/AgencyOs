/**
 * The Overview command-center's judgement, pure so it can be tested without a
 * database. The whole point of this file is the distinction the spec insists on:
 * a signal that could not be READ is `unavailable` (shown as DATA UNAVAILABLE),
 * never coalesced into a reassuring zero. `overallStatus` therefore returns
 * `unknown` — not `operational` — when the core health read failed. It never
 * says "all good" on missing evidence.
 */

import { severityOf, type BacklogRow } from '@/lib/observability/backlog';

/** A value that was read, or a read that failed. `ok:false` is DATA UNAVAILABLE. */
export type Avail<T> = { ok: true; value: T } | { ok: false };

export type SystemLevel = 'operational' | 'degraded' | 'failing' | 'unknown';

export function isAvailable<T>(a: Avail<T>): a is { ok: true; value: T } {
  return a.ok;
}

/** The reaper's staleness window: no tick in 15 minutes means the cron stopped. */
export function cronIsStale(ageSeconds: number | null): boolean {
  return ageSeconds === null || ageSeconds > 15 * 60;
}

export function overallStatus(input: {
  backlog: Avail<BacklogRow>;
  cronAgeSeconds: number | null;
  failedDeliveries: Avail<number>;
}): { level: SystemLevel; reason: string } {
  const { backlog, cronAgeSeconds, failedDeliveries } = input;

  // Core health is the backlog. If it could not be read, the honest answer is
  // "unknown" — asserting "operational" here would be the exact false comfort
  // the spec forbids.
  if (!backlog.ok) return { level: 'unknown', reason: 'core health could not be read' };

  const severity = severityOf(backlog.value);
  const failed = failedDeliveries.ok ? failedDeliveries.value : 0;

  if (severity === 'failing') return { level: 'failing', reason: 'work has been lost and nothing will retry it' };
  if (failed > 0) return { level: 'failing', reason: `${failed} client ${failed === 1 ? 'message' : 'messages'} failed to deliver` };
  if (severity === 'degraded') return { level: 'degraded', reason: 'work is late but still moving' };
  if (cronIsStale(cronAgeSeconds)) return { level: 'degraded', reason: 'no recent scheduler tick — it may be stopped' };
  return { level: 'operational', reason: 'core signals nominal' };
}

/** Human label + tone for a level; the page maps tone to colour. */
export function levelLabel(level: SystemLevel): { text: string; tone: 'good' | 'warn' | 'bad' | 'muted' } {
  switch (level) {
    case 'operational':
      return { text: 'All systems operational', tone: 'good' };
    case 'degraded':
      return { text: 'Degraded — attention needed', tone: 'warn' };
    case 'failing':
      return { text: 'Failing — action required', tone: 'bad' };
    case 'unknown':
      return { text: 'Health partly unavailable', tone: 'muted' };
  }
}
