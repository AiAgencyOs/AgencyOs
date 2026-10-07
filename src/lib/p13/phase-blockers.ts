/**
 * P2-FLOW-028 / P2-PLAN-027: one list of everything across all projects that is WAITING on somebody in Phases 2 and 3, with who it is waiting on and for
 * how long. Pure: rows in, rows out. The page reads three tables (RLS-scoped); nothing here changes a state.
 *
 * "Waiting" is read from the state the phase itself reports, never inferred: `phase_two.state` (waiting_* / blocked), `phase_three.state` (waiting_* and
 * the three stops) and `plan_dependencies.status = 'blocked'`. The owner column names the party the state implies; it does not assign anybody.
 */
export type PhaseTwoRow = { project_id: string; state: string; blocked_reason: string | null; updated_at: string };
export type PhaseThreeRow = { project_id: string; state: string; blocked_reason: string | null; updated_at: string };
export type BlockedDependencyRow = { project_id: string; kind: string; description: string; needed_by_phase: string; updated_at: string };
export type ProjectName = { id: string; name: string };

export type Blocker = {
  projectId: string;
  projectName: string;
  source: 'phase_two' | 'phase_three' | 'plan';
  state: string;
  waitingOn: string;
  reason: string;
  waitingDays: number;
  needsPerson: boolean;
};

const DAY = 86_400_000;

const PHASE_TWO_OWNER: Record<string, string> = {
  waiting_client: 'the client (the PM chases)',
  waiting_admin: 'an Admin',
  waiting_finance: 'Finance',
  waiting_planning: 'the planning step',
  blocked: 'an Admin (the phase is stopped)',
};
const PHASE_THREE_OWNER: Record<string, string> = {
  waiting_client: 'the client (the PM chases)',
  waiting_admin: 'an Admin',
  waiting_review: 'the internal reviewer',
  waiting_designer: 'the designer',
  blocked_requirement: 'an Admin (design context is incomplete)',
  scope_escalation: 'an Admin (possible scope change)',
  revision_limit_escalation: 'an Admin (revision limit reached)',
};

const days = (iso: string, now: Date): number => Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / DAY));

export function buildBlockers(input: { phaseTwo: readonly PhaseTwoRow[]; phaseThree: readonly PhaseThreeRow[]; dependencies: readonly BlockedDependencyRow[]; projects: readonly ProjectName[]; now: Date }): Blocker[] {
  const name = new Map(input.projects.map((p) => [p.id, p.name]));
  const out: Blocker[] = [];
  const nameOf = (id: string) => name.get(id) ?? 'a project you cannot read';
  for (const r of input.phaseTwo) {
    const waitingOn = PHASE_TWO_OWNER[r.state];
    if (!waitingOn) continue;
    out.push({ projectId: r.project_id, projectName: nameOf(r.project_id), source: 'phase_two', state: r.state, waitingOn, reason: r.blocked_reason ?? 'no reason recorded', waitingDays: days(r.updated_at, input.now), needsPerson: r.state !== 'waiting_client' });
  }
  for (const r of input.phaseThree) {
    const waitingOn = PHASE_THREE_OWNER[r.state];
    if (!waitingOn) continue;
    out.push({ projectId: r.project_id, projectName: nameOf(r.project_id), source: 'phase_three', state: r.state, waitingOn, reason: r.blocked_reason ?? 'no reason recorded', waitingDays: days(r.updated_at, input.now), needsPerson: r.state !== 'waiting_client' });
  }
  for (const r of input.dependencies) {
    out.push({
      projectId: r.project_id,
      projectName: nameOf(r.project_id),
      source: 'plan',
      state: 'dependency_blocked',
      waitingOn: r.kind === 'client_information' || r.kind === 'client_access' ? 'the client (the PM collects it)' : 'its owner',
      reason: `${r.description} (needed by ${r.needed_by_phase.replace('_', ' ')})`,
      waitingDays: days(r.updated_at, input.now),
      needsPerson: true,
    });
  }
  return out.sort((a, b) => b.waitingDays - a.waitingDays || a.projectName.localeCompare(b.projectName));
}

export function blockerSummary(blockers: readonly Blocker[]): { total: number; needsPerson: number; oldestDays: number; byWaitingOn: Record<string, number> } {
  const byWaitingOn: Record<string, number> = {};
  for (const b of blockers) byWaitingOn[b.waitingOn] = (byWaitingOn[b.waitingOn] ?? 0) + 1;
  return { total: blockers.length, needsPerson: blockers.filter((b) => b.needsPerson).length, oldestDays: blockers.reduce((m, b) => Math.max(m, b.waitingDays), 0), byWaitingOn };
}
