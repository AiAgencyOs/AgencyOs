import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { summariseSettingsAreas, type AreaSummary } from './settings-summary-eval';

/**
 * SCR-071's per-area status row: one read per fact, each under the caller's
 * own RLS. A failed read REFUSES (G-054) — a tile saying "0 set" because the
 * database did not answer would be the false calm this row exists to remove.
 * The one exception is the project-defaults row, which is optional in an
 * environment that has not applied its migration yet: that tile says
 * "folders unread" instead of claiming none.
 */
export async function readSettingsAreaSummaries(): Promise<AreaSummary[]> {
  const supabase = await createClient();
  const count = async (label: string, run: () => PromiseLike<{ count: number | null; error: { message: string } | null }>) => {
    const { count: c, error } = await run();
    if (error) unreadable(`readSettingsAreaSummaries.${label}`, error);
    return c ?? 0;
  };

  const [org, members, teamDefaults, approvalPolicies, paymentAccounts, paymentStructures, projectTemplates, defaults] = await Promise.all([
    supabase.schema('core').from('organizations').select('name, timezone, settings, default_design_reviewer_id, gstin').limit(1).maybeSingle(),
    count('members', () => supabase.schema('core').from('memberships').select('id', { count: 'exact', head: true }).eq('status', 'active')),
    count('teamDefaults', () => supabase.schema('projects').from('group_team_defaults').select('id', { count: 'exact', head: true }).eq('active', true)),
    count('approvalPolicies', () => supabase.schema('approvals').from('approval_policies').select('id', { count: 'exact', head: true }).eq('active', true)),
    count('paymentAccounts', () => supabase.schema('finance').from('payment_accounts').select('id', { count: 'exact', head: true })),
    count('paymentStructures', () => supabase.schema('sales').from('payment_structures').select('id', { count: 'exact', head: true })),
    count('projectTemplates', () => supabase.schema('projects').from('project_templates').select('id', { count: 'exact', head: true })),
    supabase.schema('projects').from('project_defaults').select('default_watch_phases, standard_folders').limit(1).maybeSingle(),
  ]);
  if (org.error) unreadable('readSettingsAreaSummaries.organization', org.error);

  const folders = defaults.error ? null : Array.isArray(defaults.data?.standard_folders) ? (defaults.data?.standard_folders as unknown[]).length : 0;

  return summariseSettingsAreas({
    organizationName: org.data?.name ?? null,
    timezone: org.data?.timezone ?? null,
    settings: (org.data?.settings ?? {}) as Record<string, unknown>,
    defaultDesignReviewerId: org.data?.default_design_reviewer_id ?? null,
    members,
    teamDefaults,
    approvalPolicies,
    paymentAccounts,
    gstinSet: Boolean(org.data?.gstin),
    paymentStructures,
    projectTemplates,
    defaultWatchPhases: defaults.error ? null : (defaults.data?.default_watch_phases?.length ?? null),
    standardFolders: folders,
  });
}
