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

export const SEARCH_GROUPS = ['Lead', 'Client', 'Project', 'Invoice', 'Quotation', 'Meeting', 'Task'] as const;
export type SearchGroup = (typeof SEARCH_GROUPS)[number];

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
  /** The row's own `created_at` — what the date filter is applied to. */
  createdAt: string;
  /** A second line where the row has one worth showing. */
  detail: string | null;
};

export type SearchPageFilter = {
  q: string;
  group?: SearchGroup;
  sinceDays?: number;
  /** SCR-002 advanced filters: the row's own status, and the person it belongs to (assignee, delivery lead, relationship owner). */
  status?: string;
  ownerId?: string;
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
  const ownerOk = (group: SearchGroup) => ownerId === null || OWNER_COLUMN[group] !== undefined;

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
          .ilike('name', like)
          .order('created_at', { ascending: false })
          .limit(RESULTS_PER_ENTITY);
        if (since) query = query.gte('created_at', since);
        if (status) query = query.eq('status', status);
        if (ownerId) query = query.eq('owner_id', ownerId);
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
          .ilike('name', like)
          .is('deleted_at', null)
          .order('created_at', { ascending: false })
          .limit(RESULTS_PER_ENTITY);
        if (since) query = query.gte('created_at', since);
        if (status) query = query.eq('status', status);
        if (ownerId) query = query.eq('delivery_lead_id', ownerId);
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
          .order('created_at', { ascending: false })
          .limit(RESULTS_PER_ENTITY);
        if (since) query = query.gte('created_at', since);
        if (status) query = query.eq('status', status);
        if (ownerId) query = query.eq('assignee_id', ownerId);
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

  const settled = await Promise.all(searches);
  return settled.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Results grouped by entity type in the order the page shows them — SCR-002 "Result sections grouped by entity type". */
export function groupResults(results: readonly SearchPageResult[]): { group: SearchGroup; rows: SearchPageResult[] }[] {
  return SEARCH_GROUPS.map((group) => ({ group, rows: results.filter((r) => r.group === group) })).filter((g) => g.rows.length > 0);
}
