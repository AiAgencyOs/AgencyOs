import type { createAdminClient } from '@/lib/db/admin';
import { looseSchema } from '@/lib/p13/loose-client';
import type { AnnounceJob, HandlerResult } from '@/modules/crm/handlers';

/**
 * P3-PM-006 / P3-PM-005: `ui_designer:p13GuardDesignContext` (job kind `design.context_guard`), a SECOND subscriber to `project.screen_list_finalized`
 * beside `ui_designer:designDirections`.
 *
 * Until now `designDirections` met a project with no screens, or no client answer about platforms / design expectations, and quietly settled its job
 * ("the baseline has no screens to design for"): the phase carried on as if nothing were wrong. This handler says so out loud, deterministically and
 * with NO model call (spending tokens on a completeness check is what the Phase 3 master forbids):
 *
 *   * the facts are re-read from rows (row authority over event payload), for the job's organization
 *   * a gap that makes designing impossible (no active scope, no screens) puts the phase in `blocked_requirement` with a stated reason, through the door
 *   * a gap the client can fill (platforms, design expectations) is raised as a design clarification, once (the door is idempotent on the question)
 *
 * It asks nobody anything and draws nothing: a person asks the client, and records the answer, through the clarification doors.
 */
type Admin = ReturnType<typeof createAdminClient>;

export type DesignContextFacts = { activeScope: boolean; screenCount: number; coverageAreas: readonly string[] };
export type ContextGap = { key: string; blocking: boolean; question: string };

const NEEDED_COVERAGE: { area: string; question: string }[] = [
  { area: 'platforms', question: 'Which platforms does the client need (web, Android, iOS)? Design cannot choose navigation patterns without it.' },
  { area: 'design_expectations', question: 'What does the client expect the design to look and feel like? Any brands, sites or colours they like or dislike?' },
];

/** Pure. Missing scope or screens block the phase; missing client answers become clarifications. */
export function assessDesignContext(facts: DesignContextFacts): ContextGap[] {
  const gaps: ContextGap[] = [];
  if (!facts.activeScope) gaps.push({ key: 'scope', blocking: true, question: 'There is no active approved scope to design against.' });
  if (facts.screenCount < 1) gaps.push({ key: 'screens', blocking: true, question: 'The finalized screen list has no screens to design for.' });
  for (const need of NEEDED_COVERAGE) {
    if (!facts.coverageAreas.includes(need.area)) gaps.push({ key: need.area, blocking: false, question: need.question });
  }
  return gaps;
}

type Row = Record<string, unknown>;

export async function guardDesignContext(admin: Admin, job: AnnounceJob): Promise<HandlerResult> {
  const subjectId = job.payload?.subjectId;
  if (!subjectId) return { status: 'failed', permanent: true, detail: 'the job names no screen baseline' };
  const projects = looseSchema(admin as never, 'projects');

  const baseline = await projects.from('screen_baselines').select('id, project_id, screen_count, status').eq('id', subjectId).eq('organization_id', job.organization_id).maybeSingle();
  if (baseline.error) return { status: 'failed', permanent: false, detail: `could not read the baseline: ${baseline.error.message}` };
  const b = baseline.data as Row | null;
  if (!b) return { status: 'succeeded', outcome: 'baseline_gone', detail: 'the screen baseline no longer exists' };
  if (b.status !== 'finalized') return { status: 'succeeded', outcome: 'superseded', detail: `the baseline is ${String(b.status)}, not finalized` };
  const projectId = String(b.project_id);

  const phase = await projects.from('phase_three').select('id, state').eq('project_id', projectId).eq('organization_id', job.organization_id).maybeSingle();
  if (phase.error) return { status: 'failed', permanent: false, detail: `could not read the phase: ${phase.error.message}` };
  const p = phase.data as Row | null;
  if (!p) return { status: 'succeeded', outcome: 'no_phase', detail: 'Phase 3 has not started for this project' };

  const scope = await projects.from('scope_versions').select('id').eq('project_id', projectId).eq('status', 'active').limit(1);
  if (scope.error) return { status: 'failed', permanent: false, detail: `could not read the scope: ${scope.error.message}` };

  const coverage = await readCoverageAreas(admin, job.organization_id, projectId);
  if (!coverage.ok) return { status: 'failed', permanent: false, detail: coverage.detail };

  const gaps = assessDesignContext({
    activeScope: Array.isArray(scope.data) && scope.data.length > 0,
    screenCount: Number(b.screen_count ?? 0),
    coverageAreas: coverage.areas,
  });
  if (gaps.length === 0) return { status: 'succeeded', outcome: 'context_complete', detail: 'the design context is complete' };

  const raised: string[] = [];
  for (const gap of gaps.filter((g) => !g.blocking)) {
    const { data, error } = await projects.rpc('p13_raise_design_clarification', { p_phase_three_id: p.id, p_screen_ref: null, p_question: gap.question });
    if (error) return { status: 'failed', permanent: false, detail: `could not raise a clarification: ${error.message}` };
    const row = (Array.isArray(data) ? data[0] : data) as Row | undefined;
    if (row?.outcome === 'raised' || row?.outcome === 'already_open') raised.push(gap.key);
  }

  const blocking = gaps.filter((g) => g.blocking);
  if (blocking.length > 0) {
    const reason = blocking.map((g) => g.question).join(' ');
    const { data, error } = await projects.rpc('p13_block_design_requirement', { p_phase_three_id: p.id, p_reason: reason });
    if (error) return { status: 'failed', permanent: false, detail: `could not block the phase: ${error.message}` };
    // 'wrong_state' means the phase is already past drafting (never interrupted); 'already_blocked' is a replay. Neither is a failure.
    return { status: 'succeeded', outcome: `blocked:${String(data)}`, detail: `design context incomplete (${blocking.map((g) => g.key).join(', ')}); clarifications raised: ${raised.join(', ') || 'none'}` };
  }
  return { status: 'succeeded', outcome: 'clarifications_raised', detail: `clarifications raised for: ${raised.join(', ')}` };
}

async function readCoverageAreas(admin: Admin, organizationId: string, projectId: string): Promise<{ ok: true; areas: string[] } | { ok: false; detail: string }> {
  const project = await looseSchema(admin as never, 'projects').from('projects').select('opportunity_id').eq('id', projectId).eq('organization_id', organizationId).maybeSingle();
  if (project.error) return { ok: false, detail: `could not read the project: ${project.error.message}` };
  const opportunityId = (project.data as Row | null)?.opportunity_id;
  if (typeof opportunityId !== 'string') return { ok: true, areas: [] };
  const opp = await looseSchema(admin as never, 'sales').from('opportunities').select('lead_id').eq('id', opportunityId).eq('organization_id', organizationId).maybeSingle();
  if (opp.error) return { ok: false, detail: `could not read the deal: ${opp.error.message}` };
  const leadId = (opp.data as Row | null)?.lead_id;
  if (typeof leadId !== 'string') return { ok: true, areas: [] };
  const cov = await looseSchema(admin as never, 'crm').from('qualification_coverage').select('area').eq('lead_id', leadId).eq('organization_id', organizationId);
  if (cov.error) return { ok: false, detail: `could not read the answers: ${cov.error.message}` };
  return { ok: true, areas: (Array.isArray(cov.data) ? (cov.data as Row[]) : []).map((r) => String(r.area)) };
}
