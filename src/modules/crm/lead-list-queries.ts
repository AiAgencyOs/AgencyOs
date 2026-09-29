import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { leadQualificationSchema } from './schema';

/**
 * The facts the leads list's extra filters read — SCR-006. `listLeadsForTable`
 * (queries.ts) carries what its columns draw; the budget and created-date
 * filters and the bulk actions' tag display need three more columns, read
 * here by id so the table's own reader stays what it is. The budget lives
 * in the qualification jsonb and is parsed through the same schema the lead
 * page uses, so a number the schema does not recognise is null, not a guess.
 */
export type LeadFacts = {
  createdAt: string;
  tags: string[];
  budgetMinor: number | null;
};

export async function readLeadFacts(leadIds: readonly string[]): Promise<Map<string, LeadFacts>> {
  const facts = new Map<string, LeadFacts>();
  if (leadIds.length === 0) return facts;

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('crm')
    .from('leads')
    .select('id, created_at, tags, qualification')
    .in('id', [...leadIds]);
  if (error) unreadable('readLeadFacts', error);

  for (const row of data ?? []) {
    const qualification = leadQualificationSchema.safeParse(row.qualification ?? {});
    facts.set(row.id, {
      createdAt: row.created_at,
      tags: row.tags ?? [],
      budgetMinor: qualification.success ? (qualification.data.budgetMinor ?? null) : null,
    });
  }
  return facts;
}
