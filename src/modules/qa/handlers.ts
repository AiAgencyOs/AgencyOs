import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';
import type { HandlerResult, UnlockJob } from '@/modules/projects/handlers';
import { verdictFor } from '@/modules/agents/verification';

type Admin = ReturnType<typeof createAdminClient>;

type FrozenScreen = {
  screenKey?: string;
  states?: { empty?: boolean; loading?: boolean; error?: boolean; success?: boolean };
};

type DraftScreen = { screenKey: string; statesAddressed?: string[] };

/**
 * `project.ui_version_drafted` → Design QA's coverage verdict — QAP §7;
 * UID §19; ADM-82. `docs/phase-4-gap-analysis.md` step 3's Design QA
 * increment.
 *
 * **This reuses the existing ADM-82 verification contract, not a new one.**
 * `verdictFor` (`src/modules/agents/verification.ts`) already refuses a
 * producer verifying its own work, refuses any agent but the producer's
 * DECLARED verifier, and refuses an agent with no `mayVerify` entitlement —
 * `ui_designer.verification.verifiedBy` has named `quality_assurance` since
 * the registry was written. This handler supplies one `record` evidence item
 * carrying the deterministic coverage result computed below; `verdictFor`
 * decides the rest exactly as it would for any other producer/verifier pair.
 *
 * **What "coverage" checks, and what it deliberately does not.** Every screen
 * the LOCKED Phase 3 baseline names must appear in the draft, and every state
 * the baseline declared for a screen must be addressed. Consistency, token
 * usage and usability are real Design QA requirements this handler does not
 * judge — see the migration's own header for why that is a named boundary,
 * not a silent gap.
 *
 * **Idempotent by construction.** A version no longer `draft` (already
 * reviewed) is treated as success, the same shape every "duplicate event"
 * handler in this codebase uses — a redelivered event must not overwrite an
 * existing verdict with a second, possibly different one.
 */
export async function handleReviewUIVersion(admin: Admin, job: UnlockJob): Promise<HandlerResult> {
  const envelope = job.payload ?? {};
  const uiVersionId = typeof envelope.subjectId === 'string' ? envelope.subjectId : null;

  if (!uiVersionId) {
    return { status: 'failed', permanent: true, detail: 'the event named no UI version' };
  }

  const { data: version, error: versionError } = await admin
    .schema('projects')
    .from('ui_versions')
    .select('id, organization_id, project_id, status, screens, source_phase_three_handoff_id')
    .eq('id', uiVersionId)
    .eq('organization_id', job.organization_id)
    .maybeSingle();

  if (versionError) {
    return { status: 'failed', permanent: false, detail: `the version could not be read: ${versionError.message}` };
  }
  if (!version) {
    return { status: 'succeeded', outcome: 'gone', detail: 'the UI version no longer exists' };
  }
  if (version.status !== 'draft') {
    return { status: 'succeeded', outcome: 'already_reviewed', detail: `this version is already ${version.status}` };
  }

  const { data: handoff, error: handoffError } = await admin
    .schema('projects')
    .from('phase_three_handoffs')
    .select('id, payload')
    .eq('id', version.source_phase_three_handoff_id)
    .eq('organization_id', job.organization_id)
    .maybeSingle();

  if (handoffError) {
    return { status: 'failed', permanent: false, detail: `the locked baseline could not be read: ${handoffError.message}` };
  }

  const payload = (handoff?.payload ?? null) as { screenBaseline?: { screens?: FrozenScreen[] } } | null;
  const baselineScreens = payload?.screenBaseline?.screens ?? [];
  const draftScreens = (version.screens ?? []) as DraftScreen[];
  const draftByKey = new Map(draftScreens.map((s) => [s.screenKey, s]));

  const missingScreens: string[] = [];
  const stateGaps: string[] = [];

  for (const baseline of baselineScreens) {
    const key = baseline.screenKey;
    if (!key) continue;
    const drafted = draftByKey.get(key);
    if (!drafted) {
      missingScreens.push(key);
      continue;
    }
    const addressed = new Set(drafted.statesAddressed ?? []);
    const requiredStates = Object.entries(baseline.states ?? {})
      .filter(([, declared]) => declared)
      .map(([name]) => name);
    const missing = requiredStates.filter((state) => !addressed.has(state));
    if (missing.length > 0) {
      stateGaps.push(`${key} is missing states: ${missing.join(', ')}`);
    }
  }

  const coverageOk = missingScreens.length === 0 && stateGaps.length === 0;

  const verdict = verdictFor([{ kind: 'record', passed: coverageOk }], {
    producer: 'ui_designer',
    verifier: 'quality_assurance',
  });

  if (!verdict.ok) {
    // Would mean the registry itself no longer declares
    // quality_assurance as ui_designer's verifier — a configuration defect,
    // not something a retry could fix.
    return { status: 'failed', permanent: true, detail: `verification contract refused: ${verdict.error.message}` };
  }

  const outcome = verdict.data.outcome === 'verified' ? 'qa_pass' : 'qa_changes_required';
  const findings = {
    missingScreens,
    stateGaps,
    verdictReasons: verdict.data.outcome === 'rejected' ? verdict.data.reasons : [],
  };

  const { data, error } = await admin
    .schema('projects')
    .rpc('record_ui_version_qa_verdict', {
      p_ui_version_id: version.id,
      p_outcome: outcome,
      p_findings: findings,
    } as never);

  if (error) {
    return { status: 'failed', permanent: false, detail: `the door did not answer: ${error.message}` };
  }

  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  const doorOutcome = row?.outcome ?? 'no answer';

  switch (doorOutcome) {
    case 'recorded':
      return { status: 'succeeded', outcome, detail: `Design QA verdict recorded: ${outcome}.` };
    case 'already_reviewed':
      return { status: 'succeeded', outcome: 'already_reviewed', detail: 'this version was already reviewed.' };
    case 'unknown_version':
      return { status: 'failed', permanent: true, detail: 'the UI version no longer exists.' };
    default:
      return { status: 'failed', permanent: false, detail: `the door answered ${doorOutcome}` };
  }
}

type BuildScreen = { screenKey: string; elements?: Array<{ navigatesTo?: string }> };

/**
 * `project.prototype_build_ready` → Prototype QA's coverage verdict — QAP §7;
 * PROTO §8; ADM-82. `docs/phase-4-gap-analysis.md` step 4.
 *
 * The identical reuse `handleReviewUIVersion` makes: `verdictFor`
 * (`src/modules/agents/verification.ts`) decides pass/fail from one `record`
 * evidence item this handler computes, not a bespoke Prototype-QA-only rule.
 * `ui_prototype.verification.verifiedBy` has named `quality_assurance` since
 * the registry was written.
 *
 * **Coverage here means two things PROTO/QAP both name:** every screen the
 * locked UI version designed has a corresponding build screen, and every
 * navigation target inside the build resolves to a real screen in that same
 * build — QAP's own negative test is literally "prototype QA finds at least
 * one broken route," so a dangling `navigatesTo` is treated exactly like a
 * missing screen.
 *
 * **Does not touch `projects.deliverables.status`.** The human "Submit for
 * review" action on the existing prototype Admin Panel screen stays a human
 * decision informed by this verdict, not bypassed by it — see the migration's
 * own header for why.
 */
export async function handleReviewPrototypeBuild(admin: Admin, job: UnlockJob): Promise<HandlerResult> {
  const envelope = job.payload ?? {};
  const artifactId = typeof envelope.subjectId === 'string' ? envelope.subjectId : null;

  if (!artifactId) {
    return { status: 'failed', permanent: true, detail: 'the event named no prototype artifact' };
  }

  const { data: artifact, error: artifactError } = await admin
    .schema('projects')
    .from('prototype_artifacts')
    .select('id, organization_id, project_id, ui_version_id, screens, qa_reviewed_at')
    .eq('id', artifactId)
    .eq('organization_id', job.organization_id)
    .maybeSingle();

  if (artifactError) {
    return { status: 'failed', permanent: false, detail: `the artifact could not be read: ${artifactError.message}` };
  }
  if (!artifact) {
    return { status: 'succeeded', outcome: 'gone', detail: 'the prototype artifact no longer exists' };
  }
  if (artifact.qa_reviewed_at) {
    return { status: 'succeeded', outcome: 'already_reviewed', detail: 'this build was already reviewed' };
  }

  const { data: version, error: versionError } = await admin
    .schema('projects')
    .from('ui_versions')
    .select('screens')
    .eq('id', artifact.ui_version_id)
    .eq('organization_id', job.organization_id)
    .maybeSingle();

  if (versionError) {
    return { status: 'failed', permanent: false, detail: `the locked UI version could not be read: ${versionError.message}` };
  }

  const designScreens = ((version?.screens ?? []) as Array<{ screenKey?: string }>)
    .map((s) => s.screenKey)
    .filter((key): key is string => Boolean(key));
  const buildScreens = (artifact.screens ?? []) as BuildScreen[];
  const buildKeys = new Set(buildScreens.map((s) => s.screenKey));

  const missingScreens = designScreens.filter((key) => !buildKeys.has(key));
  const brokenRoutes = buildScreens
    .flatMap((s) => s.elements ?? [])
    .map((e) => e.navigatesTo)
    .filter((target): target is string => Boolean(target))
    .filter((target) => !buildKeys.has(target));

  const coverageOk = missingScreens.length === 0 && brokenRoutes.length === 0;

  const verdict = verdictFor([{ kind: 'record', passed: coverageOk }], {
    producer: 'ui_prototype',
    verifier: 'quality_assurance',
  });

  if (!verdict.ok) {
    return { status: 'failed', permanent: true, detail: `verification contract refused: ${verdict.error.message}` };
  }

  const outcome = verdict.data.outcome === 'verified' ? 'qa_pass' : 'qa_changes_required';
  const findings = {
    missingScreens,
    brokenRoutes,
    verdictReasons: verdict.data.outcome === 'rejected' ? verdict.data.reasons : [],
  };

  const { data, error } = await admin
    .schema('projects')
    .rpc('record_prototype_qa_verdict', {
      p_prototype_artifact_id: artifact.id,
      p_outcome: outcome,
      p_findings: findings,
    } as never);

  if (error) {
    return { status: 'failed', permanent: false, detail: `the door did not answer: ${error.message}` };
  }

  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  const doorOutcome = row?.outcome ?? 'no answer';

  switch (doorOutcome) {
    case 'recorded':
      return { status: 'succeeded', outcome, detail: `Prototype QA verdict recorded: ${outcome}.` };
    case 'already_reviewed':
      return { status: 'succeeded', outcome: 'already_reviewed', detail: 'this build was already reviewed.' };
    case 'unknown_artifact':
      return { status: 'failed', permanent: true, detail: 'the prototype artifact no longer exists.' };
    default:
      return { status: 'failed', permanent: false, detail: `the door answered ${doorOutcome}` };
  }
}
