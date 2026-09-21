'use server';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';

/**
 * Global Search — SCR-002. The command palette (command-palette.tsx) has
 * always been a filter over a static list of page links; this is the first
 * query against actual records. RLS scopes every read the same as the
 * page it mirrors — this adds no reach a signed-in role does not already
 * have from /leads, /clients, /projects, /invoices themselves.
 *
 * A server action rather than a route handler: called directly from the
 * client component's debounced effect, the same mechanism a form action
 * uses, with no API surface to separately secure.
 */

export type SearchResult = {
  id: string;
  label: string;
  group: string;
  href: string;
};

const MIN_QUERY_LENGTH = 2;
const RESULTS_PER_ENTITY = 5;

export async function globalSearch(query: string): Promise<SearchResult[]> {
  const trimmed = query.trim();
  if (trimmed.length < MIN_QUERY_LENGTH) return [];

  const context = await requireInternal();
  const supabase = await createClient();
  const like = `%${trimmed.replace(/[%_]/g, (c) => `\\${c}`)}%`;

  const searches: PromiseLike<SearchResult[]>[] = [];

  if (can(context.role, 'lead.read')) {
    searches.push(
      supabase
        .schema('crm')
        .from('leads')
        .select('id, title')
        .ilike('title', like)
        .limit(RESULTS_PER_ENTITY)
        .then(({ data }) => (data ?? []).map((l) => ({ id: l.id, label: l.title, group: 'Lead', href: `/leads/${l.id}` }))),
    );
  }

  if (can(context.role, 'project.read')) {
    searches.push(
      supabase
        .schema('core')
        .from('client_accounts')
        .select('id, name')
        .ilike('name', like)
        .limit(RESULTS_PER_ENTITY)
        .then(({ data }) => (data ?? []).map((c) => ({ id: c.id, label: c.name, group: 'Client', href: `/clients/${c.id}` }))),
    );

    searches.push(
      supabase
        .schema('projects')
        .from('projects')
        .select('id, name')
        .ilike('name', like)
        .is('deleted_at', null)
        .limit(RESULTS_PER_ENTITY)
        .then(({ data }) => (data ?? []).map((p) => ({ id: p.id, label: p.name, group: 'Project', href: `/projects/${p.id}` }))),
    );
  }

  if (can(context.role, 'invoice.read')) {
    searches.push(
      supabase
        .schema('finance')
        .from('invoices')
        .select('id, number')
        .ilike('number', like)
        .limit(RESULTS_PER_ENTITY)
        .then(({ data }) => (data ?? []).map((i) => ({ id: i.id, label: i.number, group: 'Invoice', href: `/invoices/${i.id}` }))),
    );
  }

  const settled = await Promise.all(searches);
  return settled.flat();
}
