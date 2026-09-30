import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * SCR-023 "Dependency list" — what a payment milestone waits on, from three
 * facts that are already stored and nothing inferred:
 *
 *  - `gates`: the plan dependencies (client information, access, an outside
 *    service, an approval...) the active plan's own milestone for this payment
 *    milestone is gated by (`plan_milestone_dependencies`);
 *  - `earlierUnmet`: the payment milestones before it in the plan order that are
 *    not met yet (the ladder is ordered, and a later step is not reached first);
 *  - `blockedTasks`: its tasks that are Blocked, with the blocker's owner and next action.
 *
 * A project with no plan has no `gates`, and that is an answer, not a failure.
 */
export type MilestoneDependencies = {
  gates: { id: string; kind: string; description: string; status: string; ownerRole: string; neededByPhase: string }[];
  earlierUnmet: { id: string; name: string }[];
  blockedTasks: { id: string; title: string; reason: string | null; owner: string | null; nextAction: string | null }[];
};

export async function readMilestoneDependencies(
  projectId: string,
  milestones: readonly { id: string; name: string; position: number; met: boolean }[],
): Promise<Map<string, MilestoneDependencies>> {
  const supabase = await createClient();
  const out = new Map<string, MilestoneDependencies>();
  const ordered = [...milestones].sort((a, b) => a.position - b.position);
  for (const m of ordered) {
    out.set(m.id, {
      gates: [],
      earlierUnmet: ordered.filter((o) => o.position < m.position && !o.met).map((o) => ({ id: o.id, name: o.name })),
      blockedTasks: [],
    });
  }
  if (ordered.length === 0) return out;

  const [blocked, plan] = await Promise.all([
    supabase.schema('projects').from('tasks').select('id, title, milestone_id, blocked_reason, blocker_owner, blocker_next_action').eq('project_id', projectId).eq('status', 'blocked').is('parent_task_id', null),
    supabase.schema('projects').from('project_plans').select('id').eq('project_id', projectId).in('status', ['draft', 'active']).order('version', { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (blocked.error) unreadable('readMilestoneDependencies.blocked', blocked.error);
  if (plan.error) unreadable('readMilestoneDependencies.plan', plan.error);
  for (const t of blocked.data ?? []) {
    if (t.milestone_id) out.get(t.milestone_id)?.blockedTasks.push({ id: t.id, title: t.title, reason: t.blocked_reason, owner: t.blocker_owner, nextAction: t.blocker_next_action });
  }
  if (!plan.data) return out;

  const { data: planMilestones, error: pmError } = await supabase
    .schema('projects')
    .from('plan_milestones')
    .select('id, payment_milestone_id')
    .eq('plan_id', plan.data.id)
    .not('payment_milestone_id', 'is', null);
  if (pmError) unreadable('readMilestoneDependencies.planMilestones', pmError);
  const planIds = (planMilestones ?? []).map((p) => p.id);
  if (planIds.length === 0) return out;

  const { data: links, error: linkError } = await supabase.schema('projects').from('plan_milestone_dependencies').select('milestone_id, dependency_id').in('milestone_id', planIds);
  if (linkError) unreadable('readMilestoneDependencies.links', linkError);
  const depIds = [...new Set((links ?? []).map((l) => l.dependency_id))];
  if (depIds.length === 0) return out;
  const { data: deps, error: depError } = await supabase.schema('projects').from('plan_dependencies').select('id, kind, description, status, owner_role, needed_by_phase').in('id', depIds);
  if (depError) unreadable('readMilestoneDependencies.dependencies', depError);
  const depById = new Map((deps ?? []).map((d) => [d.id, d]));
  const paymentOf = new Map((planMilestones ?? []).map((p) => [p.id, p.payment_milestone_id as string]));
  for (const l of links ?? []) {
    const d = depById.get(l.dependency_id);
    const target = out.get(paymentOf.get(l.milestone_id) ?? '');
    if (d && target) target.gates.push({ id: d.id, kind: d.kind, description: d.description, status: d.status, ownerRole: d.owner_role, neededByPhase: d.needed_by_phase });
  }
  return out;
}
