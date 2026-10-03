import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * SCR-045 guardrail — "every accepted requirement should have coverage or an
 * explicit rationale". For a plan: each scope item of its own baseline that
 * is still in scope, with whether a case covers it, whether a waiver says why
 * it needs none, or neither (uncovered). An item the baseline EXCLUDES is not
 * a requirement to test and is left out rather than reported as a gap.
 */
export type RequirementCoverage = {
  scopeItemId: string;
  title: string;
  inclusion: string;
  cases: number;
  waiver: { reason: string; at: string } | null;
};

export async function readRequirementCoverage(planId: string, scopeVersionId: string): Promise<RequirementCoverage[]> {
  const supabase = await createClient();
  const [items, cases, waivers] = await Promise.all([
    supabase.schema('projects').from('scope_items').select('id, title, inclusion, position').eq('scope_version_id', scopeVersionId).neq('inclusion', 'excluded').order('position', { ascending: true }),
    supabase.schema('qa').from('test_plan_items').select('scope_item_id').eq('plan_id', planId),
    supabase.schema('qa').from('test_coverage_waivers').select('scope_item_id, reason, created_at').eq('plan_id', planId),
  ]);
  if (items.error) unreadable('readRequirementCoverage.items', items.error);
  if (cases.error) unreadable('readRequirementCoverage.cases', cases.error);
  if (waivers.error) unreadable('readRequirementCoverage.waivers', waivers.error);

  const caseCount = new Map<string, number>();
  for (const c of cases.data ?? []) caseCount.set(c.scope_item_id, (caseCount.get(c.scope_item_id) ?? 0) + 1);
  const waiverOf = new Map((waivers.data ?? []).map((w) => [w.scope_item_id, { reason: w.reason, at: w.created_at }]));

  return (items.data ?? []).map((i) => ({
    scopeItemId: i.id,
    title: i.title,
    inclusion: i.inclusion,
    cases: caseCount.get(i.id) ?? 0,
    waiver: waiverOf.get(i.id) ?? null,
  }));
}
