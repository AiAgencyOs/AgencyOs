import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { leadQualificationSchema } from './schema';
import type { LeadListItem } from './types';

/**
 * The leads list with the columns its filters and bulk actions need —
 * SCR-006. `listLeads` carries only what the chat list draws; this adds the
 * assignee, the tags and the qualification's budget, and takes the filters
 * the page reads from the URL. Source, owner, status, and creation dates
 * are pushed to the database; the budget lives in a jsonb column and is
 * applied here after the read.
 */
export type LeadTableFilter = {
  q?: string;
  source?: string;
  owner?: string;
  status?: string;
  tag?: string;
  createdFrom?: string;
  createdTo?: string;
  budgetMinMinor?: number;
  budgetMaxMinor?: number;
  limit?: number;
};

export type LeadTableRow = LeadListItem & {
  assigned_to: string | null;
  tags: string[];
  budgetMinor: number | null;
};

export async function listLeadsForTable(filter: LeadTableFilter = {}): Promise<LeadTableRow[]> {
  const supabase = await createClient();

  let query = supabase
    .schema('crm')
    .from('leads')
    .select('id, title, status, source, created_at, assigned_to, tags, qualification, contacts(full_name, company)')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(Math.min(filter.limit ?? 200, 500));

  if (filter.q) query = query.ilike('title', `%${filter.q.replace(/[%_]/g, (c) => `\\${c}`)}%`);
  if (filter.source) query = query.eq('source', filter.source);
  if (filter.owner) query = query.eq('assigned_to', filter.owner);
  if (filter.status) query = query.eq('status', filter.status);
  if (filter.tag) query = query.contains('tags', [filter.tag]);
  if (filter.createdFrom) query = query.gte('created_at', `${filter.createdFrom}T00:00:00Z`);
  if (filter.createdTo) query = query.lt('created_at', `${filter.createdTo}T23:59:59.999Z`);

  const { data, error } = await query;
  if (error) unreadable('listLeadsForTable', error);

  const rows: LeadTableRow[] = (data ?? []).map((row) => {
    const qualification = leadQualificationSchema.safeParse(row.qualification ?? {});
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      source: row.source,
      created_at: row.created_at,
      assigned_to: row.assigned_to,
      tags: row.tags ?? [],
      budgetMinor: qualification.success ? (qualification.data.budgetMinor ?? null) : null,
      contact: row.contacts ? { fullName: row.contacts.full_name, company: row.contacts.company } : null,
    };
  });

  const min = filter.budgetMinMinor;
  const max = filter.budgetMaxMinor;
  if (min === undefined && max === undefined) return rows;
  return rows.filter((r) => r.budgetMinor !== null && (min === undefined || r.budgetMinor >= min) && (max === undefined || r.budgetMinor <= max));
}
