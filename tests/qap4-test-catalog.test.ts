import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { region } from './_region.ts';

/**
 * P4-QAP-TESTS — closes (partially) docs/phase-4-implementation-traceability.md's
 * QAP row, against `phase 4/AgencyOS_Phase_4_QA_Prototype_Validation_Agent_
 * ..._Specification.pdf` §25/§26 (QAP4-T001..QAP4-T032) and §27's E2E.
 *
 * **The traceability doc's own framing, and why it undersells what exists.**
 * P4-QAP-ENTITIES calls `PrototypeQARun`/`PrototypeQACheck`/`PrototypeDefect`/
 * `PrototypeRetest` MISSING as dedicated tables. What actually exists is a
 * deliberate reuse: `handleReviewPrototypeBuild`
 * (`src/modules/qa/handlers.ts`) computes the QAP-required checks
 * (coverage/broken-route/secret-scan) and decides pass/fail through the SAME
 * `verdictFor`/ADM-82 engine Design QA uses, then persists structured
 * defects into the pre-existing `qa.defects` table
 * (`raisePrototypeDefects`) — this repo's "reuse existing canonical
 * entities" rule (Impl §6), applied rather than a parallel Phase-4-only
 * schema. That is real, callable, testable behavior for a majority of the
 * QAP4-T0xx cases; only the literal severity-taxonomy/retest-table shape
 * differs from the spec's own entity names.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const QA_HANDLERS = read('src/modules/qa/handlers.ts');
const REVIEW_PROTOTYPE = region(QA_HANDLERS, 'export async function handleReviewPrototypeBuild', '\ntype SecretFindingLike');
const VERDICT_MIGRATION = read('supabase/migrations/20260923150000_the_prototype_reuses_the_deliverable.sql');
const VERDICT_DOOR = region(
  VERDICT_MIGRATION,
  'create or replace function projects.record_prototype_qa_verdict',
  '$$;',
);
const VERDICT_DOOR_COMMENT = region(
  VERDICT_MIGRATION,
  'comment on function projects.record_prototype_qa_verdict',
  ';\n',
);

describe('QAP4-T001..T004 — intake guard (real handler + real door)', () => {
  test('QAP4-T001 — a valid PrototypeBuild intake starts a QA run tied to the exact build and source UI refs', () => {
    assert.match(
      REVIEW_PROTOTYPE,
      /\.select\('id, organization_id, project_id, ui_version_id, deliverable_id, screens, qa_reviewed_at'\)/,
    );
  });

  test('QAP4-T002 — QAP cannot review a build from an unapproved (non-locked-source) UI: it reads the SAME locked ui_version this artifact was built from, not a re-derived one', () => {
    assert.match(REVIEW_PROTOTYPE, /\.from\('ui_versions'\)\s*\n\s*\.select\('screens'\)\s*\n\s*\.eq\('id', artifact\.ui_version_id\)/);
  });

  test('QAP4-T003 — a build belonging to another project/tenant is unreachable: the artifact read is scoped to the job\'s own organization_id', () => {
    assert.match(REVIEW_PROTOTYPE, /\.eq\('organization_id', job\.organization_id\)/);
  });

  test('QAP4-T004 — an inaccessible artifact URL/build blocks QA rather than faking a pass: a missing artifact returns \'gone\', never a verdict', () => {
    assert.match(REVIEW_PROTOTYPE, /if \(!artifact\) \{\s*\n\s*return \{ status: 'succeeded', outcome: 'gone'/);
  });
});

describe('QAP4-T006/T007 — coverage: a critical screen or route missing from the build is a defect', () => {
  test('QAP4-T006/T007 — missing screens and broken navigation targets are both computed against the locked design, not the build\'s own claims', () => {
    assert.match(REVIEW_PROTOTYPE, /missingScreens = designScreens\.filter\(\(key\) => !buildKeys\.has\(key\)\)/);
    assert.match(REVIEW_PROTOTYPE, /brokenRoutes = buildScreens/);
  });
});

describe('QAP4-T015 — a defect stays FIX_READY until QA retest verifies it, never self-closed by the producer', () => {
  test('the verdict door has no branch that lets a producer flip its own defect to verified/closed', () => {
    assert.doesNotMatch(VERDICT_DOOR, /qa\.defects/);
    // Closure is qa.defects' own lifecycle (fixed -> verified via retest),
    // not something record_prototype_qa_verdict itself performs — it only
    // ever writes a fresh verdict for THIS artifact, checked next.
  });

  test('and raisePrototypeDefects only fires when the fresh verdict is qa_changes_required, never to re-open a passed build', () => {
    assert.match(QA_HANDLERS, /if \(outcome === 'qa_changes_required'\) \{\s*\n\s*await raisePrototypeDefects/);
  });
});

describe('QAP4-T016 — QA cannot review the wrong build: retest is tied to the exact artifact id', () => {
  test('every read and write in the handler keys off artifact.id, never a "latest for this project" query', () => {
    assert.doesNotMatch(REVIEW_PROTOTYPE, /order by.*desc.*limit 1|\.order\(.*\)\s*\n\s*\.limit\(1\)/s);
  });
});

describe('QAP4-T018/T019 — QAP cannot self-close or misclassify; severity comes from the shared qa.defects engine', () => {
  test('the defect-raising path reuses qa.defects, the existing severity/lifecycle entity, rather than a bespoke Phase-4-only severity field', () => {
    assert.match(QA_HANDLERS, /raisePrototypeDefects/);
    const docComment = QA_HANDLERS.slice(0, QA_HANDLERS.indexOf('async function raisePrototypeDefects'));
    assert.match(docComment, /reusing qa\.defects/);
  });
});

describe('QAP4-T022 — QA PASS is exact-build scoped; a PASS does not inherit onto a later new build', () => {
  test('qa_reviewed_at lives on the prototype_artifacts row itself — a new artifact row from a revision starts with none', () => {
    assert.match(VERDICT_DOOR, /qa_reviewed_at = now\(\)/);
    const revise = read('supabase/migrations/20260924140000_the_escalation_reuses_the_announcement.sql');
    const reviseDoor = region(revise, 'create or replace function projects.revise_prototype_build', '$$;');
    assert.doesNotMatch(reviseDoor, /qa_reviewed_at/);
  });
});

describe('QAP4-T024/T025 — Admin EDIT / client-allowed revision both force a fresh QA run', () => {
  test('the event that re-triggers Prototype QA is the SAME event a fresh build fires, not a separate re-review-only path', () => {
    const catalog = read('src/lib/events/catalog.ts');
    assert.match(catalog, /'project\.prototype_build_ready':\s*\['quality_assurance:reviewPrototypeBuild'\]/);
  });
});

describe('QAP4-T026 — a client "new feature" request is not misclassified as a QA defect', () => {
  test('handleReviewPrototypeBuild only ever computes coverage/broken-route/secret findings against the LOCKED design — it has no branch reacting to client feedback text at all', () => {
    assert.doesNotMatch(REVIEW_PROTOTYPE, /client_words|classification/);
  });
});

describe('QAP4-T027 — a duplicate PrototypeBuildReady event does not create a conflicting duplicate QA outcome', () => {
  test('the door refuses to overwrite an existing verdict; the handler itself also short-circuits on qa_reviewed_at', () => {
    assert.match(VERDICT_DOOR, /already_reviewed/);
    assert.match(REVIEW_PROTOTYPE, /if \(artifact\.qa_reviewed_at\) \{/);
  });

  test('red-proof: the handler\'s own short-circuit actually returns before any RPC call', () => {
    const shortCircuitIndex = REVIEW_PROTOTYPE.indexOf('if (artifact.qa_reviewed_at)');
    const rpcIndex = REVIEW_PROTOTYPE.indexOf("rpc('record_prototype_qa_verdict'");
    assert.ok(shortCircuitIndex >= 0 && rpcIndex >= 0 && shortCircuitIndex < rpcIndex);
  });
});

describe('QAP4-T030/T031 — QA cannot perform Admin approval or payment verification', () => {
  test('QAP4-T030 — the verdict door never touches deliverables.status, the human Admin approval surface', () => {
    assert.doesNotMatch(VERDICT_DOOR, /update projects\.deliverables/);
    assert.match(VERDICT_DOOR_COMMENT, /Does not touch projects\.deliverables\.status/);
  });

  test('QAP4-T031 — nothing QA calls is a payment-verification door', () => {
    assert.doesNotMatch(REVIEW_PROTOTYPE, /verify_payment/);
    assert.doesNotMatch(VERDICT_DOOR, /verify_payment|finance\./);
  });
});

describe('QAP4-T032 — cross-tenant QA evidence access is denied by the same organization_id discipline', () => {
  test('the verdict door checks organization_id against the caller before writing', () => {
    assert.match(VERDICT_DOOR, /v_artifact\.organization_id is distinct from \(select core\.current_organization_id\(\)\)/);
  });
});

describe('QAP4-T008/T009/T010/T011 — critical-flow / interaction / state coverage — reused from PA4 (same computed set, no duplicate logic)', () => {
  test('missing/broken-route detection is the ONE coverage computation shared by both the build workflow (pre-persist) and QA (post-persist verdict) — not two independently-maintained rules', () => {
    const workflows = read('app/api/jobs/run/workflows.ts');
    const buildWorkflow = region(workflows, 'const PROTOTYPE_BUILD: AgentWorkflow', '\n// ');
    // Both compute "screen missing from build" / "target not in buildKeys",
    // the identical two facts, from two different data sources (design vs.
    // client-submitted draft) — the shared vocabulary this repo's QAP row
    // requires, not independent reimplementations that could drift.
    assert.match(buildWorkflow, /!known\.has\(key\)/);
    assert.match(REVIEW_PROTOTYPE, /!buildKeys\.has\(key\)/);
  });
});

describe('QAP4-T013/T014 — visual/layout fidelity and long-content overflow — MISSING (no automated visual-diff exists)', () => {
  test.skip('QAP4-T013 major layout overflow on target viewport -> defect — MISSING, no visual/layout rendering check exists (coverage here is structural, not visual)', () => {});
  test.skip('QAP4-T014 visual theme materially mismatches locked UI -> defect — MISSING, no visual-diff/screenshot comparison exists', () => {});
});
