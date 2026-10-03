/**
 * Where an audit entry's subject lives in the panel.
 *
 * Pure: the subject type and id (and, for rows that sit inside a project,
 * the project id the entry itself recorded in its snapshots) decide a route,
 * or none. A subject type the panel has no page for returns null — the row
 * then shows the type and the short id as plain text, never a dead link.
 */

export type AuditLink = { href: string; label: string };

type Snapshot = Record<string, unknown> | null | undefined;

function text(snapshot: Snapshot, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = snapshot?.[key];
    if (typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value)) return value;
  }
  return null;
}

const UUID = /^[0-9a-f-]{36}$/i;

export function auditRecordLink(subjectType: string | null, subjectId: string | null, before?: Snapshot, after?: Snapshot): AuditLink | null {
  if (!subjectType || !subjectId || !UUID.test(subjectId)) return null;
  const projectId = text(after, 'projectId', 'project_id') ?? text(before, 'projectId', 'project_id');

  switch (subjectType) {
    case 'approval_request':
      return { href: `/approvals/${subjectId}`, label: 'Open approval' };
    case 'lead':
      return { href: `/leads/${subjectId}`, label: 'Open lead' };
    case 'client_account':
      return { href: `/clients/${subjectId}`, label: 'Open client' };
    case 'project':
      return { href: `/projects/${subjectId}`, label: 'Open project' };
    case 'invoice':
      return { href: `/invoices/${subjectId}`, label: 'Open invoice' };
    case 'meeting':
      return { href: `/meetings/${subjectId}`, label: 'Open meeting' };
    case 'agent':
      return null;
    case 'membership':
    case 'user':
      return { href: '/security/users', label: 'Open users and roles' };
    case 'project_file':
    case 'project_folder':
      return projectId ? { href: `/projects/${projectId}/files`, label: 'Open project files' } : null;
    case 'scope_version':
    case 'scope_item':
    case 'requirement_version':
      return projectId ? { href: `/projects/${projectId}`, label: 'Open project' } : null;
    case 'contract':
      return { href: '/contracts', label: 'Open contracts' };
    case 'proposal':
      return { href: '/quotations', label: 'Open quotations' };
    case 'import_batch':
      return { href: `/import/${subjectId}`, label: 'Open import batch' };
    default:
      return null;
  }
}

/** The "reason" an entry recorded, from whichever key the writer used; null when none. */
export function auditReason(after: Snapshot, before?: Snapshot): string | null {
  for (const snap of [after, before]) {
    for (const key of ['reason', 'note', 'disabledReason']) {
      const value = snap?.[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return null;
}

/** Actions that are real privilege changes — who holds which role, who is suspended — not a department edit. */
export const PRIVILEGED_ACTIONS = ['membership.status_changed', 'membership.secondary_role_granted', 'membership.secondary_role_revoked', 'membership.role_changed'] as const;

export function isPrivilegedAction(action: string): boolean {
  return (PRIVILEGED_ACTIONS as readonly string[]).includes(action);
}
