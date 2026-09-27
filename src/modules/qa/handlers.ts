import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';
import type { HandlerResult, UnlockJob } from '@/modules/projects/handlers';
import { verdictFor } from '@/modules/agents/verification';
import { scanPrototypeBuildForSecrets } from '@/modules/qa/secret-scan';

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
    .select('id, organization_id, project_id, ui_version_id, deliverable_id, screens, qa_reviewed_at')
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
  const secretFindings = scanPrototypeBuildForSecrets(buildScreens);
  const secretsOk = secretFindings.length === 0;

  const verdict = verdictFor(
    [
      // ui_prototype's registry entry requires 'build' evidence (it produced
      // this artifact, which is why this review is happening at all) on top
      // of the coverage check below — unlike ui_designer, which requires none.
      { kind: 'build', passed: true },
      { kind: 'record', passed: coverageOk },
      // PA4-T030: "Build contains provider/API secret -> Security FAIL."
      // A separate evidence item, not folded into coverageOk, so a security
      // finding and a coverage gap are each their own named rejection reason.
      { kind: 'record', passed: secretsOk },
    ],
    {
      producer: 'ui_prototype',
      verifier: 'quality_assurance',
    },
  );

  if (!verdict.ok) {
    return { status: 'failed', permanent: true, detail: `verification contract refused: ${verdict.error.message}` };
  }

  const outcome = verdict.data.outcome === 'verified' ? 'qa_pass' : 'qa_changes_required';
  const findings = {
    missingScreens,
    brokenRoutes,
    secretFindings,
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
    case 'recorded': {
      // QA spec §7-9: structured defects with real severity, not just three
      // keys in a jsonb blob — reusing qa.defects (20260813120002), the
      // existing general-purpose entity this codebase already has a full
      // lifecycle, RLS, and Admin Panel surface for, rather than inventing a
      // parallel Phase-4-only one. This also means qa.blocking_defects()
      // (already checked by submit_deliverable before "Submit for review"
      // can be clicked) now structurally blocks a prototype with open
      // blocker/major defects — closing a second gap: today a
      // qa_changes_required prototype can still be submitted, since
      // submit_deliverable never reads prototype_artifacts.status at all.
      if (outcome === 'qa_changes_required') {
        await raisePrototypeDefects(admin, {
          organizationId: artifact.organization_id,
          projectId: artifact.project_id,
          deliverableId: artifact.deliverable_id,
          missingScreens,
          brokenRoutes,
          secretFindings,
        });
      }
      return { status: 'succeeded', outcome, detail: `Prototype QA verdict recorded: ${outcome}.` };
    }
    case 'already_reviewed':
      return { status: 'succeeded', outcome: 'already_reviewed', detail: 'this build was already reviewed.' };
    case 'unknown_artifact':
      return { status: 'failed', permanent: true, detail: 'the prototype artifact no longer exists.' };
    default:
      return { status: 'failed', permanent: false, detail: `the door answered ${doorOutcome}` };
  }
}

type SecretFindingLike = { screenKey: string; elementIndex: number; pattern: string };

/**
 * Turns Prototype QA's three ad hoc arrays into real `qa.defects` rows —
 * QA spec §7-9's own "structured defect record with severity," reusing this
 * codebase's existing general-purpose defect entity (its severity
 * vocabulary, its open/fixed/verified/wontfix lifecycle, its RLS, and the
 * existing `/qa` Admin Panel page already read it) rather than inventing a
 * parallel one scoped to Phase 4 alone.
 *
 * Best-effort: called after the verdict is already durably recorded, so a
 * failure here does not fail the job or lose the verdict — the coverage gap
 * still lives in `prototype_artifacts.qa_findings` either way. Each call site
 * only reaches this once per artifact, since `record_prototype_qa_verdict`
 * itself is the idempotency gate (a re-reviewed artifact never reaches the
 * 'recorded' branch a second time).
 */
async function raisePrototypeDefects(
  admin: Admin,
  input: {
    organizationId: string;
    projectId: string;
    deliverableId: string;
    missingScreens: string[];
    brokenRoutes: string[];
    secretFindings: SecretFindingLike[];
  },
): Promise<void> {
  const rows = [
    ...input.missingScreens.map((screenKey) => ({
      organization_id: input.organizationId,
      project_id: input.projectId,
      deliverable_id: input.deliverableId,
      severity: 'blocker' as const,
      title: `Missing screen: ${screenKey}`,
      reproduction: 'Compare the prototype build\'s screens against the locked UI version\'s screenKeys.',
      expected: `Screen "${screenKey}" is present in the locked UI version.`,
      actual: `Screen "${screenKey}" is missing from the prototype build.`,
    })),
    ...input.brokenRoutes.map((target) => ({
      organization_id: input.organizationId,
      project_id: input.projectId,
      deliverable_id: input.deliverableId,
      severity: 'major' as const,
      title: `Broken navigation target: ${target}`,
      reproduction: `Trigger any element whose navigatesTo is "${target}".`,
      expected: `"${target}" resolves to a real screen in this build.`,
      actual: `"${target}" does not match any screenKey in this build.`,
    })),
    ...input.secretFindings.map((finding) => ({
      organization_id: input.organizationId,
      project_id: input.projectId,
      deliverable_id: input.deliverableId,
      severity: 'blocker' as const,
      title: `Possible credential in ${finding.screenKey} element ${finding.elementIndex}`,
      reproduction: `Inspect element ${finding.elementIndex} on screen "${finding.screenKey}".`,
      expected: 'No real credentials appear in generated mock content.',
      actual: `Content matches the "${finding.pattern}" shape.`,
    })),
  ];

  if (rows.length === 0) return;

  const { error } = await admin.schema('qa').from('defects').insert(rows);
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'raisePrototypeDefects', detail: error.message }));
  }
}
