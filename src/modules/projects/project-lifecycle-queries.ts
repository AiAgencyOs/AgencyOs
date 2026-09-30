import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { readBlockersAcrossProjects } from './blockers-queries';
import { lifecyclePhaseOf, type LifecyclePhase } from './project-archive-schema';
import { isInQa } from '@/lib/admin/qa-stage';

/**
 * The projects list's lifecycle facts — SCR-018 (migration 20261001120000).
 *
 * Per project: which lifecycle phase it is in (derived by
 * `lifecyclePhaseOf` from the phase tables the workspace tabs already
 * read), whether it is archived, and whether it is BLOCKED — a blocked
 * task or an unmet plan dependency, the definition `/projects/escalations`
 * and the blockers reader already use, so "blocked" means one thing across
 * the panel. Seven bounded reads, no per-project fan-out; every failed
 * read refuses.
 */
/** Mirrors qa's `BLOCKING_SEVERITIES` (cross-module imports go through a service; the rule is two words). */
const BLOCKING_SEVERITIES: readonly string[] = ['blocker', 'major'];

export type ProjectLifecycle = {
  phase: LifecyclePhase;
  /** Derived (decision 9): an open test run and no release. */
  inQa: boolean;
  archivedAt: string | null;
  blocked: boolean;
  blockedTasks: number;
  unmetDependencies: number;
  /** Tasks not done whose due date has passed (agency day). */
  overdueTasks: number;
  /** Top-level tasks, and how many are done — the progress fallback when a project has no payment plan. */
  tasksTotal: number;
  tasksDone: number;
  /** Payment milestones not met whose due date has passed. */
  overdueMilestones: number;
  /** Open defects of a severity that blocks a release (`blocksDelivery`). */
  blockingDefects: number;
};

export async function readProjectLifecycles(todayKey: string = new Date().toISOString().slice(0, 10)): Promise<Map<string, ProjectLifecycle>> {
  const supabase = await createClient();

  const [projects, phaseTwo, phaseThree, phaseFour, testRuns, handovers, blockers, lateTasks, lateMilestones, openDefects] = await Promise.all([
    supabase.schema('projects').from('projects').select('id, status, archived_at, production_ready_at').is('deleted_at', null).limit(1000),
    supabase.schema('projects').from('phase_two').select('project_id').limit(2000),
    supabase.schema('projects').from('phase_three').select('project_id').limit(2000),
    supabase.schema('projects').from('phase_four').select('project_id').limit(2000),
    supabase.schema('qa').from('test_runs').select('project_id').eq('status', 'open').limit(5000),
    supabase.schema('projects').from('handovers').select('project_id').limit(2000),
    readBlockersAcrossProjects(),
    // One health rule on every screen: the same facts the Reports page reads.
    supabase.schema('projects').from('tasks').select('project_id, status, due_on').is('parent_task_id', null).limit(50000),
    supabase.schema('projects').from('milestones').select('project_id').is('met_at', null).lt('due_on', todayKey).limit(5000),
    supabase.schema('qa').from('defects').select('project_id, severity, status').eq('status', 'open').limit(5000),
  ]);
  if (projects.error) unreadable('readProjectLifecycles.projects', projects.error);
  if (phaseTwo.error) unreadable('readProjectLifecycles.phaseTwo', phaseTwo.error);
  if (phaseThree.error) unreadable('readProjectLifecycles.phaseThree', phaseThree.error);
  if (phaseFour.error) unreadable('readProjectLifecycles.phaseFour', phaseFour.error);
  if (testRuns.error) unreadable('readProjectLifecycles.testRuns', testRuns.error);
  if (handovers.error) unreadable('readProjectLifecycles.handovers', handovers.error);
  if (lateTasks.error) unreadable('readProjectLifecycles.lateTasks', lateTasks.error);
  if (lateMilestones.error) unreadable('readProjectLifecycles.lateMilestones', lateMilestones.error);
  if (openDefects.error) unreadable('readProjectLifecycles.openDefects', openDefects.error);

  const two = new Set((phaseTwo.data ?? []).map((r) => r.project_id));
  const three = new Set((phaseThree.data ?? []).map((r) => r.project_id));
  const four = new Set((phaseFour.data ?? []).map((r) => r.project_id));
  const openRuns = new Map<string, number>();
  for (const r of testRuns.data ?? []) openRuns.set(r.project_id, (openRuns.get(r.project_id) ?? 0) + 1);
  const handed = new Set((handovers.data ?? []).map((r) => r.project_id));
  const blockedBy = new Map(blockers.map((b) => [b.projectId, b]));
  const tally = (rows: readonly { project_id: string }[]) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.project_id, (m.get(r.project_id) ?? 0) + 1);
    return m;
  };
  const lateTaskBy = tally((lateTasks.data ?? []).filter((t) => t.status !== 'done' && t.due_on !== null && t.due_on < todayKey));
  const tasksAllBy = tally(lateTasks.data ?? []);
  const tasksDoneBy = tally((lateTasks.data ?? []).filter((t) => t.status === 'done'));
  const lateMilestoneBy = tally(lateMilestones.data ?? []);
  const blockingDefectBy = tally((openDefects.data ?? []).filter((d) => d.status === 'open' && BLOCKING_SEVERITIES.includes(d.severity)));

  const out = new Map<string, ProjectLifecycle>();
  for (const p of projects.data ?? []) {
    const b = blockedBy.get(p.id);
    const blockedTasks = b?.blockedTasks.length ?? 0;
    const unmetDependencies = b?.dependencies.length ?? 0;
    out.set(p.id, {
      phase: lifecyclePhaseOf({
        status: p.status,
        archivedAt: p.archived_at,
        productionReadyAt: p.production_ready_at,
        hasPhaseTwo: two.has(p.id),
        hasPhaseThree: three.has(p.id),
        hasPhaseFour: four.has(p.id),
        hasOpenTestRun: openRuns.has(p.id),
        hasHandover: handed.has(p.id),
      }),
      inQa: isInQa({ status: p.status, archivedAt: p.archived_at, openTestRuns: openRuns.get(p.id) ?? 0, hasRelease: handed.has(p.id) || Boolean(p.production_ready_at) }),
      archivedAt: p.archived_at,
      blocked: blockedTasks > 0 || unmetDependencies > 0,
      blockedTasks,
      unmetDependencies,
      overdueTasks: lateTaskBy.get(p.id) ?? 0,
      tasksTotal: tasksAllBy.get(p.id) ?? 0,
      tasksDone: tasksDoneBy.get(p.id) ?? 0,
      overdueMilestones: lateMilestoneBy.get(p.id) ?? 0,
      blockingDefects: blockingDefectBy.get(p.id) ?? 0,
    });
  }
  return out;
}
