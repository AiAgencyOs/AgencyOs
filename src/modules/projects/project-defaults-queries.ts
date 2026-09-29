import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { WATCH_PHASES, type WatchPhase } from './project-defaults-schema';

/**
 * Reads for SCR-027 — the default assignee, the watchers, and the phase
 * changes a watcher has asked to hear about.
 */

export type ProjectWatcher = { userId: string; fullName: string; phases: WatchPhase[] };

export type ProjectDefaults = {
  defaultAssigneeId: string | null;
  watchers: ProjectWatcher[];
};

function asPhases(value: string[] | null): WatchPhase[] {
  return (value ?? []).filter((p): p is WatchPhase => (WATCH_PHASES as readonly string[]).includes(p));
}

/** Names for a set of members, from the roster the same way `listInternalRoster` reads it. */
async function namesFor(userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('core')
    .from('memberships')
    .select('user_id, users:user_id(full_name, email)')
    .in('user_id', userIds);
  if (error) unreadable('projectDefaults.names', error);
  const map = new Map<string, string>();
  for (const m of (data ?? []) as Record<string, unknown>[]) {
    const user = (m.users ?? {}) as { full_name?: string | null; email?: string | null };
    map.set(m.user_id as string, user.full_name ?? user.email ?? 'someone without a name on file');
  }
  return map;
}

export async function readProjectDefaults(projectId: string): Promise<ProjectDefaults> {
  const supabase = await createClient();

  const [project, watchers] = await Promise.all([
    supabase.schema('projects').from('projects').select('default_assignee_id').eq('id', projectId).is('deleted_at', null).maybeSingle(),
    supabase.schema('projects').from('project_watchers').select('user_id, phases').eq('project_id', projectId).order('created_at', { ascending: true }),
  ]);
  if (project.error) unreadable('readProjectDefaults.project', project.error);
  if (watchers.error) unreadable('readProjectDefaults.watchers', watchers.error);

  const rows = watchers.data ?? [];
  const names = await namesFor(rows.map((w) => w.user_id));

  return {
    defaultAssigneeId: project.data?.default_assignee_id ?? null,
    watchers: rows.map((w) => ({
      userId: w.user_id,
      fullName: names.get(w.user_id) ?? 'a member',
      phases: asPhases(w.phases),
    })),
  };
}

/** The caller's own watch on a project — `null` when they are not watching. */
export async function readMyWatch(projectId: string, userId: string): Promise<{ phases: WatchPhase[] } | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('project_watchers')
    .select('phases')
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) unreadable('readMyWatch', error);
  return data ? { phases: asPhases(data.phases) } : null;
}

export type WatchedPhaseChange = {
  projectId: string;
  projectName: string;
  phase: WatchPhase;
  /** The state the row is in now, in the phase's own vocabulary. */
  state: string;
  changedAt: string;
};

/**
 * The most recent state of every phase row a person watches, for the Action
 * Center. One row per (project, phase) keyed on the moment it last changed,
 * so the same change is one notification however often it is listed, and a
 * new change is a new key. Bounded to `sinceIso` so a watch does not replay
 * a project's whole history the day it is added.
 */
export async function listWatchedPhaseChanges(userId: string, sinceIso: string): Promise<WatchedPhaseChange[]> {
  const supabase = await createClient();

  const { data: watches, error: watchesError } = await supabase
    .schema('projects')
    .from('project_watchers')
    .select('project_id, phases')
    .eq('user_id', userId);
  if (watchesError) unreadable('listWatchedPhaseChanges.watchers', watchesError);
  if (!watches || watches.length === 0) return [];

  const wanted = new Map<string, Set<WatchPhase>>();
  for (const w of watches) wanted.set(w.project_id, new Set(asPhases(w.phases)));
  const projectIds = [...wanted.keys()];
  const projectsFor = (phase: WatchPhase) => projectIds.filter((id) => wanted.get(id)?.has(phase));

  const [projects, phaseTwo, phaseThree, phaseFour] = await Promise.all([
    supabase.schema('projects').from('projects').select('id, name, status, status_changed_at').in('id', projectIds).is('deleted_at', null),
    projectsFor('phase_two').length > 0
      ? supabase.schema('projects').from('phase_two').select('project_id, state, updated_at').in('project_id', projectsFor('phase_two')).gte('updated_at', sinceIso)
      : Promise.resolve({ data: [], error: null }),
    projectsFor('phase_three').length > 0
      ? supabase.schema('projects').from('phase_three').select('project_id, state, updated_at').in('project_id', projectsFor('phase_three')).gte('updated_at', sinceIso)
      : Promise.resolve({ data: [], error: null }),
    projectsFor('phase_four').length > 0
      ? supabase.schema('projects').from('phase_four').select('project_id, state, updated_at').in('project_id', projectsFor('phase_four')).gte('updated_at', sinceIso)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (projects.error) unreadable('listWatchedPhaseChanges.projects', projects.error);
  if (phaseTwo.error) unreadable('listWatchedPhaseChanges.phaseTwo', phaseTwo.error);
  if (phaseThree.error) unreadable('listWatchedPhaseChanges.phaseThree', phaseThree.error);
  if (phaseFour.error) unreadable('listWatchedPhaseChanges.phaseFour', phaseFour.error);

  const nameOf = new Map((projects.data ?? []).map((p) => [p.id, p.name]));
  const rows: WatchedPhaseChange[] = [];

  for (const p of projects.data ?? []) {
    if (!wanted.get(p.id)?.has('status') || !p.status_changed_at || p.status_changed_at < sinceIso) continue;
    rows.push({ projectId: p.id, projectName: p.name, phase: 'status', state: p.status, changedAt: p.status_changed_at });
  }

  type PhaseRow = { project_id: string; state: string; updated_at: string };
  const collect = (phase: WatchPhase, data: PhaseRow[] | null) => {
    for (const r of data ?? []) {
      const projectName = nameOf.get(r.project_id);
      if (!projectName) continue;
      rows.push({ projectId: r.project_id, projectName, phase, state: r.state, changedAt: r.updated_at });
    }
  };
  collect('phase_two', phaseTwo.data as PhaseRow[] | null);
  collect('phase_three', phaseThree.data as PhaseRow[] | null);
  collect('phase_four', phaseFour.data as PhaseRow[] | null);

  rows.sort((a, b) => (a.changedAt < b.changedAt ? 1 : a.changedAt > b.changedAt ? -1 : 0));
  return rows;
}
