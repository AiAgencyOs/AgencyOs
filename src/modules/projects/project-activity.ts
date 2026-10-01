/**
 * SCR-027 — the project activity timeline. One feed built from two honest
 * sources: the AUDIT TRAIL of the project and the records inside it (status
 * changes, file links, folders, scope, deliverables, members... through
 * `projects.project_activity`) and the domain events each table already
 * timestamps (a task completed, a milestone met, a change request raised or
 * decided). Both are merged, newest first, and every row links to its record.
 */
export type ActivityRow = {
  key: string;
  at: string;
  /** Where the row came from: the audit trail, or a domain table's own timestamp. */
  source: 'audit' | 'record';
  action: string;
  label: string;
  actor: string | null;
  subjectType: string;
  subjectId: string | null;
};

/** `task.status_changed` → "Task status changed". */
export function actionLabel(action: string): string {
  const words = action.replace(/[._]/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The page a record lives on, or null when it has none of its own. */
export function recordHref(projectId: string, subjectType: string, subjectId: string | null): string | null {
  const base = `/projects/${projectId}`;
  switch (subjectType) {
    case 'project':
    case 'project_note':
    case 'project_member':
    case 'handover':
      return subjectType === 'project_member' ? `${base}/team` : base;
    case 'task':
      return subjectId ? `${base}/development/tasks/${subjectId}` : `${base}/board`;
    case 'milestone':
      return subjectId ? `${base}/milestones?milestone=${subjectId}` : `${base}/milestones`;
    case 'project_file':
    case 'project_folder':
      return `${base}/files`;
    case 'scope_version':
    case 'scope_item':
    case 'change_request':
      return `${base}/scope`;
    case 'defect':
      return `${base}/qa`;
    case 'deliverable':
      return base;
    case 'sprint':
      return `${base}/board`;
    case 'theme_option':
    case 'phase_three':
      return `${base}/design`;
    case 'meeting':
      return subjectId ? `/meetings/${subjectId}` : '/meetings';
    case 'announcement':
      return '/communication#announcements';
    case 'outbound_email':
      return '/communication#email';
    default:
      return null;
  }
}

/** Newest first; an audit row and a record event about the same subject at the same second are one event, not two. */
export function mergeActivity(rows: readonly ActivityRow[]): ActivityRow[] {
  const sorted = [...rows].sort((a, b) => b.at.localeCompare(a.at) || a.key.localeCompare(b.key));
  const seen = new Set<string>();
  return sorted.filter((r) => {
    if (r.source === 'audit') return true;
    // A completed task leaves both a `task.updated` audit row and its completed_at; keep the audit row when both exist.
    const twin = sorted.some((o) => o.source === 'audit' && o.subjectId !== null && o.subjectId === r.subjectId && Math.abs(Date.parse(o.at) - Date.parse(r.at)) < 2000);
    const k = `${r.subjectType}:${r.subjectId}:${r.at}`;
    if (twin || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** The record kinds a person can narrow the timeline to, in the words the page shows. */
export const ACTIVITY_TYPE_LABEL: Record<string, string> = {
  task: 'Tasks',
  milestone: 'Milestones',
  project: 'Project',
  project_file: 'Files',
  project_folder: 'Files',
  scope_version: 'Scope',
  scope_item: 'Scope',
  change_request: 'Change requests',
  defect: 'Defects',
  deliverable: 'Deliverables',
  project_member: 'Team',
  theme_option: 'Design',
  phase_three: 'Design',
  meeting: 'Meetings',
};

/** One chip per label that actually occurs in the feed, most frequent first; kinds with no word of their own fall under "Other". */
export function activityTypeChips(rows: readonly ActivityRow[]): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const label = ACTIVITY_TYPE_LABEL[r.subjectType] ?? 'Other';
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/**
 * Narrow the timeline: `q` matches the action, the record's label or the actor
 * (case-insensitive); `type` is one of the chip labels. Pure, so the rule is
 * testable without the page.
 */
export function filterActivity(rows: readonly ActivityRow[], filter: { q?: string; type?: string }): ActivityRow[] {
  const needle = (filter.q ?? '').trim().toLowerCase();
  return rows.filter((r) => {
    if (filter.type && (ACTIVITY_TYPE_LABEL[r.subjectType] ?? 'Other') !== filter.type) return false;
    if (!needle) return true;
    return `${actionLabel(r.action)} ${r.label} ${r.actor ?? ''}`.toLowerCase().includes(needle);
  });
}
