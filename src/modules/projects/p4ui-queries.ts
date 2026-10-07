import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { nextBuildGate, nextUiGate } from './p4ui';

/**
 * What staff see of the Phase 4 UI Designer and Prototype records (UID section 18, PROTO section 13), from the STORED rows, scoped by RLS to the caller's
 * organization. Nothing here computes a verdict: coverage, completeness and the requirement trace are database functions, and a failed read is surfaced,
 * never rendered as an empty list.
 */

type Row = Record<string, unknown>;
type Answer<T> = PromiseLike<{ data: T; error: { message: string } | null }>;
type Query = Answer<Row[] | null> & {
  select(columns: string): Query;
  eq(column: string, value: unknown): Query;
  in(column: string, values: unknown[]): Query;
  order(column: string, options?: { ascending: boolean }): Query;
  limit(n: number): Query;
  maybeSingle(): Answer<Row | null>;
};
type Loose = { schema(name: string): { from(table: string): Query; rpc(fn: string, args: Record<string, unknown>): Answer<unknown> } };

const s = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export type P4uiDesignVersion = {
  id: string;
  version: number;
  status: string;
  nextGate: string;
  parentVersion: number | null;
  activationReason: string | null;
  origin: string | null;
  changedScreens: string[];
  addedScreens: string[];
  removedScreens: string[];
  changeSummary: string | null;
  scopeVersion: number | null;
  figmaState: string | null;
  figmaWriteState: string | null;
  figmaFileRef: string | null;
};

export type P4uiDesignView = {
  versions: P4uiDesignVersion[];
  current: P4uiDesignVersion | null;
  owner: string | null;
  baseline: { handoffId: string; lockedAt: string | null; screens: number } | null;
  jobs: Array<{ id: string; status: string; reason: string | null; refusedTrigger: string | null; routeTo: string | null; refusalReason: string | null; createdAt: string }>;
  blockers: Array<{ id: string; kind: string; owner: string; reason: string; resumeCondition: string; stopsPhase: boolean }>;
  defects: Array<{ id: string; screenKey: string | null; category: string; description: string; severity: string; status: string }>;
  completeness: Array<{ screenKey: string; hasSpec: boolean; missingStates: string[]; missingVariants: string[] }> | null;
  trace: { orphanScreens: string[]; uncoveredRequirements: string[] } | null;
  coverageGaps: { missingScreens: string[]; stateGaps: Array<{ screenKey: string; state: string }> } | null;
  postLockRequests: Array<{ id: string; kind: string; reason: string; status: string }>;
  prototypeIssues: Array<{ id: string; screenKey: string | null; description: string; classification: string; status: string }>;
  feedbackRoutes: Array<{ id: string; uiVersionId: string; classification: string; route: string; reasoning: string }>;
};

export async function loadP4uiDesignView(projectId: string): Promise<P4uiDesignView> {
  await requireInternal();
  const supabase = (await createClient()) as unknown as Loose;
  const db = supabase.schema('projects');

  const { data: versionRows, error: vErr } = await db
    .from('ui_versions')
    .select('id, version, status, source_phase_three_handoff_id, produced_by, screens')
    .eq('project_id', projectId)
    .order('version', { ascending: true });
  if (vErr) unreadable('loadP4uiDesignView.versions', vErr);
  const rows = versionRows ?? [];

  const { data: metaRows, error: mErr } = await db
    .from('p4ui_version_meta')
    .select('ui_version_id, parent_ui_version_id, activation_reason, origin, changed_screens, added_screens, removed_screens, change_summary, scope_version, figma_state, figma_write_state, figma_file_ref')
    .eq('project_id', projectId);
  if (mErr) unreadable('loadP4uiDesignView.meta', mErr);
  const meta = new Map((metaRows ?? []).map((m) => [String(m.ui_version_id), m]));
  const versionOf = new Map(rows.map((r) => [String(r.id), Number(r.version)]));

  const versions: P4uiDesignVersion[] = rows.map((r) => {
    const m = meta.get(String(r.id));
    return {
      id: String(r.id),
      version: Number(r.version),
      status: String(r.status),
      nextGate: nextUiGate(String(r.status)),
      parentVersion: m?.parent_ui_version_id ? (versionOf.get(String(m.parent_ui_version_id)) ?? null) : null,
      activationReason: s(m?.activation_reason),
      origin: s(m?.origin),
      changedScreens: arr(m?.changed_screens),
      addedScreens: arr(m?.added_screens),
      removedScreens: arr(m?.removed_screens),
      changeSummary: s(m?.change_summary),
      scopeVersion: typeof m?.scope_version === 'number' ? m.scope_version : null,
      figmaState: s(m?.figma_state),
      figmaWriteState: s(m?.figma_write_state),
      figmaFileRef: s(m?.figma_file_ref),
    };
  });
  const current = versions.length > 0 ? (versions[versions.length - 1] ?? null) : null;
  const latestRow = rows.length > 0 ? rows[rows.length - 1] : undefined;

  let baseline: P4uiDesignView['baseline'] = null;
  if (latestRow?.source_phase_three_handoff_id) {
    const { data: h, error: hErr } = await db
      .from('phase_three_handoffs')
      .select('id, locked_at, payload')
      .eq('id', String(latestRow.source_phase_three_handoff_id))
      .maybeSingle();
    if (hErr) unreadable('loadP4uiDesignView.baseline', hErr);
    if (h) {
      const payload = h.payload as { screenBaseline?: { screens?: unknown[] } } | null;
      baseline = { handoffId: String(h.id), lockedAt: s(h.locked_at), screens: payload?.screenBaseline?.screens?.length ?? 0 };
    }
  }

  const { data: jobRows, error: jErr } = await db
    .from('p4ui_design_jobs')
    .select('id, status, activation_reason, refused_trigger, route_to, refusal_reason, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(30);
  if (jErr) unreadable('loadP4uiDesignView.jobs', jErr);

  const { data: blockerRows, error: bErr } = await db
    .from('p4ui_design_blockers')
    .select('id, kind, owner_role, reason, resume_condition, stops_phase')
    .eq('project_id', projectId)
    .eq('status', 'open');
  if (bErr) unreadable('loadP4uiDesignView.blockers', bErr);

  const { data: defectRows, error: dErr } = await db
    .from('p4ui_qa_defects')
    .select('id, screen_key, category, description, severity, status')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true });
  if (dErr) unreadable('loadP4uiDesignView.defects', dErr);

  const { data: plRows, error: plErr } = await db.from('p4ui_post_lock_requests').select('id, kind, reason, status').eq('project_id', projectId).order('created_at', { ascending: false });
  if (plErr) unreadable('loadP4uiDesignView.postLock', plErr);

  const { data: issueRows, error: iErr } = await db
    .from('p4ui_prototype_design_issues')
    .select('id, screen_key, description, classification, status')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  if (iErr) unreadable('loadP4uiDesignView.issues', iErr);

  const { data: routeRows, error: rErr } = await db.from('p4ui_feedback_routes').select('id, ui_version_id, classification, route, reasoning').eq('project_id', projectId).order('created_at', { ascending: false });
  if (rErr) unreadable('loadP4uiDesignView.routes', rErr);

  let completeness: P4uiDesignView['completeness'] = null;
  let trace: P4uiDesignView['trace'] = null;
  let coverageGaps: P4uiDesignView['coverageGaps'] = null;
  if (current) {
    const [comp, tr, gaps] = await Promise.all([
      db.rpc('p4ui_design_completeness', { p_ui_version_id: current.id }),
      db.rpc('p4ui_requirement_trace', { p_ui_version_id: current.id }),
      db.rpc('p4ui_coverage_gaps', { p_ui_version_id: current.id }),
    ]);
    if (comp.error) unreadable('loadP4uiDesignView.completeness', comp.error);
    if (tr.error) unreadable('loadP4uiDesignView.trace', tr.error);
    if (gaps.error) unreadable('loadP4uiDesignView.gaps', gaps.error);
    const c = comp.data as { screens?: Array<Record<string, unknown>> } | null;
    completeness = (c?.screens ?? []).map((x) => ({ screenKey: String(x.screenKey), hasSpec: x.hasSpec === true, missingStates: arr(x.missingStates), missingVariants: arr(x.missingVariants) }));
    const t = tr.data as { orphanScreens?: unknown; uncoveredRequirements?: unknown } | null;
    trace = { orphanScreens: arr(t?.orphanScreens), uncoveredRequirements: arr(t?.uncoveredRequirements) };
    const g = gaps.data as { missingScreens?: unknown; stateGaps?: Array<{ screenKey?: string; state?: string }> } | null;
    coverageGaps = { missingScreens: arr(g?.missingScreens), stateGaps: (g?.stateGaps ?? []).map((x) => ({ screenKey: String(x.screenKey), state: String(x.state) })) };
  }

  // the owner of the current version: the person who produced it, or the Designer agent when the AI workflow did
  const owner = latestRow ? (latestRow.produced_by ? 'a named person' : 'the UI Designer agent') : null;

  return {
    versions,
    current,
    owner,
    baseline,
    jobs: (jobRows ?? []).map((j) => ({ id: String(j.id), status: String(j.status), reason: s(j.activation_reason), refusedTrigger: s(j.refused_trigger), routeTo: s(j.route_to), refusalReason: s(j.refusal_reason), createdAt: String(j.created_at) })),
    blockers: (blockerRows ?? []).map((b) => ({ id: String(b.id), kind: String(b.kind), owner: String(b.owner_role), reason: String(b.reason), resumeCondition: String(b.resume_condition), stopsPhase: b.stops_phase === true })),
    defects: (defectRows ?? []).map((d) => ({ id: String(d.id), screenKey: s(d.screen_key), category: String(d.category), description: String(d.description), severity: String(d.severity), status: String(d.status) })),
    completeness,
    trace,
    coverageGaps,
    postLockRequests: (plRows ?? []).map((p) => ({ id: String(p.id), kind: String(p.kind), reason: String(p.reason), status: String(p.status) })),
    prototypeIssues: (issueRows ?? []).map((i) => ({ id: String(i.id), screenKey: s(i.screen_key), description: String(i.description), classification: String(i.classification), status: String(i.status) })),
    feedbackRoutes: (routeRows ?? []).map((r) => ({ id: String(r.id), uiVersionId: String(r.ui_version_id), classification: String(r.classification), route: String(r.route), reasoning: String(r.reasoning) })),
  };
}

// ═══ Prototype ═════════════════════════════════════════════════════════════
export type P4uiBuild = {
  id: string;
  buildNumber: number;
  status: string;
  nextGate: string;
  platform: string | null;
  buildMode: string;
  environment: string;
  uiVersion: number | null;
  revisionOf: number | null;
  limitations: string[];
  simulatedIntegrations: string[];
  failureReason: string | null;
  designSourceState: string;
};

export type P4uiPrototypeView = {
  builds: P4uiBuild[];
  current: P4uiBuild | null;
  coverage: Array<{ screenKey: string; coverage: string; detail: string | null }>;
  blockers: Array<{ id: string; buildNumber: number | null; kind: string; external: boolean; owner: string; reason: string; resumeCondition: string }>;
  artifacts: Array<{ kind: string; uploadStatus: string; storageRef: string | null; sha256: string | null; failureReason: string | null }>;
  testData: Array<{ name: string; edgeCase: boolean }>;
  revisions: Array<{ fromBuild: number | null; toBuild: number | null; origin: string; summary: string }>;
  hasQaHandoff: boolean;
  shareEligibility: { eligible: boolean; reasons: string[] } | null;
  feedbackRoutes: Array<{ id: string; classification: string; route: string; reasoning: string }>;
};

export async function loadP4uiPrototypeView(projectId: string): Promise<P4uiPrototypeView> {
  await requireInternal();
  const db = ((await createClient()) as unknown as Loose).schema('projects');

  const { data: buildRows, error: bErr } = await db
    .from('p4ui_prototype_builds')
    .select('id, build_number, status, platform, build_mode, environment, ui_version_id, revision_of_build_id, limitations, simulated_integrations, failure_reason, design_source_state')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true });
  if (bErr) unreadable('loadP4uiPrototypeView.builds', bErr);
  const rows = buildRows ?? [];

  const uiIds = [...new Set(rows.map((r) => String(r.ui_version_id)))];
  const uiVersionOf = new Map<string, number>();
  if (uiIds.length > 0) {
    const { data: uiRows, error: uErr } = await db.from('ui_versions').select('id, version').in('id', uiIds);
    if (uErr) unreadable('loadP4uiPrototypeView.uiVersions', uErr);
    for (const u of uiRows ?? []) uiVersionOf.set(String(u.id), Number(u.version));
  }
  const numberOf = new Map(rows.map((r) => [String(r.id), Number(r.build_number)]));

  const builds: P4uiBuild[] = rows.map((r) => ({
    id: String(r.id),
    buildNumber: Number(r.build_number),
    status: String(r.status),
    nextGate: nextBuildGate(String(r.status)),
    platform: s(r.platform),
    buildMode: String(r.build_mode),
    environment: String(r.environment),
    uiVersion: uiVersionOf.get(String(r.ui_version_id)) ?? null,
    revisionOf: r.revision_of_build_id ? (numberOf.get(String(r.revision_of_build_id)) ?? null) : null,
    limitations: arr(r.limitations),
    simulatedIntegrations: arr(r.simulated_integrations),
    failureReason: s(r.failure_reason),
    designSourceState: String(r.design_source_state),
  }));
  const current = builds.length > 0 ? (builds[builds.length - 1] ?? null) : null;

  const { data: blockerRows, error: kErr } = await db
    .from('p4ui_prototype_blockers')
    .select('id, build_id, kind, external, owner_role, reason, resume_condition')
    .eq('project_id', projectId)
    .eq('status', 'open');
  if (kErr) unreadable('loadP4uiPrototypeView.blockers', kErr);

  const { data: revRows, error: rvErr } = await db
    .from('p4ui_prototype_revisions')
    .select('from_build_id, to_build_id, origin, summary')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true });
  if (rvErr) unreadable('loadP4uiPrototypeView.revisions', rvErr);

  const { data: routeRows, error: rtErr } = await db
    .from('p4ui_prototype_feedback_routes')
    .select('id, classification, route, reasoning')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  if (rtErr) unreadable('loadP4uiPrototypeView.routes', rtErr);

  let coverage: P4uiPrototypeView['coverage'] = [];
  let artifacts: P4uiPrototypeView['artifacts'] = [];
  let testData: P4uiPrototypeView['testData'] = [];
  let hasQaHandoff = false;
  let shareEligibility: P4uiPrototypeView['shareEligibility'] = null;
  if (current) {
    const { data: cov, error: cErr } = await db.from('p4ui_route_coverage').select('screen_key, coverage, detail').eq('build_id', current.id).order('screen_key', { ascending: true });
    if (cErr) unreadable('loadP4uiPrototypeView.coverage', cErr);
    coverage = (cov ?? []).map((c) => ({ screenKey: String(c.screen_key), coverage: String(c.coverage), detail: s(c.detail) }));

    const { data: art, error: aErr } = await db.from('p4ui_artifact_records').select('kind, upload_status, storage_ref, sha256, failure_reason').eq('build_id', current.id).order('created_at', { ascending: true });
    if (aErr) unreadable('loadP4uiPrototypeView.artifacts', aErr);
    artifacts = (art ?? []).map((a) => ({ kind: String(a.kind), uploadStatus: String(a.upload_status), storageRef: s(a.storage_ref), sha256: s(a.sha256), failureReason: s(a.failure_reason) }));

    const { data: td, error: tErr } = await db.from('p4ui_test_data').select('name, edge_case').eq('build_id', current.id).order('name', { ascending: true });
    if (tErr) unreadable('loadP4uiPrototypeView.testData', tErr);
    testData = (td ?? []).map((t) => ({ name: String(t.name), edgeCase: t.edge_case === true }));

    const { data: ho, error: hErr } = await db.from('p4ui_qa_handoffs').select('id').eq('build_id', current.id).maybeSingle();
    if (hErr) unreadable('loadP4uiPrototypeView.handoff', hErr);
    hasQaHandoff = Boolean(ho);

    const elig = await db.rpc('p4ui_build_share_eligibility', { p_build_id: current.id });
    if (elig.error) unreadable('loadP4uiPrototypeView.eligibility', elig.error);
    const e = (Array.isArray(elig.data) ? elig.data[0] : elig.data) as { eligible?: boolean; reasons?: unknown } | undefined;
    shareEligibility = e ? { eligible: e.eligible === true, reasons: arr(e.reasons) } : null;
  }

  return {
    builds,
    current,
    coverage,
    blockers: (blockerRows ?? []).map((k) => ({
      id: String(k.id),
      buildNumber: k.build_id ? (numberOf.get(String(k.build_id)) ?? null) : null,
      kind: String(k.kind),
      external: k.external === true,
      owner: String(k.owner_role),
      reason: String(k.reason),
      resumeCondition: String(k.resume_condition),
    })),
    artifacts,
    testData,
    revisions: (revRows ?? []).map((r) => ({ fromBuild: numberOf.get(String(r.from_build_id)) ?? null, toBuild: numberOf.get(String(r.to_build_id)) ?? null, origin: String(r.origin), summary: String(r.summary) })),
    hasQaHandoff,
    shareEligibility,
    feedbackRoutes: (routeRows ?? []).map((r) => ({ id: String(r.id), classification: String(r.classification), route: String(r.route), reasoning: String(r.reasoning) })),
  };
}
