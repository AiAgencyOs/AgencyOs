import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * The Phase 5 Overview - Phase 5 master flow; the Admin Panel's "what is current, what is blocked, who approved what, can Phase 6 start?"
 * answered from the stored state in one read, never re-derived here. Every read is guarded (G-054): a failed read is `unreadable`, never
 * rendered as "nothing yet", because a phase can genuinely have a baseline and no build, or a build and no review, and an empty table on a
 * failed read would state something this function does not know.
 */

export type PhaseFiveBuildRow = {
  deliverableId: string;
  version: number;
  status: string;
  commitRef: string | null;
  buildNumber: string | null;
  targetEnv: string | null;
  qaStatus: string | null;
  adminStatus: string | null;
  reviewVerdict: string | null;
  artifactUrl: string | null;
};

export type PhaseFiveOverview = {
  workspace: { id: string; state: string; blockedReason: string | null; startedAt: string; completedAt: string | null } | null;
  gates: { m2VerifiedPaid: boolean; m3VerifiedPaid: boolean };
  baseline: {
    uiVersion: number | null;
    prototypeVersion: number | null;
    scopeVersion: number | null;
    repository: string | null;
    baseCommit: string | null;
    lockedAt: string;
  } | null;
  readiness: { outcome: string; missing: string[] } | null;
  phaseSixMissing: string[];
  builds: PhaseFiveBuildRow[];
  defects: { unresolved: number; verified: number; total: number };
  feedback: { id: string; words: string; classification: string | null; state: string; defectId: string | null; changeRequestId: string | null }[];
  integrations: { id: string; kind: string; name: string; health: string; isMock: boolean }[];
  agentStates: { agentKey: string; state: string; reason: string | null }[];
  handoff: { id: string; commit: string; createdAt: string } | null;
};

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

export async function readPhaseFiveOverview(projectId: string): Promise<PhaseFiveOverview> {
  const supabase = await createClient();
  const projects = supabase.schema('projects');

  const { data: workspace, error: workspaceError } = await projects
    .from('phase_five')
    .select('id, state, blocked_reason, started_at, completed_at')
    .eq('project_id', projectId)
    .maybeSingle();
  if (workspaceError) unreadable('readPhaseFiveOverview.workspace', workspaceError);

  const [
    { data: m2, error: m2Error },
    { data: m3, error: m3Error },
    { data: readinessRows, error: readinessError },
    { data: phaseSixRows, error: phaseSixError },
    { data: buildRows, error: buildError },
    { data: defectRows, error: defectError },
    { data: feedbackRows, error: feedbackError },
    { data: integrationRows, error: integrationError },
    { data: handoffRow, error: handoffError },
  ] = await Promise.all([
    projects.rpc('m2_verified_paid', { p_project_id: projectId }),
    projects.rpc('m3_verified_paid', { p_project_id: projectId }),
    projects.rpc('phase_readiness', { p_project_id: projectId, p_phase: 5 }),
    projects.rpc('phase_readiness', { p_project_id: projectId, p_phase: 6 }),
    projects.from('deliverables').select('id, version, status, artifact_url').eq('project_id', projectId).eq('kind', 'build').order('version', { ascending: true }),
    supabase.schema('qa').from('defects').select('status').eq('project_id', projectId),
    projects.from('build_feedback').select('id, client_words, classification, state, defect_id, change_request_id').eq('project_id', projectId).order('created_at', { ascending: true }),
    projects.from('integration_connections').select('id, kind, name, health, is_mock').eq('project_id', projectId).order('kind', { ascending: true }),
    projects.from('phase_five_handoffs').select('id, final_commit_ref, created_at').eq('project_id', projectId).maybeSingle(),
  ]);
  if (m2Error) unreadable('readPhaseFiveOverview.m2', m2Error);
  if (m3Error) unreadable('readPhaseFiveOverview.m3', m3Error);
  if (readinessError) unreadable('readPhaseFiveOverview.readiness', readinessError);
  if (phaseSixError) unreadable('readPhaseFiveOverview.phaseSixReadiness', phaseSixError);
  if (buildError) unreadable('readPhaseFiveOverview.builds', buildError);
  if (defectError) unreadable('readPhaseFiveOverview.defects', defectError);
  if (feedbackError) unreadable('readPhaseFiveOverview.feedback', feedbackError);
  if (integrationError) unreadable('readPhaseFiveOverview.integrations', integrationError);
  if (handoffError) unreadable('readPhaseFiveOverview.handoff', handoffError);

  const builds = (buildRows ?? []) as Row[];
  const buildIds = builds.map((b) => String(b.id));

  const [{ data: detailRows, error: detailError }, reviewResults] = await Promise.all([
    buildIds.length === 0
      ? Promise.resolve({ data: [] as Row[], error: null })
      : projects.from('deliverable_details').select('deliverable_id, commit_ref, build_number, target_env, qa_status, admin_status').in('deliverable_id', buildIds),
    Promise.all(buildIds.map((id) => projects.rpc('build_review_status', { p_deliverable_id: id }))),
  ]);
  if (detailError) unreadable('readPhaseFiveOverview.buildDetails', detailError);
  for (const result of reviewResults) {
    if (result.error) unreadable('readPhaseFiveOverview.reviewStatus', result.error);
  }

  const details = new Map(((detailRows ?? []) as Row[]).map((d) => [String(d.deliverable_id), d]));
  const reviewVerdict = new Map<string, string | null>();
  buildIds.forEach((id, i) => {
    const r = reviewResults[i]?.data as Row | Row[] | null | undefined;
    const row = Array.isArray(r) ? r[0] : r;
    reviewVerdict.set(id, str(row?.verdict));
  });

  let baseline: PhaseFiveOverview['baseline'] = null;
  let agentStates: PhaseFiveOverview['agentStates'] = [];
  if (workspace) {
    const [{ data: base, error: baseError }, { data: states, error: statesError }] = await Promise.all([
      projects
        .from('development_baselines')
        .select('base_commit, locked_at, ui_versions(version), scope_versions(version), prototype_deliverable:deliverables!development_baselines_prototype_deliverable_id_fkey(version), repositories(name)')
        .eq('phase_five_id', workspace.id)
        .maybeSingle(),
      projects.from('phase_five_agent_state').select('agent_key, state, reason').eq('phase_five_id', workspace.id).order('agent_key', { ascending: true }),
    ]);
    if (baseError) unreadable('readPhaseFiveOverview.baseline', baseError);
    if (statesError) unreadable('readPhaseFiveOverview.agentStates', statesError);
    const b = base as Row | null;
    if (b) {
      const one = (v: unknown): Row | null => (Array.isArray(v) ? ((v[0] as Row | undefined) ?? null) : ((v as Row | null) ?? null));
      baseline = {
        uiVersion: num(one(b.ui_versions)?.version),
        prototypeVersion: num(one(b.prototype_deliverable)?.version),
        scopeVersion: num(one(b.scope_versions)?.version),
        repository: str(one(b.repositories)?.name),
        baseCommit: str(b.base_commit),
        lockedAt: String(b.locked_at),
      };
    }
    agentStates = ((states ?? []) as Row[]).map((s) => ({ agentKey: String(s.agent_key), state: String(s.state), reason: str(s.reason) }));
  }

  const readiness = (Array.isArray(readinessRows) ? readinessRows[0] : readinessRows) as Row | null | undefined;
  const phaseSix = (Array.isArray(phaseSixRows) ? phaseSixRows[0] : phaseSixRows) as Row | null | undefined;
  const defectList = (defectRows ?? []) as Row[];
  const handoff = handoffRow as Row | null;

  return {
    workspace: workspace
      ? {
          id: workspace.id,
          state: workspace.state,
          blockedReason: workspace.blocked_reason,
          startedAt: workspace.started_at,
          completedAt: workspace.completed_at,
        }
      : null,
    gates: { m2VerifiedPaid: m2 === true, m3VerifiedPaid: m3 === true },
    baseline,
    readiness: readiness ? { outcome: String(readiness.outcome), missing: (readiness.missing as string[] | null) ?? [] } : null,
    phaseSixMissing: ((phaseSix?.missing as string[] | null) ?? []),
    builds: builds.map((b) => {
      const id = String(b.id);
      const d = details.get(id);
      return {
        deliverableId: id,
        version: Number(b.version),
        status: String(b.status),
        commitRef: str(d?.commit_ref),
        buildNumber: str(d?.build_number),
        targetEnv: str(d?.target_env),
        qaStatus: str(d?.qa_status),
        adminStatus: str(d?.admin_status),
        reviewVerdict: reviewVerdict.get(id) ?? null,
        artifactUrl: str(b.artifact_url),
      };
    }),
    defects: {
      total: defectList.length,
      verified: defectList.filter((d) => d.status === 'verified').length,
      unresolved: defectList.filter((d) => ['open', 'fixed', 'needs_evidence', 'not_reproduced'].includes(String(d.status))).length,
    },
    feedback: ((feedbackRows ?? []) as Row[]).map((f) => ({
      id: String(f.id),
      words: String(f.client_words),
      classification: str(f.classification),
      state: String(f.state),
      defectId: str(f.defect_id),
      changeRequestId: str(f.change_request_id),
    })),
    integrations: ((integrationRows ?? []) as Row[]).map((i) => ({
      id: String(i.id),
      kind: String(i.kind),
      name: String(i.name),
      health: String(i.health),
      isMock: i.is_mock === true,
    })),
    agentStates,
    handoff: handoff ? { id: String(handoff.id), commit: String(handoff.final_commit_ref), createdAt: String(handoff.created_at) } : null,
  };
}
