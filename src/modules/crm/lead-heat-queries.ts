import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { deriveLeadHeat, type LeadHeatReading } from './lead-heat';
import { readLeadFacts } from './lead-list-queries';

/**
 * What the Leads list's Hot Leads / No Response filters read (decision 14):
 * when each lead last wrote (`crm.last_inbound_by_lead`, the newest
 * client-authored message across its conversations) and how far its deal
 * has got. Two bounded reads; a failed read refuses rather than printing a
 * count of zero that means "we could not look".
 */
export type LeadHeatFacts = { lastInboundAt: string | null; dealStage: string | null };

const STAGE_RANK: Record<string, number> = { discovery: 1, proposal: 2, negotiation: 3, won: 4 };

export async function readLeadHeat(): Promise<Map<string, LeadHeatFacts>> {
  const supabase = await createClient();
  const [inbound, deals] = await Promise.all([
    supabase.schema('crm').rpc('last_inbound_by_lead'),
    supabase.schema('sales').from('opportunities').select('lead_id, stage').not('lead_id', 'is', null).neq('stage', 'lost').limit(10000),
  ]);
  if (inbound.error) unreadable('readLeadHeat.inbound', inbound.error);
  if (deals.error) unreadable('readLeadHeat.deals', deals.error);

  const out = new Map<string, LeadHeatFacts>();
  const slot = (id: string) => {
    let s = out.get(id);
    if (!s) out.set(id, (s = { lastInboundAt: null, dealStage: null }));
    return s;
  };
  for (const row of (inbound.data ?? []) as { lead_id: string; last_inbound_at: string | null }[]) {
    slot(row.lead_id).lastInboundAt = row.last_inbound_at;
  }
  for (const d of deals.data ?? []) {
    if (!d.lead_id) continue;
    const s = slot(d.lead_id);
    if ((STAGE_RANK[d.stage] ?? 0) > (STAGE_RANK[s.dealStage ?? ''] ?? 0)) s.dealStage = d.stage;
  }
  return out;
}

/**
 * One lead's Hot / Warm / Cold reading with its reasons (owner decision 1,
 * round 2) — for Lead 360, the qualification screen and the preview drawer.
 * The same three recorded reasons the list uses, from the same readers; a read
 * that fails refuses rather than printing "Cold" for a lead we could not look at.
 */
export async function readLeadHeatReading(lead: { id: string; status: string }): Promise<LeadHeatReading> {
  const [heat, facts] = await Promise.all([readLeadHeat(), readLeadFacts([lead.id])]);
  return deriveLeadHeat(
    {
      status: lead.status,
      dealStage: heat.get(lead.id)?.dealStage ?? null,
      // The label never reads the creation date (only No Response does); the type asks for one.
      createdAt: new Date().toISOString(),
      lastInboundAt: heat.get(lead.id)?.lastInboundAt ?? null,
      budgetRecorded: (facts.get(lead.id)?.budgetMinor ?? null) !== null,
    },
    new Date(),
  );
}
