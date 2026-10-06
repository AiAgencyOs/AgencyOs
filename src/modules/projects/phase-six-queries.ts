import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * The Phase 6 Overview (P601 §46): what is current, what is blocked, what QA found, what the Admin approved, whether Phase 7 may start - one read of the
 * STORED state, never re-derived here. Every read is guarded (G-054): a failed read is `unreadable`, never rendered as "nothing yet".
 * The qa / projects tables written for Phase 6 are not in the generated database types yet (`npm run db:types` needs the migrated Docker stack), so the
 * reads go through a minimal structural type rather than hand-editing a generated file.
 */

type Row = Record<string, unknown>;
type Res = PromiseLike<{ data: unknown; error: { message: string } | null }>;
type Loose = {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): Res & {
        order(column: string, options: { ascending: boolean }): Res & { limit(n: number): Res };
        limit(n: number): Res;
        maybeSingle(): Res;
      };
    };
  };
  rpc(fn: string, args: Record<string, unknown>): Res;
};

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const rows = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);
const first = (v: unknown): Row | null => (Array.isArray(v) ? ((v[0] as Row | undefined) ?? null) : ((v as Row | null) ?? null));

export type PhaseSixOverview = {
  workspace: { id: string; state: string; blockedReason: string | null } | null;
  gates: { m3VerifiedPaid: boolean; m4VerifiedPaid: boolean; phaseSevenGate: string | null };
  intake: { status: string; commit: string; artifactSha256: string | null; platforms: string[]; changeRequests: number; blockers: { type: string; owner: string; resumeCondition: string; detail: string }[]; external: { name: string; detail: string }[] } | null;
  plan: {
    id: string;
    version: number;
    status: string;
    categories: string[];
    journeys: string[];
    problems: string[];
    risks: { area: string; kind: string; level: string; depth: string }[];
    cases: { id: string; title: string; category: string; priority: string; status: string; journey: string | null }[];
  } | null;
  defects: { id: string; title: string; sLevel: number | null; classification: string; status: string; duplicateOf: string | null; workState: string }[];
  contracts: { name: string; ref: string }[];
  clarifications: { id: string; question: string; status: string; answer: string | null }[];
  performance: { metric: string; target: number; unit: string; lowerIsBetter: boolean; latest: number | null; ok: boolean | null }[];
  devices: { name: string; platform: string; status: string; reason: string | null }[];
  compatibilityMatrix: unknown[];
  jobs: { category: string; specialist: string; mode: string; status: string; reason: string; dependsOn: string[] }[];
  candidateCurrent: boolean;
  candidate: {
    id: string;
    version: number;
    status: string;
    commit: string;
    artifactSha256: string;
    rollbackPlan: string | null;
    observability: string | null;
    configVersion: string | null;
    categories: { category: string; status: string; commit: string }[];
    gates: { gate: string; passed: boolean; exceptioned: boolean; satisfied: boolean; detail: string }[];
    exceptions: { id: string; gate: string; status: string; expiresAt: string; owner: string }[];
    assessment: { score: number; band: string; result: string } | null;
    reviews: { decision: string; note: string | null; decidedAt: string }[];
  } | null;
  completion: { outcome: string; missing: string[] } | null;
  phaseSevenIntake: { id: string; commit: string; productionDeployed: boolean } | null;
};

export async function readPhaseSixOverview(projectId: string): Promise<PhaseSixOverview> {
  const supabase = await createClient();
  const projects = supabase.schema('projects') as unknown as Loose;
  const qa = supabase.schema('qa') as unknown as Loose;

  const { data: ws, error: wsError } = await projects.from('phase_six').select('id, organization_id, state, blocked_reason').eq('project_id', projectId).maybeSingle();
  if (wsError) unreadable('readPhaseSixOverview.workspace', wsError);

  const [
    { data: m3, error: m3Error },
    { data: m4, error: m4Error },
    { data: gate7, error: gate7Error },
    { data: intakeRow, error: intakeError },
    { data: planRows, error: planError },
    { data: defectRows, error: defectError },
    { data: candRows, error: candError },
    { data: completion, error: completionError },
    { data: handoffRow, error: handoffError },
    { data: currentRaw, error: currentError },
    { data: clarRows, error: clarError },
    { data: budgetRows, error: budgetError },
    { data: metricRows, error: metricError },
    { data: deviceRows, error: deviceError },
  ] = await Promise.all([
    projects.rpc('m3_verified_paid', { p_project_id: projectId }),
    projects.rpc('m4_verified_paid', { p_project_id: projectId }),
    projects.rpc('phase_seven_gate_status', { p_project_id: projectId }),
    projects.from('qa_intakes').select('status, commit_ref, artifact_sha256, blockers, external_dependencies, supported_platforms, change_request_history').eq('project_id', projectId).maybeSingle(),
    qa.from('master_test_plans').select('id, version, status, required_categories, critical_journeys, compatibility_matrix').eq('project_id', projectId).order('version', { ascending: false }).limit(1),
    qa.from('defects').select('id, title, s_level, classification, status, duplicate_of, work_state').eq('project_id', projectId).order('created_at', { ascending: true }).limit(200),
    qa.from('release_candidates').select('id, version, status, commit_ref, artifact_sha256, rollback_plan, observability_notes, config_version').eq('project_id', projectId).order('version', { ascending: false }).limit(1),
    projects.rpc('phase_readiness', { p_project_id: projectId, p_phase: 6 }),
    projects.from('phase_six_handoffs').select('id, commit_ref, production_deployed').eq('project_id', projectId).maybeSingle(),
    projects.rpc('phase_seven_candidate_current', { p_project_id: projectId }),
    qa.from('qa_clarifications').select('id, question, status, answer').eq('project_id', projectId).order('created_at', { ascending: true }).limit(50),
    qa.from('performance_budgets').select('metric, target, unit, lower_is_better').eq('project_id', projectId).limit(50),
    qa.from('metric_results').select('metric, value, unit, created_at, test_runs!inner(project_id)').eq('test_runs.project_id', projectId).order('created_at', { ascending: false }).limit(200),
    qa.from('device_configurations').select('name, platform, status, reason').eq('organization_id', ((ws as Row | null)?.organization_id as string | undefined) ?? '00000000-0000-0000-0000-000000000000').order('name', { ascending: true }).limit(60),
  ]);
  if (m3Error) unreadable('readPhaseSixOverview.m3', m3Error);
  if (m4Error) unreadable('readPhaseSixOverview.m4', m4Error);
  if (gate7Error) unreadable('readPhaseSixOverview.phaseSevenGate', gate7Error);
  if (intakeError) unreadable('readPhaseSixOverview.intake', intakeError);
  if (planError) unreadable('readPhaseSixOverview.plan', planError);
  if (defectError) unreadable('readPhaseSixOverview.defects', defectError);
  if (candError) unreadable('readPhaseSixOverview.candidate', candError);
  if (completionError) unreadable('readPhaseSixOverview.completion', completionError);
  if (handoffError) unreadable('readPhaseSixOverview.phaseSevenIntake', handoffError);
  if (currentError) unreadable('readPhaseSixOverview.candidateCurrent', currentError);
  if (clarError) unreadable('readPhaseSixOverview.clarifications', clarError);
  if (budgetError) unreadable('readPhaseSixOverview.performanceBudgets', budgetError);
  if (metricError) unreadable('readPhaseSixOverview.metrics', metricError);
  if (deviceError) unreadable('readPhaseSixOverview.devices', deviceError);

  let plan: PhaseSixOverview['plan'] = null;
  let jobs: PhaseSixOverview['jobs'] = [];
  const planRow = rows(planRows)[0] ?? null;
  if (planRow) {
    const planId = String(planRow.id);
    const [{ data: riskRows, error: riskError }, { data: caseRows, error: caseError }, { data: problemRows, error: problemError }, { data: jobRows, error: jobError }] = await Promise.all([
      qa.from('risk_items').select('area, kind, level, depth').eq('plan_id', planId).order('created_at', { ascending: true }).limit(100),
      qa.from('phase6_cases').select('id, title, category, priority, status, journey').eq('plan_id', planId).order('created_at', { ascending: true }).limit(500),
      qa.rpc('plan_problems', { p_plan_id: planId }),
      qa.from('qa_jobs').select('category, specialist, execution_mode, status, reason, depends_on').eq('plan_id', planId).order('created_at', { ascending: true }).limit(20),
    ]);
    if (riskError) unreadable('readPhaseSixOverview.risks', riskError);
    if (caseError) unreadable('readPhaseSixOverview.cases', caseError);
    if (problemError) unreadable('readPhaseSixOverview.planProblems', problemError);
    if (jobError) unreadable('readPhaseSixOverview.jobs', jobError);
    jobs = rows(jobRows).map((j) => ({ category: String(j.category), specialist: String(j.specialist), mode: String(j.execution_mode), status: String(j.status), reason: String(j.reason), dependsOn: (j.depends_on as string[] | null) ?? [] }));
    plan = {
      id: planId,
      version: Number(planRow.version),
      status: String(planRow.status),
      categories: (planRow.required_categories as string[] | null) ?? [],
      journeys: (planRow.critical_journeys as string[] | null) ?? [],
      problems: rows(problemRows).map((r) => String(r.problem)),
      risks: rows(riskRows).map((r) => ({ area: String(r.area), kind: String(r.kind), level: String(r.level), depth: String(r.depth) })),
      cases: rows(caseRows).map((c) => ({ id: String(c.id), title: String(c.title), category: String(c.category), priority: String(c.priority), status: String(c.status), journey: str(c.journey) })),
    };
  }

  let candidate: PhaseSixOverview['candidate'] = null;
  const candRow = rows(candRows)[0] ?? null;
  if (candRow) {
    const cid = String(candRow.id);
    const [{ data: catRows, error: catError }, { data: gateRows, error: gateError }, { data: excRows, error: excError }, { data: assessRows, error: assessError }, { data: reviewRows, error: reviewError }] = await Promise.all([
      qa.from('category_results').select('category, status, commit_ref').eq('candidate_id', cid).limit(20),
      qa.rpc('evaluate_hard_gates', { p_candidate_id: cid }),
      qa.from('release_exceptions').select('id, gate, status, expires_at, owner').eq('candidate_id', cid).order('created_at', { ascending: true }).limit(20),
      qa.from('readiness_assessments').select('score, band, result').eq('candidate_id', cid).order('evaluated_at', { ascending: false }).limit(1),
      qa.from('admin_qa_reviews').select('decision, note, decided_at').eq('candidate_id', cid).order('decided_at', { ascending: true }).limit(20),
    ]);
    if (catError) unreadable('readPhaseSixOverview.categories', catError);
    if (gateError) unreadable('readPhaseSixOverview.gates', gateError);
    if (excError) unreadable('readPhaseSixOverview.exceptions', excError);
    if (assessError) unreadable('readPhaseSixOverview.assessment', assessError);
    if (reviewError) unreadable('readPhaseSixOverview.reviews', reviewError);
    const a = rows(assessRows)[0] ?? null;
    candidate = {
      id: cid,
      version: Number(candRow.version),
      status: String(candRow.status),
      commit: String(candRow.commit_ref),
      artifactSha256: String(candRow.artifact_sha256),
      rollbackPlan: str(candRow.rollback_plan),
      observability: str(candRow.observability_notes),
      configVersion: str(candRow.config_version),
      categories: rows(catRows).map((r) => ({ category: String(r.category), status: String(r.status), commit: String(r.commit_ref) })),
      gates: rows(gateRows).map((g) => ({ gate: String(g.gate), passed: g.passed === true, exceptioned: g.exceptioned === true, satisfied: g.satisfied === true, detail: String(g.detail) })),
      exceptions: rows(excRows).map((e) => ({ id: String(e.id), gate: String(e.gate), status: String(e.status), expiresAt: String(e.expires_at), owner: String(e.owner) })),
      assessment: a ? { score: Number(a.score), band: String(a.band), result: String(a.result) } : null,
      reviews: rows(reviewRows).map((r) => ({ decision: String(r.decision), note: str(r.note), decidedAt: String(r.decided_at) })),
    };
  }

  const w = ws as Row | null;
  const intake = intakeRow as Row | null;
  const done = first(completion);
  const handoff = handoffRow as Row | null;
  const gate7row = first(gate7);
  return {
    workspace: w ? { id: String(w.id), state: String(w.state), blockedReason: str(w.blocked_reason) } : null,
    gates: { m3VerifiedPaid: m3 === true, m4VerifiedPaid: m4 === true, phaseSevenGate: str(gate7row?.outcome) },
    intake: intake
      ? {
          status: String(intake.status),
          commit: String(intake.commit_ref),
          artifactSha256: str(intake.artifact_sha256),
          platforms: (intake.supported_platforms as string[] | null) ?? [],
          changeRequests: rows(intake.change_request_history).length,
          blockers: rows(intake.blockers).map((b) => ({ type: String(b.type), owner: String(b.owner), resumeCondition: String(b.resumeCondition), detail: String(b.detail) })),
          external: rows(intake.external_dependencies).map((e) => ({ name: String(e.name), detail: String(e.detail) })),
        }
      : null,
    plan,
    defects: rows(defectRows)
      .filter((d) => d.status !== undefined)
      .map((d) => ({ id: String(d.id), title: String(d.title), sLevel: num(d.s_level), classification: String(d.classification), status: String(d.status), duplicateOf: str(d.duplicate_of), workState: String(d.work_state ?? 'triage') })),
    jobs,
    candidateCurrent: currentRaw === true,
    contracts: rows(intake?.api_contract_refs).map((c) => ({ name: String(c.name), ref: String(c.ref) })),
    clarifications: rows(clarRows).map((c) => ({ id: String(c.id), question: String(c.question), status: String(c.status), answer: str(c.answer) })),
    performance: rows(budgetRows).map((b) => {
      const latest = rows(metricRows).find((m) => m.metric === b.metric);
      const value = latest ? Number(latest.value) : null;
      const target = Number(b.target);
      const lower = b.lower_is_better === true;
      return { metric: String(b.metric), target, unit: String(b.unit), lowerIsBetter: lower, latest: value, ok: value === null ? null : lower ? value <= target : value >= target };
    }),
    devices: rows(deviceRows).map((d) => ({ name: String(d.name), platform: String(d.platform), status: String(d.status), reason: str(d.reason) })),
    compatibilityMatrix: (planRow?.compatibility_matrix as unknown[] | null) ?? [],
    candidate,
    completion: done ? { outcome: String(done.outcome), missing: (done.missing as string[] | null) ?? [] } : null,
    phaseSevenIntake: handoff ? { id: String(handoff.id), commit: String(handoff.commit_ref), productionDeployed: handoff.production_deployed === true } : null,
  };
}
