/**
 * The project Requirements tab — pure helpers (no I/O).
 *
 * A requirement is a `projects.scope_items` row of the project's active
 * scope version (or of an open draft that has not been frozen yet). Nothing
 * on this tab is made up: the code is the item's place in the list, the
 * status is the state of the version it sits on, the module is the feature it
 * is planned under, and the delivery state is that feature's own status.
 */

import type { RequirementPriority } from './requirement-plan-schema';

export type ScopeInclusion = 'included' | 'excluded' | 'optional';
export type RequirementStatus = 'approved' | 'in_review' | 'optional' | 'excluded';
export type FeatureStatus = 'not_started' | 'in_progress' | 'blocked' | 'done';

export const STATUS_LABEL: Record<RequirementStatus, string> = { approved: 'Approved', in_review: 'In Review', optional: 'Optional', excluded: 'Excluded' };
export const DELIVERY_LABEL: Record<FeatureStatus, string> = { not_started: 'Not started', in_progress: 'In progress', blocked: 'Blocked', done: 'Done' };

export type RequirementRow = {
  id: string;
  /** REQ-001 … — the item's place in the list (the active version's items first, then an open draft's). */
  code: string;
  title: string;
  detail: string | null;
  criteria: string[];
  inclusion: ScopeInclusion;
  versionStatus: 'active' | 'draft';
  version: number;
  status: RequirementStatus;
  module: string | null;
  delivery: FeatureStatus | null;
  createdAt: string;
  screens: { id: string; name: string }[];
  testCases: number;
  deliverables: { name: string; status: string }[];
  comments: number;
  /** Owner decisions 5 and 6 (20261005100300): kept beside the frozen scope row, so editable after the freeze. */
  priority: RequirementPriority | null;
  assignee: { userId: string; name: string } | null;
  files: { fileId: string; title: string; url: string | null }[];
  /** SCR-029: the feature the item is planned under, and the development tasks built under it. */
  featureId: string | null;
  tasks: { id: string; title: string; status: string }[];
  /** SCR-029: the quotations priced from the requirement version this scope descends from. */
  quotations: { id: string; title: string; version: number; status: string }[];
  /** SCR-028/029: questions asked of this requirement (migration 20261006400000). */
  clarifications: RequirementClarification[];
};

export type RequirementClarification = {
  id: string;
  question: string;
  impact: string;
  status: 'open' | 'answered';
  raisedAt: string;
  raisedByName: string | null;
  answer: string | null;
  answeredAt: string | null;
};

export function requirementCode(index: number): string {
  return `REQ-${String(index + 1).padStart(3, '0')}`;
}

/** One line per criterion: bullets, dashes and "1." numbering are stripped; blank lines dropped. */
export function splitCriteria(text: string | null): string[] {
  return (text ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter((line) => line.length > 0);
}

export function statusOf(versionStatus: 'active' | 'draft', inclusion: ScopeInclusion): RequirementStatus {
  if (versionStatus === 'draft') return 'in_review';
  if (inclusion === 'excluded') return 'excluded';
  if (inclusion === 'optional') return 'optional';
  return 'approved';
}

export type RequirementKpis = { total: number; approved: number; inReview: number; changesRequested: number; notStarted: number };

/** Not started = an approved requirement whose feature has not begun, or that no feature carries yet. */
export function requirementKpis(rows: readonly RequirementRow[], openChangeRequests: number): RequirementKpis {
  return {
    total: rows.length,
    approved: rows.filter((r) => r.status === 'approved').length,
    inReview: rows.filter((r) => r.status === 'in_review').length,
    changesRequested: openChangeRequests,
    notStarted: rows.filter((r) => r.status === 'approved' && (r.delivery === null || r.delivery === 'not_started')).length,
  };
}

export const UNASSIGNED_MODULE = 'No module yet';

export function groupByModule(rows: readonly RequirementRow[]): { module: string; rows: RequirementRow[] }[] {
  const groups = new Map<string, RequirementRow[]>();
  for (const r of rows) {
    const key = r.module ?? UNASSIGNED_MODULE;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === UNASSIGNED_MODULE ? 1 : b === UNASSIGNED_MODULE ? -1 : a.localeCompare(b)))
    .map(([module, list]) => ({ module, rows: list }));
}

export type RequirementFilter = 'all' | RequirementStatus | 'not_started';

export function filterRequirements(rows: readonly RequirementRow[], filter: RequirementFilter, q: string): RequirementRow[] {
  const needle = q.trim().toLowerCase();
  return rows.filter((r) => {
    if (filter === 'not_started' ? !(r.status === 'approved' && (r.delivery === null || r.delivery === 'not_started')) : filter !== 'all' && r.status !== filter) return false;
    return needle === '' || `${r.code} ${r.title} ${r.module ?? ''}`.toLowerCase().includes(needle);
  });
}

/** Number the items of the active version, then those of an open draft. */
export function numberRows<T extends { versionStatus: 'active' | 'draft'; position: number }>(items: readonly T[]): (T & { code: string })[] {
  const ordered = [...items].sort((a, b) => (a.versionStatus === b.versionStatus ? a.position - b.position : a.versionStatus === 'active' ? -1 : 1));
  return ordered.map((item, i) => ({ ...item, code: requirementCode(i) }));
}
