/**
 * Two cards of the project report — pure helpers (no I/O).
 *
 * Recent Activity is a project timeline composed from events each table
 * already timestamps (a task completed, a milestone met, a defect raised, a
 * file added) — it is not the audit log and says so. Resource Usage is hours
 * logged per person from the time entries, drawn as bars relative to the
 * busiest person; nothing is stored or estimated.
 */

export type ActivityEvent = { key: string; at: string; who: string | null; verb: string; subject: string; tone: 'success' | 'info' | 'warning' | 'brand'; /** The record the event is about (SCR-026 "open underlying record"). */ href?: string };

export function composeRecentActivity(
  input: {
    tasks: readonly { id: string; title: string; completedAt: string | null; assigneeName?: string | null }[];
    milestones: readonly { id: string; name: string; met_at: string | null }[];
    defects: readonly { id: string; title: string; created_at: string }[];
    files: readonly { id: string; title: string; createdAt: string; uploadedByName: string | null }[];
  },
  limit = 5,
  projectId?: string,
): ActivityEvent[] {
  const at = (path: string) => (projectId ? { href: `/projects/${projectId}${path}` } : {});
  const events: ActivityEvent[] = [
    ...input.tasks.flatMap((t) => (t.completedAt ? [{ key: `t-${t.id}`, at: t.completedAt, who: t.assigneeName ?? null, verb: 'completed', subject: t.title, tone: 'success' as const, ...at(`/development/tasks/${t.id}`) }] : [])),
    ...input.milestones.flatMap((m) => (m.met_at ? [{ key: `m-${m.id}`, at: m.met_at, who: null, verb: 'Milestone met:', subject: m.name, tone: 'brand' as const, ...at(`/milestones?milestone=${m.id}`) }] : [])),
    ...input.defects.map((d) => ({ key: `d-${d.id}`, at: d.created_at, who: null, verb: 'Defect raised:', subject: d.title, tone: 'warning' as const, ...at('/qa') })),
    ...input.files.map((f) => ({ key: `f-${f.id}`, at: f.createdAt, who: f.uploadedByName, verb: 'uploaded', subject: f.title, tone: 'info' as const, ...at('/files') })),
  ];
  return events.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

export type ResourceBar = { name: string; hours: number; percentOfBusiest: number };

/** Hours per person, busiest first; the busiest is 100% and the rest are relative to it. */
export function resourceBars(people: readonly { personName: string; hours: number }[], limit = 5): ResourceBar[] {
  const sorted = [...people].filter((p) => p.hours > 0).sort((a, b) => b.hours - a.hours).slice(0, limit);
  const max = sorted[0]?.hours ?? 0;
  return sorted.map((p) => ({ name: p.personName, hours: p.hours, percentOfBusiest: max > 0 ? Math.round((p.hours / max) * 100) : 0 }));
}
