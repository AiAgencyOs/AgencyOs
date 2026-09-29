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
 * same four entities under the same capabilities and the same RLS, with a
 * larger bound per entity, the row's creation instant (so a date filter is
 * a filter over something the row actually carries), and an entity filter
 * so the reader can ask for only leads or only invoices.
 *
 * A failed read refuses (`unreadable`) rather than rendering an empty
 * list: "no results" and "the database did not answer" are different
 * sentences.
 */

export const SEARCH_GROUPS = ['Lead', 'Client', 'Project', 'Invoice'] as const;
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
  const wants = (group: SearchGroup) => filter.group === undefined || filter.group === group;

  const searches: Promise<SearchPageResult[]>[] = [];

  if (wants('Lead') && can(context.role, 'lead.read')) {
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

  if (wants('Client') && can(context.role, 'project.read')) {
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

  if (wants('Project') && can(context.role, 'project.read')) {
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

  if (wants('Invoice') && can(context.role, 'invoice.read')) {
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

  const settled = await Promise.all(searches);
  return settled.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
