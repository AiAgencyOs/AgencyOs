import { z } from 'zod';

import { decoderSafeSchema } from '@/lib/ai/schema';

/**
 * Phase 4 UI Designer and Prototype gap work (docs/phase-4-ui-prototype-gaps-log.md; migrations 20261125000000 and 20261125100000).
 *
 * Three jobs, all with the model injected so the order of events, the refusals and the writes are provable against a stand-in without a funded model:
 *
 *   detailUiVersion        the UI Designer's per-screen specification of a drafted UI version, then its derived lineage. Draws nothing, claims nothing in
 *                          Figma, never touches Design QA, Admin review or the client gates.
 *   planPrototypeBuild     the Prototype Agent's build plan for a LOCKED UI version, recorded before review, then input validation (which may block).
 *   attachBuiltPrototype   deterministic (no model): the artifact the existing build workflow produced is attached to its planned build, which runs its own
 *                          coverage self-check, then the QA handoff package is assembled. A failed self-check is a FAILED build, never BUILD_READY.
 *
 * Nothing here approves, verifies or submits anything: those are other doors with their own gates.
 */

// ── vocabularies (the database CHECKs are the authority; these mirror them for the schema the model must answer in) ──
export const P4UI_SCREEN_STATES = [
  'default', 'empty', 'loading', 'error', 'success', 'hover', 'focus', 'disabled', 'selected',
  'validation_error', 'permission_denied', 'offline', 'overflow', 'partial', 'no_results', 'expired',
] as const;
export const P4UI_DEVICES = ['mobile', 'tablet', 'desktop', 'ios', 'android'] as const;
export const P4UI_PLATFORMS = ['web', 'ios', 'android', 'desktop', 'cross_platform'] as const;
export const P4UI_BUILD_MODES = ['in_app_preview', 'hosted_web', 'native_package'] as const;
export const P4UI_ENVIRONMENTS = ['review', 'staging', 'client_test', 'local'] as const;

const SCREEN_KEY = z.string().trim().regex(/^[a-z][a-z0-9_.-]{1,62}$/, 'A screen id is lower-case and stable');
const SHORT = z.string().trim().min(1).max(200);

export const p4uiScreenSpecsSchema = z
  .object({
    specs: z
      .array(
        z
          .object({
            screenKey: SCREEN_KEY,
            purpose: z.string().trim().min(1).max(500),
            entryPoints: z.array(SHORT).max(8),
            exitPoints: z.array(SHORT).max(8),
            dataShown: z.array(SHORT).max(12),
            actions: z.array(SHORT).max(12),
            validationRules: z.array(SHORT).max(12),
            states: z.array(z.enum(P4UI_SCREEN_STATES)).max(P4UI_SCREEN_STATES.length),
            responsiveVariants: z.array(z.enum(P4UI_DEVICES)).max(P4UI_DEVICES.length),
            roleVariants: z.array(z.object({ role: SHORT, differences: z.string().trim().min(1).max(300) }).strict()).max(6),
            tokensUsed: z.array(SHORT).max(12),
          })
          .strict(),
      )
      .min(1),
    changeSummary: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();
export type P4uiScreenSpecs = z.infer<typeof p4uiScreenSpecsSchema>;
export const p4uiScreenSpecsJsonSchema = (): Record<string, unknown> => decoderSafeSchema(z.toJSONSchema(p4uiScreenSpecsSchema)) as Record<string, unknown>;

export const p4uiPrototypePlanSchema = z
  .object({
    platform: z.enum(P4UI_PLATFORMS).nullable(),
    buildMode: z.enum(P4UI_BUILD_MODES),
    environment: z.enum(P4UI_ENVIRONMENTS),
    mockPolicy: z.enum(['static_mock', 'seeded_mock', 'none']),
    routes: z.array(z.object({ screenKey: SCREEN_KEY, route: z.string().trim().min(1).max(200) }).strict()).max(60),
    components: z.array(SHORT).max(60),
    mockSources: z.array(SHORT).max(20),
    interactions: z.array(z.object({ from: SCREEN_KEY, control: SHORT, to: SCREEN_KEY.nullable() }).strict()).max(120),
    criticalFlows: z.array(z.array(SCREEN_KEY).min(2).max(12)).max(12),
    exclusions: z.array(SHORT).max(20),
    requiredAssets: z
      .array(z.object({ name: SHORT, assetId: z.uuid().optional(), placeholderApproved: z.boolean().optional(), screens: z.array(SCREEN_KEY).max(20).optional() }).strict())
      .max(30),
    limitations: z.array(SHORT).min(1).max(20),
    simulatedIntegrations: z.array(SHORT).max(20),
    testInstructions: z.string().trim().min(1).max(2000),
    testData: z.array(z.object({ name: SHORT, purpose: SHORT.optional(), edgeCase: z.boolean(), payload: z.record(z.string(), z.unknown()) }).strict()).max(20),
  })
  .strict();
export type P4uiPrototypePlan = z.infer<typeof p4uiPrototypePlanSchema>;
export const p4uiPrototypePlanJsonSchema = (): Record<string, unknown> => decoderSafeSchema(z.toJSONSchema(p4uiPrototypePlanSchema)) as Record<string, unknown>;

export const P4UI_DETAIL_PROMPT = [
  'You specify, per screen, what a UI designer drew for a locked product baseline, and nothing else.',
  'You are given the drafted screens and the requirements each maps to. For every screen give its purpose, entry and exit points, the data it shows, its actions, its',
  'validation rules, the extra states it needs (hover, focus, disabled, offline, permission_denied, overflow and so on), the platform variants the scope requires',
  '(only those), role differences, and the design tokens it reuses. Never invent a screen, a feature or a token. Do not claim any of it exists in Figma.',
  'You are not reviewing, approving or locking anything: Design QA, an Admin and the client do that, in that order.',
].join(' ');

export const P4UI_PLAN_PROMPT = [
  'You plan a REVIEW prototype for a locked, client-approved UI version. You do not redecide the design and you do not build it in this step.',
  'Name the routes, components, mock data sources, interactions and critical flows; say what is deliberately excluded; list every asset the screens need and',
  'whether an approved placeholder stands in; state honestly what the prototype does NOT do (at least one limitation) and which integrations are only simulated.',
  'If the target platform or a credential is not given, answer null for the platform: never infer it. Never include a real credential, token or personal data in test data.',
  'Production logic, payments and backend behaviour are not part of a prototype: do not plan them.',
].join(' ');

// ── a loose admin client, so the order of events can be proved against a stand-in ──
type Row = Record<string, unknown>;
type Answer<T> = PromiseLike<{ data: T; error: { message: string } | null }>;
type Query = Answer<Row[] | null> & {
  select(columns: string): Query;
  eq(column: string, value: unknown): Query;
  order(column: string, options?: { ascending: boolean }): Query;
  limit(n: number): Query;
  maybeSingle(): Answer<Row | null>;
};
export type P4uiAdmin = {
  schema(name: string): { from(table: string): Query; rpc(fn: string, args: Record<string, unknown>): Answer<unknown> };
};
export type P4uiAsk = (prompt: string) => Promise<{ ok: true; json: unknown } | { ok: false; detail: string }>;

export type P4uiOutcome =
  | { status: 'done'; detail: string; data?: Record<string, unknown> }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string };

const firstRow = (data: unknown): Row | undefined => (Array.isArray(data) ? data[0] : data) as Row | undefined;
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** The next gate a UI version waits at (UID 18 "next gate"), from its status. Pure. */
export function nextUiGate(status: string): string {
  switch (status) {
    case 'draft': return 'Design QA';
    case 'qa_review': return 'Design QA';
    case 'qa_changes_required': return 'UI Designer fixes the QA defects';
    case 'qa_pass': return 'Admin review';
    case 'admin_review': return 'Admin review';
    case 'admin_edit': return 'UI Designer applies the Admin edit';
    case 'admin_approved': return 'PM shares the exact version with the client';
    case 'client_review': return 'Client decision';
    case 'client_change': return 'PM classifies the client feedback';
    case 'client_approved': return 'Lock the approved version';
    case 'locked': return 'Prototype build';
    default: return 'unknown';
  }
}

/** The next gate a prototype build waits at, from its status. Pure. */
export function nextBuildGate(status: string): string {
  switch (status) {
    case 'planned': return 'Input validation';
    case 'input_validation': return 'Input validation';
    case 'blocked': return 'A person resolves the open blocker';
    case 'building': return 'The artifact is attached and self-checked';
    case 'build_ready': return 'QA handoff, then Prototype QA';
    case 'failed': return 'Prototype Agent plans a corrected round';
    case 'qa_review': return 'Prototype QA';
    case 'qa_changes_required': return 'Prototype Agent fixes the QA defects';
    case 'qa_pass': return 'Admin review';
    case 'admin_approved': return 'PM submits the exact build to the client';
    case 'client_review': return 'Client decision';
    case 'changes_requested': return 'PM classifies the feedback';
    case 'locked': return 'Phase 5 reads this exact build';
    case 'superseded': return 'Superseded by a later round';
    default: return 'unknown';
  }
}

// ═══ detailUiVersion ═══════════════════════════════════════════════════════
export async function detailUiVersion(
  admin: P4uiAdmin,
  input: { organizationId: string; uiVersionId: string },
  ask: P4uiAsk,
): Promise<P4uiOutcome> {
  const projects = admin.schema('projects');
  const { data: version, error: vErr } = await projects
    .from('ui_versions')
    .select('id, phase_four_id, status, version, screens')
    .eq('id', input.uiVersionId)
    .eq('organization_id', input.organizationId)
    .maybeSingle();
  if (vErr) return { status: 'failed', reason: `could not read the UI version: ${vErr.message}` };
  if (!version) return { status: 'skipped', reason: 'the UI version no longer exists' };
  // a version past Design QA's first look is not rewritten under it: the lineage is still derived
  const screens = (Array.isArray(version.screens) ? version.screens : []) as Array<{ screenKey?: string }>;
  const keys = screens.map((s) => s.screenKey).filter((k): k is string => typeof k === 'string');
  const phaseFourId = String(version.phase_four_id);

  const { data: existing, error: eErr } = await projects.from('p4ui_screen_specs').select('screen_key').eq('ui_version_id', input.uiVersionId).eq('organization_id', input.organizationId);
  if (eErr) return { status: 'failed', reason: `could not read the screen specs: ${eErr.message}` };
  const have = new Set((existing ?? []).map((r) => String(r.screen_key)));
  const complete = keys.every((k) => have.has(k));

  let summary: string | undefined;
  let specCount = 0;
  if (!complete && version.status === 'draft') {
    const { data: trace, error: tErr } = await projects.rpc('p4ui_requirement_trace', { p_ui_version_id: input.uiVersionId });
    if (tErr) return { status: 'failed', reason: `could not read the requirement trace: ${tErr.message}` };
    const prompt = `Drafted screens:\n${JSON.stringify(screens)}\n\nRequirements each screen maps to (and any orphan or uncovered):\n${JSON.stringify(trace)}`;
    const answer = await ask(prompt);
    if (!answer.ok) return { status: 'failed', reason: answer.detail };
    const parsed = p4uiScreenSpecsSchema.safeParse(answer.json);
    if (!parsed.success) return { status: 'failed', reason: `the specification did not match its schema: ${parsed.error.issues[0]?.message ?? 'invalid'}` };
    const known = new Set(keys);
    const invented = parsed.data.specs.map((s) => s.screenKey).filter((k) => !known.has(k));
    if (invented.length > 0) return { status: 'failed', reason: `invented screen(s): ${invented.join(', ')}` };
    if (new Set(parsed.data.specs.map((s) => s.screenKey)).size !== parsed.data.specs.length) return { status: 'failed', reason: 'a screen was specified twice' };
    summary = parsed.data.changeSummary;
    for (const spec of parsed.data.specs) {
      const { screenKey, ...rest } = spec;
      const { data, error } = await projects.rpc('p4ui_record_screen_spec', { p_ui_version_id: input.uiVersionId, p_screen_key: screenKey, p_spec: rest });
      if (error) return { status: 'failed', reason: `the screen-spec door did not answer: ${error.message}` };
      const outcome = firstRow(data)?.outcome;
      if (outcome !== 'recorded' && outcome !== 'updated') return { status: 'failed', reason: `the screen-spec door answered ${String(outcome)} for ${screenKey}` };
      specCount += 1;
    }
  }

  // the open design job for this workspace, if one asked for this version
  const { data: jobs, error: jErr } = await projects
    .from('p4ui_design_jobs')
    .select('id, source_ui_version_id, status')
    .eq('phase_four_id', phaseFourId)
    .eq('organization_id', input.organizationId)
    .eq('status', 'requested')
    .order('created_at', { ascending: false })
    .limit(1);
  if (jErr) return { status: 'failed', reason: `could not read the design job: ${jErr.message}` };
  const job = jobs?.[0];

  const { data: lineage, error: lErr } = await projects.rpc('p4ui_derive_version_meta', {
    p_ui_version_id: input.uiVersionId,
    p_change_summary: summary ?? null,
    p_design_job_id: job ? String(job.id) : null,
  });
  if (lErr) return { status: 'failed', reason: `the lineage door did not answer: ${lErr.message}` };
  const lineageOutcome = str(firstRow(lineage)?.outcome) ?? 'no answer';
  if (!['recorded', 'exists', 'no_content_change'].includes(lineageOutcome)) return { status: 'failed', reason: `the lineage door answered ${lineageOutcome}` };

  if (job) {
    const { data: done, error: cErr } = await projects.rpc('p4ui_complete_design_job', { p_job_id: String(job.id), p_ui_version_id: input.uiVersionId });
    if (cErr) return { status: 'failed', reason: `the job-completion door did not answer: ${cErr.message}` };
    const co = str(firstRow(done)?.outcome);
    // not_a_newer_version: the open job belongs to a later version; this one is not its answer
    if (co !== 'delivered' && co !== 'already_delivered' && co !== 'not_a_newer_version') return { status: 'failed', reason: `the job-completion door answered ${String(co)}` };
  }
  return { status: 'done', detail: `specs ${specCount}, lineage ${lineageOutcome}`, data: { specs: specCount, lineage: lineageOutcome } };
}

// ═══ planPrototypeBuild ════════════════════════════════════════════════════
const ACTIVE_BUILD = new Set(['planned', 'input_validation', 'blocked', 'building', 'build_ready', 'qa_review', 'qa_pass', 'admin_approved', 'client_review', 'locked']);

export async function planPrototypeBuild(
  admin: P4uiAdmin,
  input: { organizationId: string; uiVersionId: string },
  ask: P4uiAsk,
): Promise<P4uiOutcome> {
  const projects = admin.schema('projects');
  const { data: version, error: vErr } = await projects
    .from('ui_versions')
    .select('id, status, screens')
    .eq('id', input.uiVersionId)
    .eq('organization_id', input.organizationId)
    .maybeSingle();
  if (vErr) return { status: 'failed', reason: `could not read the UI version: ${vErr.message}` };
  if (!version) return { status: 'skipped', reason: 'the UI version no longer exists' };
  // PROTO 2/8: only the exact locked version; nothing is asked of the model for anything else
  if (version.status !== 'locked') return { status: 'skipped', reason: `the UI version is ${String(version.status)}, not locked` };

  const { data: builds, error: bErr } = await projects
    .from('p4ui_prototype_builds')
    .select('id, status, build_number')
    .eq('ui_version_id', input.uiVersionId)
    .eq('organization_id', input.organizationId)
    .order('build_number', { ascending: false })
    .limit(1);
  if (bErr) return { status: 'failed', reason: `could not read the builds: ${bErr.message}` };
  if (builds?.[0] && ACTIVE_BUILD.has(String(builds[0].status))) return { status: 'skipped', reason: `build ${String(builds[0].build_number)} is already ${String(builds[0].status)}` };

  const screens = (Array.isArray(version.screens) ? version.screens : []) as Array<{ screenKey?: string }>;
  const answer = await ask(`The locked screens:\n${JSON.stringify(screens)}`);
  if (!answer.ok) return { status: 'failed', reason: answer.detail };
  const parsed = p4uiPrototypePlanSchema.safeParse(answer.json);
  if (!parsed.success) return { status: 'failed', reason: `the plan did not match its schema: ${parsed.error.issues[0]?.message ?? 'invalid'}` };
  const plan = parsed.data;
  const known = new Set(screens.map((s) => s.screenKey).filter((k): k is string => typeof k === 'string'));
  const named = [...plan.routes.map((r) => r.screenKey), ...plan.interactions.flatMap((i) => [i.from, ...(i.to ? [i.to] : [])]), ...plan.criticalFlows.flat()];
  const invented = [...new Set(named.filter((k) => !known.has(k)))];
  if (invented.length > 0) return { status: 'failed', reason: `the plan names screen(s) the locked UI does not have: ${invented.join(', ')}` };

  const { platform, buildMode, environment, testData, ...rest } = plan;
  const { data: planned, error: pErr } = await projects.rpc('p4ui_plan_prototype_build', {
    p_ui_version_id: input.uiVersionId,
    p_platform: platform,
    p_build_mode: buildMode,
    p_environment: environment,
    p_plan: rest,
  });
  if (pErr) return { status: 'failed', reason: `the plan door did not answer: ${pErr.message}` };
  const row = firstRow(planned);
  if (row?.outcome === 'exists') return { status: 'skipped', reason: 'a build for this UI version is already active' };
  if (row?.outcome !== 'planned') return { status: 'failed', reason: `the plan door answered ${String(row?.outcome)}` };
  const buildId = String(row.ref_id);

  for (const t of testData) {
    const { data, error } = await projects.rpc('p4ui_record_test_data', { p_build_id: buildId, p_name: t.name, p_payload: t.payload, p_edge_case: t.edgeCase, p_purpose: t.purpose ?? null });
    if (error) return { status: 'failed', reason: `the test-data door did not answer: ${error.message}` };
    const o = firstRow(data)?.outcome;
    // a secret-shaped value is refused, loudly: the model is not asked again and nothing is kept
    if (o === 'secret_detected') return { status: 'failed', reason: `test data "${t.name}" contained a secret-shaped value and was refused` };
    if (o !== 'recorded' && o !== 'exists') return { status: 'failed', reason: `the test-data door answered ${String(o)}` };
  }

  const { data: validated, error: valErr } = await projects.rpc('p4ui_validate_build_inputs', { p_build_id: buildId });
  if (valErr) return { status: 'failed', reason: `the validation door did not answer: ${valErr.message}` };
  const v = firstRow(validated);
  return { status: 'done', detail: `build planned, validation ${String(v?.outcome)}`, data: { buildId, validation: v?.outcome ?? null, blockers: v?.detail ?? null } };
}

// ═══ attachBuiltPrototype (no model) ═══════════════════════════════════════
export async function attachBuiltPrototype(admin: P4uiAdmin, input: { organizationId: string; prototypeArtifactId: string }): Promise<P4uiOutcome> {
  const projects = admin.schema('projects');
  const { data: artifact, error: aErr } = await projects
    .from('prototype_artifacts')
    .select('id, ui_version_id')
    .eq('id', input.prototypeArtifactId)
    .eq('organization_id', input.organizationId)
    .maybeSingle();
  if (aErr) return { status: 'failed', reason: `could not read the artifact: ${aErr.message}` };
  if (!artifact) return { status: 'skipped', reason: 'the artifact no longer exists' };

  const { data: builds, error: bErr } = await projects
    .from('p4ui_prototype_builds')
    .select('id, status, prototype_artifact_id')
    .eq('ui_version_id', String(artifact.ui_version_id))
    .eq('organization_id', input.organizationId)
    .order('build_number', { ascending: false })
    .limit(1);
  if (bErr) return { status: 'failed', reason: `could not read the builds: ${bErr.message}` };
  const build = builds?.[0];
  if (!build) return { status: 'skipped', reason: 'no build was planned for this UI version' };
  if (build.prototype_artifact_id === input.prototypeArtifactId) return { status: 'skipped', reason: 'the artifact is already attached' };
  const buildId = String(build.id);

  if (build.status === 'planned' || build.status === 'input_validation') {
    const { data, error } = await projects.rpc('p4ui_validate_build_inputs', { p_build_id: buildId });
    if (error) return { status: 'failed', reason: `the validation door did not answer: ${error.message}` };
    const o = firstRow(data)?.outcome;
    if (o !== 'ready') return { status: 'skipped', reason: `the build is ${String(o)}: nothing is attached until a person resolves it` };
  } else if (build.status !== 'building') {
    return { status: 'skipped', reason: `the build is ${String(build.status)}` };
  }

  const { data: attached, error: attErr } = await projects.rpc('p4ui_attach_build_artifact', { p_build_id: buildId, p_prototype_artifact_id: input.prototypeArtifactId });
  if (attErr) return { status: 'failed', reason: `the attach door did not answer: ${attErr.message}` };
  const a = firstRow(attached);
  if (a?.outcome === 'self_check_failed') return { status: 'done', detail: `self-check failed (${String(a.detail)} gap(s)); the build is FAILED and a blocker is open`, data: { buildId, attach: 'self_check_failed' } };
  if (a?.outcome !== 'build_ready' && a?.outcome !== 'already_attached') return { status: 'failed', reason: `the attach door answered ${String(a?.outcome)}` };

  const { data: handoff, error: hErr } = await projects.rpc('p4ui_assemble_qa_handoff', { p_build_id: buildId });
  if (hErr) return { status: 'failed', reason: `the handoff door did not answer: ${hErr.message}` };
  const h = firstRow(handoff);
  return { status: 'done', detail: `build ready, handoff ${String(h?.outcome)}`, data: { buildId, attach: 'build_ready', handoff: h?.outcome ?? null } };
}

// ═══ syncBuildForDeliverable (no model): the build reflects the real gates ═══
export async function syncBuildForDeliverable(admin: P4uiAdmin, input: { organizationId: string; deliverableId: string }): Promise<P4uiOutcome> {
  const projects = admin.schema('projects');
  const { data: artifact, error: aErr } = await projects
    .from('prototype_artifacts')
    .select('id')
    .eq('deliverable_id', input.deliverableId)
    .eq('organization_id', input.organizationId)
    .maybeSingle();
  if (aErr) return { status: 'failed', reason: `could not read the artifact: ${aErr.message}` };
  if (!artifact) return { status: 'skipped', reason: 'not a prototype deliverable' };
  const { data: builds, error: bErr } = await projects
    .from('p4ui_prototype_builds')
    .select('id')
    .eq('prototype_artifact_id', String(artifact.id))
    .eq('organization_id', input.organizationId)
    .maybeSingle();
  if (bErr) return { status: 'failed', reason: `could not read the build: ${bErr.message}` };
  if (!builds) return { status: 'skipped', reason: 'no planned build follows this artifact' };
  const { data, error } = await projects.rpc('p4ui_sync_build_status', { p_build_id: String(builds.id) });
  if (error) return { status: 'failed', reason: `the sync door did not answer: ${error.message}` };
  const o = firstRow(data);
  return { status: 'done', detail: `${String(o?.outcome)} ${String(o?.detail ?? '')}`.trim(), data: { buildId: String(builds.id), outcome: o?.outcome ?? null } };
}
