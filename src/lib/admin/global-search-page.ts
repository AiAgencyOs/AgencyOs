import { ilikeAny } from '@/lib/db/search';
import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * The `/search` results page's reader — SCR-002.
 *
 * `global-search.ts` is the palette's five-per-entity quick match and a
 * server action; this is the page behind its "see all results" link: the
 * same entities under the same capabilities and the same RLS, with a
 * larger bound per entity, the row's creation instant (so a date filter is
 * a filter over something the row actually carries), and an entity filter
 * so the reader can ask for only leads or only invoices.
 *
 * A failed read refuses (`unreadable`) rather than rendering an empty
 * list: "no results" and "the database did not answer" are different
 * sentences.
 */

export const SEARCH_GROUPS = ['Lead', 'Client', 'Project', 'Invoice', 'Quotation', 'Meeting', 'Task', 'Requirement', 'File', 'Agent', 'Audit'] as const;
export type SearchGroup = (typeof SEARCH_GROUPS)[number];

/** The plural the chips and section headings use. */
export function groupLabel(group: SearchGroup): string {
  return group === 'Audit' ? 'Audit events' : `${group}s`;
}

export const SEARCH_SINCE = [
  { key: '7', label: 'Last 7 days', days: 7 },
  { key: '30', label: 'Last 30 days', days: 30 },
  { key: '90', label: 'Last 90 days', days: 90 },
] as const;

export type SearchPageResult = {
  id: string;
  label: string;
  group: SearchGroup;
  href: string;
  /** The row's own `created_at` — what the date filter is applied to. Null for a record defined in code (an agent). */
  createdAt: string | null;
  /** A second line where the row has one worth showing. */
  detail: string | null;
};

export { CONDITION_FIELDS, CONDITION_OPS, conditionToParam, parseConditions, type SearchCondition } from './search-conditions';
import type { SearchCondition } from './search-conditions';

export type SearchPageFilter = {
  q: string;
  group?: SearchGroup;
  sinceDays?: number;
  /** SCR-002 advanced filters: the row's own status, and the person it belongs to (assignee, delivery lead, relationship owner). */
  status?: string;
  ownerId?: string;
  /** The stacked builder conditions, on top of the two single filters above. */
  conditions?: SearchCondition[];
  /** The agent registry (defined in code, decision #12), passed by the page: lib/ may not import modules/. */
  agents?: readonly { key: string; displayName: string; layer: string; purpose: string }[];
};

/** Which column "owner" means for a group; a group without one ignores the filter rather than matching nothing. */
export const OWNER_COLUMN: Partial<Record<SearchGroup, string>> = {
  Lead: 'assigned_to',
  Client: 'owner_id',
  Project: 'delivery_lead_id',
  Task: 'assignee_id',
  Quotation: 'created_by',
};

export const MIN_SEARCH_LENGTH = 2;
const RESULTS_PER_ENTITY = 25;

/** Applies the builder's conditions to a PostgREST query over `ownerColumn`/`created_at`/`status`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyConditions<Q extends { eq: any; neq: any; gte: any; lte: any }>(query: Q, conditions: SearchCondition[], ownerColumn: string | undefined, statusColumn: string | null = 'status'): Q {
  let next = query;
  for (const c of conditions) {
    if (c.field === 'status' && statusColumn) next = c.op === 'not' ? next.neq(statusColumn, c.value) : next.eq(statusColumn, c.value);
    else if (c.field === 'owner' && ownerColumn) next = c.op === 'not' ? next.neq(ownerColumn, c.value) : next.eq(ownerColumn, c.value);
    else if (c.field === 'created') next = c.op === 'before' ? next.lte('created_at', `${c.value}T23:59:59.999Z`) : next.gte('created_at', `${c.value}T00:00:00Z`);
  }
  return next;
}

export function isSearchGroup(value: string | undefined): value is SearchGroup {
  return (SEARCH_GROUPS as readonly string[]).includes(value ?? '');
}

export async function searchRecords(filter: SearchPageFilter): Promise<SearchPageResult[]> {
  const trimmed = filter.q.trim();
  if (trimmed.length < MIN_SEARCH_LENGTH) return [];

  const context = await requireInternal();
  const supabase = await createClient();
  const like = `%${trimmed.replace(/[%_]/g, (c) => `\\${c}`)}%`;
  const since = filter.sinceDays ? new Date(Date.now() - filter.sinceDays * 24 * 60 * 60 * 1000).toISOString() : null;
  const status = filter.status?.trim() || null;
  const ownerId = filter.ownerId && /^[0-9a-f-]{36}$/.test(filter.ownerId) ? filter.ownerId : null;
  const wants = (group: SearchGroup) => filter.group === undefined || filter.group === group;
  // The owner filter applies where the group has an owner column and is
  // ignored otherwise; the status filter applies everywhere (every group
  // has a status column of its own vocabulary).
  const conditions = filter.conditions ?? [];
  const wantsOwner = ownerId !== null || conditions.some((c) => c.field === 'owner');
  const ownerOk = (group: SearchGroup) => !wantsOwner || OWNER_COLUMN[group] !== undefined;

  const searches: Promise<SearchPageResult[]>[] = [];

  if (wants('Lead') && ownerOk('Lead') && can(context, 'lead.read')) {
    searches.push(
      (async () => {
        let query = supabase
          .schema('crm')
          .from('leads')
          .select('id, title, status, source, created_at')
          .ilike('title', like)
          .is('deleted_at', null)
          .order('created_at', { ascending: false })
          .limit(RESULTS_PER_ENTITY);
        if (since) query = query.gte('created_at', since);
        if (status) query = query.eq('status', status);
        if (ownerId) query = query.eq('assigned_to', ownerId);
        query = applyConditions(query, conditions, 'assigned_to');
        const { data, error } = await query;
        if (error) unreadable('searchRecords.leads', error);
        return (data ?? []).map((l) => ({
          id: l.id,
          label: l.title,
          group: 'Lead' as const,
          href: `/leads/${l.id}`,
          createdAt: l.created_at,
          detail: `${l.status} · via ${l.source}`,
        }));
      })(),
    );
  }

  if (wants('Client') && ownerOk('Client') && can(context, 'project.read')) {
    searches.push(
      (async () => {
        let query = supabase
          .schema('core')
          .from('client_accounts')
          .select('id, name, status, created_at')
          .or(ilikeAny(['name', 'client_code'], trimmed))
          .order('created_at', { ascending: false })
          .limit(RESULTS_PER_ENTITY);
        if (since) query = query.gte('created_at', since);
        if (status) query = query.eq('status', status);
        if (ownerId) query = query.eq('owner_id', ownerId);
        query = applyConditions(query, conditions, 'owner_id');
        const { data, error } = await query;
        if (error) unreadable('searchRecords.clients', error);
        return (data ?? []).map((c) => ({
          id: c.id,
          label: c.name,
          group: 'Client' as const,
          href: `/clients/${c.id}`,
          createdAt: c.created_at,
          detail: c.status,
        }));
      })(),
    );
  }

  if (wants('Project') && ownerOk('Project') && can(context, 'project.read')) {
    searches.push(
      (async () => {
        let query = supabase
          .schema('projects')
          .from('projects')
          .select('id, name, code, status, created_at')
          .or(ilikeAny(['name', 'project_code'], trimmed))
          .is('deleted_at', null)
          .order('created_at', { ascending: false })
          .limit(RESULTS_PER_ENTITY);
        if (since) query = query.gte('created_at', since);
        if (status) query = query.eq('status', status);
        if (ownerId) query = query.eq('delivery_lead_id', ownerId);
        query = applyConditions(query, conditions, 'delivery_lead_id');
        const { data, error } = await query;
        if (error) unreadable('searchRecords.projects', error);
        return (data ?? []).map((p) => ({
          id: p.id,
          label: p.name,
          group: 'Project' as const,
          href: `/projects/${p.id}`,
          createdAt: p.created_at,
          detail: [p.code, p.status].filter(Boolean).join(' · ') || null,
        }));
      })(),
    );
  }

  if (wants('Invoice') && ownerOk('Invoice') && can(context, 'invoice.read')) {
    searches.push(
      (async () => {
        let query = supabase
          .schema('finance')
          .from('invoices')
          .select('id, number, status, created_at')
          .ilike('number', like)
          .order('created_at', { ascending: false })
          .limit(RESULTS_PER_ENTITY);
        if (since) query = query.gte('created_at', since);
        if (status) query = query.eq('status', status);
        query = applyConditions(query, conditions, undefined);
        const { data, error } = await query;
        if (error) unreadable('searchRecords.invoices', error);
        return (data ?? []).map((i) => ({
          id: i.id,
          label: i.number,
          group: 'Invoice' as const,
          href: `/invoices/${i.id}`,
          createdAt: i.created_at,
          detail: i.status,
        }));
      })(),
    );
  }

  // SCR-002 (bucket F): quotations, meetings and tasks join the four — the
  // same three the palette matches, under the same capabilities.
  if (wants('Quotation') && ownerOk('Quotation') && can(context, 'lead.read')) {
    searches.push(
      (async () => {
        let query = supabase
          .schema('sales')
          .from('proposals')
          .select('id, title, version, status, created_at, opportunity_id')
          .ilike('title', like)
          .order('created_at', { ascending: false })
          .limit(RESULTS_PER_ENTITY);
        if (since) query = query.gte('created_at', since);
        if (status) query = query.eq('status', status);
        if (ownerId) query = query.eq('created_by', ownerId);
        query = applyConditions(query, conditions, 'created_by');
        const { data, error } = await query;
        if (error) unreadable('searchRecords.quotations', error);
        const rows = data ?? [];
        const oppIds = [...new Set(rows.map((r) => r.opportunity_id))];
        const { data: opps } =
          oppIds.length > 0
            ? await supabase.schema('sales').from('opportunities').select('id, lead_id').in('id', oppIds)
            : { data: [] as { id: string; lead_id: string | null }[] };
        const leadByOpp = new Map((opps ?? []).map((o) => [o.id, o.lead_id]));
        return rows.map((p) => {
          const leadId = leadByOpp.get(p.opportunity_id) ?? null;
          return {
            id: p.id,
            label: `${p.title} (v${p.version})`,
            group: 'Quotation' as const,
            href: leadId ? `/leads/${leadId}#quotations` : '/quotations',
            createdAt: p.created_at,
            detail: p.status,
          };
        });
      })(),
    );
  }

  if (wants('Meeting') && ownerOk('Meeting') && can(context, 'lead.read')) {
    searches.push(
      (async () => {
        let query = supabase
          .schema('crm')
          .from('meetings')
          .select('id, purpose, status, requested_mode, created_at, leads!inner(title)')
          .ilike('leads.title', like)
          .order('created_at', { ascending: false })
          .limit(RESULTS_PER_ENTITY);
        if (since) query = query.gte('created_at', since);
        if (status) query = query.eq('status', status);
        query = applyConditions(query, conditions, undefined);
        const { data, error } = await query;
        if (error) unreadable('searchRecords.meetings', error);
        return (data ?? []).map((m) => ({
          id: m.id,
          label: (m.leads as unknown as { title: string } | null)?.title ?? m.purpose ?? 'Meeting',
          group: 'Meeting' as const,
          href: `/meetings/${m.id}`,
          createdAt: m.created_at,
          detail: [m.status, m.requested_mode.replace(/_/g, ' '), m.purpose].filter(Boolean).join(' · ') || null,
        }));
      })(),
    );
  }

  if (wants('Task') && ownerOk('Task') && can(context, 'project.read')) {
    searches.push(
      (async () => {
        let query = supabase
          .schema('projects')
          .from('tasks')
          .select('id, title, status, priority, project_id, created_at')
          .ilike('title', like)
          .is('archived_at', null)
          .order('created_at', { ascending: false })
          .limit(RESULTS_PER_ENTITY);
        if (since) query = query.gte('created_at', since);
        if (status) query = query.eq('status', status);
        if (ownerId) query = query.eq('assignee_id', ownerId);
        query = applyConditions(query, conditions, 'assignee_id');
        const { data, error } = await query;
        if (error) unreadable('searchRecords.tasks', error);
        return (data ?? []).map((t) => ({
          id: t.id,
          label: t.title,
          group: 'Task' as const,
          href: `/projects/${t.project_id}/development/tasks/${t.id}`,
          createdAt: t.created_at,
          detail: `${t.status} · ${t.priority}`,
        }));
      })(),
    );
  }

  if (wants('Requirement') && ownerOk('Requirement') && can(context, 'project.read')) {
    searches.push(
      (async () => {
        let query = supabase
          .schema('projects')
          .from('scope_items')
          .select('id, title, detail, inclusion, created_at, scope_version_id')
          .ilike('title', like)
          .order('created_at', { ascending: false })
          .limit(RESULTS_PER_ENTITY);
        if (since) query = query.gte('created_at', since);
        query = applyConditions(query, conditions, undefined, 'inclusion');
        if (status) query = query.eq('inclusion', status);
        const { data, error } = await query;
        if (error) unreadable('searchRecords.requirements', error);
        const rows = data ?? [];
        const versionIds = [...new Set(rows.map((r) => r.scope_version_id))];
        const { data: versions, error: versionError } =
          versionIds.length > 0
            ? await supabase.schema('projects').from('scope_versions').select('id, project_id, version').in('id', versionIds)
            : { data: [] as { id: string; project_id: string; version: number }[], error: null };
        if (versionError) unreadable('searchRecords.requirementVersions', versionError);
        const versionById = new Map((versions ?? []).map((v) => [v.id, v]));
        return rows.flatMap((r) => {
          const v = versionById.get(r.scope_version_id);
          if (!v) return [];
          return [{ id: r.id, label: r.title, group: 'Requirement' as const, href: `/projects/${v.project_id}/requirements`, createdAt: r.created_at, detail: [r.inclusion, `scope v${v.version}`, r.detail?.slice(0, 80)].filter(Boolean).join(' · ') || null }];
        });
      })(),
    );
  }

  if (wants('File') && ownerOk('File') && can(context, 'project.read')) {
    searches.push(
      (async () => {
        let query = supabase
          .schema('projects')
          .from('project_files')
          .select('id, title, category, folder, project_id, created_at')
          .ilike('title', like)
          .is('deleted_at', null)
          .order('created_at', { ascending: false })
          .limit(RESULTS_PER_ENTITY);
        if (since) query = query.gte('created_at', since);
        query = applyConditions(query, conditions, undefined, 'category');
        if (status) query = query.eq('category', status);
        const { data, error } = await query;
        if (error) unreadable('searchRecords.files', error);
        return (data ?? []).map((f) => ({ id: f.id, label: f.title, group: 'File' as const, href: `/projects/${f.project_id}/files`, createdAt: f.created_at, detail: [f.category, f.folder].filter(Boolean).join(' · ') || null }));
      })(),
    );
  }

  // Agents are defined in code (owner decision #12): matched against the
  // registry, not a table, so they have no creation date and the date and
  // owner filters do not apply to them.
  if (wants('Agent') && !wantsOwner && !since && conditions.every((c) => c.field === 'status') && !status && can(context, 'audit.read')) {
    const needle = trimmed.toLowerCase();
    searches.push(
      Promise.resolve(
        (filter.agents ?? []).filter((a) => a.key.toLowerCase().includes(needle) || a.displayName.toLowerCase().includes(needle) || a.purpose.toLowerCase().includes(needle)).map((a) => ({
          id: a.key,
          label: a.displayName,
          group: 'Agent' as const,
          href: `/agents/${a.key}`,
          createdAt: null,
          detail: `${a.layer} · ${a.purpose.slice(0, 90)}`,
        })),
      ),
    );
  }

  if (wants('Audit') && !wantsOwner && can(context, 'audit.read')) {
    searches.push(
      (async () => {
        let query = supabase
          .schema('audit')
          .from('audit_log')
          .select('id, action, subject_type, subject_id, actor_type, created_at')
          .ilike('action', like)
          .order('created_at', { ascending: false })
          .limit(RESULTS_PER_ENTITY);
        if (since) query = query.gte('created_at', since);
        query = applyConditions(query, conditions, undefined, null);
        const { data, error } = await query;
        if (error) unreadable('searchRecords.audit', error);
        return (data ?? []).map((a) => ({ id: String(a.id), label: a.action, group: 'Audit' as const, href: `/audit?q=${encodeURIComponent(a.action)}`, createdAt: a.created_at, detail: [a.subject_type, a.actor_type].filter(Boolean).join(' · ') || null }));
      })(),
    );
  }

  const settled = await Promise.all(searches);
  return settled.flat().sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}

/** Results grouped by entity type in the order the page shows them — SCR-002 "Result sections grouped by entity type". */
export function groupResults(results: readonly SearchPageResult[]): { group: SearchGroup; rows: SearchPageResult[] }[] {
  return SEARCH_GROUPS.map((group) => ({ group, rows: results.filter((r) => r.group === group) })).filter((g) => g.rows.length > 0);
}
