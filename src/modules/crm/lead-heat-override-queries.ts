import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import type { HeatOverride, LeadHeatLabel } from './lead-heat';

type Row = {
  id: string;
  heat_override: string | null;
  heat_override_reason: string | null;
  heat_override_by: string | null;
  heat_override_at: string | null;
  heat_override_computed: string | null;
};

const LABELS: readonly string[] = ['Hot', 'Warm', 'Cold'];

function overrideOf(row: Row): HeatOverride | null {
  if (!row.heat_override || !LABELS.includes(row.heat_override) || !row.heat_override_reason || !row.heat_override_by || !row.heat_override_at) return null;
  const computed = row.heat_override_computed && LABELS.includes(row.heat_override_computed) ? row.heat_override_computed : row.heat_override;
  return { label: row.heat_override as LeadHeatLabel, reason: row.heat_override_reason, byUserId: row.heat_override_by, at: row.heat_override_at, computed: computed as LeadHeatLabel };
}

const COLUMNS = 'id, heat_override, heat_override_reason, heat_override_by, heat_override_at, heat_override_computed';

export async function readLeadHeatOverride(leadId: string): Promise<HeatOverride | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').from('leads').select(COLUMNS).eq('id', leadId).maybeSingle();
  if (error) unreadable('readLeadHeatOverride', error);
  return data ? overrideOf(data as Row) : null;
}

/** Every override among these leads, by lead id. */
export async function readLeadHeatOverrides(leadIds: readonly string[]): Promise<Map<string, HeatOverride>> {
  const out = new Map<string, HeatOverride>();
  if (leadIds.length === 0) return out;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('crm').from('leads').select(COLUMNS).not('heat_override', 'is', null).limit(10000);
  if (error) unreadable('readLeadHeatOverrides', error);
  const wanted = new Set(leadIds);
  for (const row of (data ?? []) as Row[]) {
    if (!wanted.has(row.id)) continue;
    const o = overrideOf(row);
    if (o) out.set(row.id, o);
  }
  return out;
}
