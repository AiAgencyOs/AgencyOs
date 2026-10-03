import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { parseDeploymentDependencies, type DeploymentDependency } from './deployment-deps-schema';

export type SmokeItem = { label: string; doneAt: string | null };

export type ReleaseRecord = {
  rollbackPlan: string | null;
  smokeChecklist: SmokeItem[];
  dependencies: DeploymentDependency[];
};

export type ReleaseVerification = {
  id: string;
  environment: string;
  outcome: string;
  notes: string | null;
  evidenceUrl: string | null;
  buildTitle: string | null;
  buildVersion: number | null;
  verifiedAt: string;
  verifiedBy: string | null;
};

/**
 * The project's release record — SCR-049's rollback plan, smoke checklist and
 * deployment dependencies (`projects.release_records`, 20261006500100). One
 * row per project, written by the set_release_* doors, which create it on the
 * first write; a project with no row has simply recorded nothing, and that is
 * an empty record, not a missing handover. Needs no handover.
 */
export async function readReleaseRecord(projectId: string): Promise<ReleaseRecord> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('release_records')
    .select('rollback_plan, smoke_checklist, deployment_dependencies')
    .eq('project_id', projectId)
    .maybeSingle();
  if (error) unreadable('readReleaseRecord', error);
  if (!data) return { rollbackPlan: null, smokeChecklist: [], dependencies: [] };

  const raw = Array.isArray(data.smoke_checklist) ? data.smoke_checklist : [];
  const smokeChecklist: SmokeItem[] = raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const label = typeof entry.label === 'string' ? entry.label : null;
    if (!label) return [];
    return [{ label, doneAt: typeof entry.done_at === 'string' ? entry.done_at : null }];
  });
  return { rollbackPlan: data.rollback_plan, smokeChecklist, dependencies: parseDeploymentDependencies(data.deployment_dependencies) };
}

/** The dated post-deploy verifications, newest first, with who recorded each. */
export async function listReleaseVerifications(projectId: string, limit = 20): Promise<ReleaseVerification[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('release_verifications')
    .select('id, environment, outcome, notes, evidence_url, deliverable_id, verified_at, verified_by')
    .eq('project_id', projectId)
    .order('verified_at', { ascending: false })
    .limit(limit);
  if (error) unreadable('listReleaseVerifications', error);
  const rows = data ?? [];
  if (rows.length === 0) return [];

  const buildIds = [...new Set(rows.map((r) => r.deliverable_id).filter((id): id is string => Boolean(id)))];
  const userIds = [...new Set(rows.map((r) => r.verified_by).filter((id): id is string => Boolean(id)))];
  const [builds, people] = await Promise.all([
    buildIds.length > 0 ? supabase.schema('projects').from('deliverables').select('id, title, version').in('id', buildIds) : Promise.resolve({ data: [], error: null }),
    userIds.length > 0 ? supabase.schema('core').from('memberships').select('user_id, users:user_id(full_name, email)').in('user_id', userIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (builds.error) unreadable('listReleaseVerifications.builds', builds.error);
  if (people.error) unreadable('listReleaseVerifications.people', people.error);
  const build = new Map((builds.data ?? []).map((b) => [b.id, b]));
  const name = new Map<string, string>();
  for (const m of (people.data ?? []) as { user_id: string; users: { full_name: string | null; email: string } | null }[]) {
    name.set(m.user_id, m.users?.full_name ?? m.users?.email ?? 'Unknown');
  }
  return rows.map((r) => ({
    id: r.id,
    environment: r.environment,
    outcome: r.outcome,
    notes: r.notes,
    evidenceUrl: r.evidence_url,
    buildTitle: r.deliverable_id ? (build.get(r.deliverable_id)?.title ?? null) : null,
    buildVersion: r.deliverable_id ? (build.get(r.deliverable_id)?.version ?? null) : null,
    verifiedAt: r.verified_at,
    verifiedBy: r.verified_by ? (name.get(r.verified_by) ?? 'Unknown') : null,
  }));
}
