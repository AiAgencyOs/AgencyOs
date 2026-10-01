import type { Capability } from '@/lib/authz/permissions';
import type { SearchGroup } from '@/lib/admin/global-search-page';

/**
 * Every kind of record global search covers, and for each: where it lives,
 * which columns may be read for search by meaning, what words are made of
 * them, and how a hit is shown and linked. One list, used twice — by the
 * indexing job (under the service role, scoped by organisation by hand) to
 * decide what to embed, and by the search (under the caller's own row-level
 * security) to turn ids back into rows the caller may open.
 *
 * Columns are listed, never `select *`: a secret column cannot be embedded
 * because it is not named here (client tax identifiers and billing addresses,
 * file URLs and storage paths, vault values are all absent on purpose).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;

export type SourceSpec = {
  group: SearchGroup;
  /** The capability that lets a role search the type at all (mirrors the keyword search). */
  capability: Capability;
  schema: string;
  table: string;
  /** Columns to read, PostgREST syntax; always includes `id` and `created_at` where the table has one. */
  columns: string;
  /** Rows carry `deleted_at`: a deleted row is neither embedded nor returned. */
  softDelete?: boolean;
  /** Extra restriction for a huge append-only table, as an ISO-date cutoff in days. */
  windowDays?: number;
  /** Words to embed: label → value. */
  fields: (row: Row) => Record<string, string | null | undefined>;
  label: (row: Row) => string;
  detail: (row: Row) => string | null;
  href: (row: Row) => string;
  /** The row's own status word and owner, for the page's filters. */
  status?: (row: Row) => string | null;
  owner?: (row: Row) => string | null;
  createdAt: (row: Row) => string | null;
};

const join = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(' · ') || null;
const clip = (s: string | null | undefined, n: number) => (s ? s.slice(0, n) : null);

export const SEMANTIC_SOURCES: readonly SourceSpec[] = [
  {
    group: 'Lead', capability: 'lead.read', schema: 'crm', table: 'leads', softDelete: true,
    columns: 'id, title, summary, source, status, service, assigned_to, created_at, deleted_at',
    fields: (r) => ({ title: r.title, summary: r.summary, service: r.service, source: r.source, status: r.status }),
    label: (r) => r.title, detail: (r) => `${r.status} · via ${r.source}`, href: (r) => `/leads/${r.id}`,
    status: (r) => r.status, owner: (r) => r.assigned_to, createdAt: (r) => r.created_at,
  },
  {
    group: 'Client', capability: 'project.read', schema: 'core', table: 'client_accounts',
    columns: 'id, name, legal_name, status, owner_id, created_at',
    fields: (r) => ({ name: r.name, 'legal name': r.legal_name, status: r.status }),
    label: (r) => r.name, detail: (r) => r.status, href: (r) => `/clients/${r.id}`,
    status: (r) => r.status, owner: (r) => r.owner_id, createdAt: (r) => r.created_at,
  },
  {
    group: 'Project', capability: 'project.read', schema: 'projects', table: 'projects', softDelete: true,
    columns: 'id, name, code, description, status, project_type, delivery_lead_id, created_at, deleted_at',
    fields: (r) => ({ name: r.name, code: r.code, description: r.description, type: r.project_type, status: r.status }),
    label: (r) => r.name, detail: (r) => join(r.code, r.status), href: (r) => `/projects/${r.id}`,
    status: (r) => r.status, owner: (r) => r.delivery_lead_id, createdAt: (r) => r.created_at,
  },
  {
    group: 'Invoice', capability: 'invoice.read', schema: 'finance', table: 'invoices',
    columns: 'id, number, status, kind, notes, created_at',
    fields: (r) => ({ number: r.number, kind: r.kind, notes: r.notes, status: r.status }),
    label: (r) => r.number, detail: (r) => r.status, href: (r) => `/invoices/${r.id}`,
    status: (r) => r.status, createdAt: (r) => r.created_at,
  },
  {
    group: 'Quotation', capability: 'lead.read', schema: 'sales', table: 'proposals',
    columns: 'id, title, version, body, status, plan_label, created_by, opportunity_id, created_at',
    fields: (r) => ({ title: r.title, plan: r.plan_label, body: r.body, status: r.status }),
    label: (r) => `${r.title} (v${r.version})`, detail: (r) => r.status, href: () => '/quotations',
    status: (r) => r.status, owner: (r) => r.created_by, createdAt: (r) => r.created_at,
  },
  {
    group: 'Meeting', capability: 'lead.read', schema: 'crm', table: 'meetings',
    columns: 'id, purpose, status, outcome, requested_mode, created_at, leads(title)',
    fields: (r) => ({ lead: r.leads?.title, purpose: r.purpose, outcome: r.outcome, mode: r.requested_mode?.replace(/_/g, ' '), status: r.status }),
    label: (r) => r.leads?.title ?? r.purpose ?? 'Meeting',
    detail: (r) => join(r.status, r.requested_mode?.replace(/_/g, ' '), r.purpose), href: (r) => `/meetings/${r.id}`,
    status: (r) => r.status, createdAt: (r) => r.created_at,
  },
  {
    group: 'Task', capability: 'project.read', schema: 'projects', table: 'tasks',
    columns: 'id, title, description, status, priority, blocked_reason, project_id, assignee_id, created_at',
    fields: (r) => ({ title: r.title, description: r.description, blocked: r.blocked_reason, priority: r.priority, status: r.status }),
    label: (r) => r.title, detail: (r) => `${r.status} · ${r.priority}`, href: (r) => `/projects/${r.project_id}/development/tasks/${r.id}`,
    status: (r) => r.status, owner: (r) => r.assignee_id, createdAt: (r) => r.created_at,
  },
  {
    group: 'Requirement', capability: 'project.read', schema: 'projects', table: 'scope_items',
    columns: 'id, title, detail, acceptance_criteria, inclusion, scope_version_id, created_at',
    fields: (r) => ({ title: r.title, detail: r.detail, 'acceptance criteria': r.acceptance_criteria, inclusion: r.inclusion }),
    label: (r) => r.title, detail: (r) => join(r.inclusion, clip(r.detail, 80)), href: () => '/projects',
    status: (r) => r.inclusion, createdAt: (r) => r.created_at,
  },
  {
    group: 'File', capability: 'project.read', schema: 'projects', table: 'project_files', softDelete: true,
    columns: 'id, title, description, category, folder, project_id, created_at, deleted_at',
    fields: (r) => ({ title: r.title, description: r.description, category: r.category, folder: r.folder }),
    label: (r) => r.title, detail: (r) => join(r.category, r.folder), href: (r) => `/projects/${r.project_id}/files`,
    status: (r) => r.category, createdAt: (r) => r.created_at,
  },
  {
    group: 'Audit', capability: 'audit.read', schema: 'audit', table: 'audit_log', windowDays: 90,
    columns: 'id, action, subject_type, actor_type, created_at',
    fields: (r) => ({ action: r.action, subject: r.subject_type, actor: r.actor_type }),
    label: (r) => r.action, detail: (r) => join(r.subject_type, r.actor_type), href: (r) => `/audit?q=${encodeURIComponent(r.action)}`,
    createdAt: (r) => r.created_at,
  },
];

/** Agents are defined in code (decision #12): they are embedded from the registry, not a table. */
export type AgentSource = { key: string; displayName: string; layer: string; purpose: string };

export const AGENT_CAPABILITY: Capability = 'audit.read';

export function agentFields(a: AgentSource): Record<string, string> {
  return { name: a.displayName, key: a.key, layer: a.layer, purpose: a.purpose };
}

export function agentResult(a: AgentSource) {
  return { id: a.key, label: a.displayName, group: 'Agent' as const, href: `/agents/${a.key}`, createdAt: null, detail: `${a.layer} · ${a.purpose.slice(0, 90)}` };
}

export function specFor(group: SearchGroup): SourceSpec | undefined {
  return SEMANTIC_SOURCES.find((s) => s.group === group);
}

/** Every group search by meaning covers, in the order the page lists them. */
export const SEMANTIC_GROUPS: readonly SearchGroup[] = ['Lead', 'Client', 'Project', 'Invoice', 'Quotation', 'Meeting', 'Task', 'Requirement', 'File', 'Agent', 'Audit'];
