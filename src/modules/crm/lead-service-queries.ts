import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * SCR-006 — `crm.leads.service`, read for the information card and for the
 * list's `?service=` filter. Kept apart from `getLeadFacts` / `readLeadFacts`
 * so the column travels with the door that writes it.
 */
export async function readLeadService(leadId: string): Promise<string | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('crm')
    .from('leads')
    .select('service')
    .eq('id', leadId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) unreadable('readLeadService', error);
  return data?.service ?? null;
}

export type LeadServices = {
  /** lead id → service, for the leads the caller asked about. */
  byLead: Map<string, string | null>;
  /** Every distinct service recorded on those leads, sorted, for a datalist. */
  distinct: string[];
};

export async function readLeadServices(leadIds: readonly string[]): Promise<LeadServices> {
  if (leadIds.length === 0) return { byLead: new Map(), distinct: [] };
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('crm')
    .from('leads')
    .select('id, service')
    .in('id', [...leadIds]);
  if (error) unreadable('readLeadServices', error);

  const byLead = new Map<string, string | null>();
  const seen = new Map<string, string>();
  for (const row of data ?? []) {
    byLead.set(row.id, row.service);
    if (row.service) seen.set(row.service.toLowerCase(), row.service);
  }
  return { byLead, distinct: [...seen.values()].sort((a, b) => a.localeCompare(b)) };
}

/** The distinct services already recorded on this organization's leads — the datalist's suggestions. */
export async function listLeadServiceSuggestions(limit = 200): Promise<string[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('crm')
    .from('leads')
    .select('service')
    .not('service', 'is', null)
    .is('deleted_at', null)
    .order('service', { ascending: true })
    .limit(limit * 5);
  if (error) unreadable('listLeadServiceSuggestions', error);
  const seen = new Map<string, string>();
  for (const row of data ?? []) if (row.service) seen.set(row.service.toLowerCase(), row.service);
  return [...seen.values()].slice(0, limit);
}
