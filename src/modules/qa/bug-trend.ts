/**
 * Bug trend — SCR-044, bucket F. Pure: defects in, weekly points out, so the
 * dashboard's chart and the test read the same arithmetic. Weeks start on
 * Monday and are keyed by their UTC calendar date.
 */

export type BugTrendPoint = { week: string; raised: number; settled: number; openAtEnd: number };

/** Week-start (Monday) key of an ISO timestamp's calendar day, in UTC. */
function weekStartOf(iso: string): string {
  const d = new Date(iso.slice(0, 10) + 'T00:00:00Z');
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

/** Pure: defects raised and settled per ISO week over the last `weeks`, and how many were open at each week's end. */
export function bugTrend(defects: readonly { createdAt: string; status: string; updatedAt: string }[], now: Date, weeks = 12): BugTrendPoint[] {
  const start = weekStartOf(now.toISOString());
  const keys: string[] = [];
  for (let i = weeks - 1; i >= 0; i -= 1) {
    const d = new Date(start + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - i * 7);
    keys.push(d.toISOString().slice(0, 10));
  }
  const raised = new Map(keys.map((k) => [k, 0]));
  const settled = new Map(keys.map((k) => [k, 0]));
  for (const d of defects) {
    const r = weekStartOf(d.createdAt);
    if (raised.has(r)) raised.set(r, (raised.get(r) ?? 0) + 1);
    if (d.status === 'verified' || d.status === 'wontfix') {
      const s = weekStartOf(d.updatedAt);
      if (settled.has(s)) settled.set(s, (settled.get(s) ?? 0) + 1);
    }
  }
  return keys.map((week) => {
    const end = new Date(week + 'T00:00:00Z');
    end.setUTCDate(end.getUTCDate() + 7);
    const endIso = end.toISOString();
    const openAtEnd = defects.filter((d) => d.createdAt < endIso && !((d.status === 'verified' || d.status === 'wontfix') && d.updatedAt < endIso)).length;
    return { week, raised: raised.get(week) ?? 0, settled: settled.get(week) ?? 0, openAtEnd };
  });
}

