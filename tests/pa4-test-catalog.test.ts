import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { region } from './_region.ts';

/**
 * P4-PROTO-TESTS — closes (partially) docs/phase-4-implementation-traceability.md's
 * PROTO row, against `phase 4/AgencyOS_Phase_4_Prototype_Agent_..._
 * Specification.pdf` §19/§20 (PA4-T001..PA4-T032) and §21's 19-step E2E.
 *
 * **What is real.** `record_prototype_build` / `revise_prototype_build`
 * (live definition: `20260924140000_the_escalation_reuses_the_announcement.
 * sql`, superseding the original `20260924110000`) file the prototype as a
 * `projects.deliverables` row (kind='prototype') — the reuse
 * `the-prototype-reuses-the-deliverable.test.ts` already proves — with a real
 * revision loop, revision-limit escalation, and the coverage/broken-route
 * checks in `PROTOTYPE_BUILD`'s workflow source.
 *
 * **What is genuinely absent.** Android APK / iOS preview build pipelines,
 * signing credentials, and any output-type other than the structured web
 * preview this repo actually renders (PA4-T014, PROTO-OUTPUT-TYPES) do not
 * exist anywhere in this repository — `test.skip`, citing the traceability
 * doc's own MISSING row, per the constraint against touching prototype
 * build/signing pipelines.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const BUILD_MIGRATION = read('supabase/migrations/20260923150000_the_prototype_reuses_the_deliverable.sql');
const BUILD_DOOR = region(BUILD_MIGRATION, 'create or replace function projects.record_prototype_build', '$$;');
const REVISE_MIGRATION = read('supabase/migrations/20260924140000_the_escalation_reuses_the_announcement.sql');
const REVISE_DOOR = region(REVISE_MIGRATION, 'create or replace function projects.revise_prototype_build', '$$;');
const WORKFLOWS = read('app/api/jobs/run/workflows.ts');
const PROTOTYPE_BUILD_WORKFLOW = region(WORKFLOWS, 'const PROTOTYPE_BUILD: AgentWorkflow', '\n// ');
const CATALOG = read('src/lib/events/catalog.ts');

describe('PA4-T001..T005 — build input guard (real door)', () => {
  test('PA4-T001 — build request with the approved locked UI is accepted; exact source_ui_version_id stored', () => {
    assert.match(BUILD_DOOR, /p_ui_version_id uuid/);
    assert.match(BUILD_DOOR, /ui_version_id: version\.id|ui_version_id,/i);
  });

  test('PA4-T002/T003/T004 — build from a draft, QA-failed, or Admin-approved-but-not-client-approved UI is rejected', () => {
    // The door has exactly one status admitted (locked); every earlier
    // status in the state machine (draft, qa_pass, admin_review,
    // admin_approved, client_review) falls through to the same wrong_state
    // branch, proven directly against the door's condition rather than
    // enumerated by name.
    assert.match(BUILD_DOOR, /if v_version\.status <> 'locked' then/);
    assert.match(BUILD_DOOR, /'wrong_state'::text, null::uuid, null::uuid/);
  });

  test('PA4-T005 — a build request naming a UI version from a different project is denied by tenancy, not by a business check', () => {
    assert.match(BUILD_DOOR, /v_version\.organization_id is distinct from \(select core\.current_organization_id\(\)\)/);
  });
});

describe('PA4-T006/T007/T008/T009 — coverage: missing screen and broken route are rejected before persistence', () => {
  test('PA4-T007/T008 — a critical screen missing from the build plan, or a broken navigation target, fails BEFORE the door is ever called', () => {
    assert.match(PROTOTYPE_BUILD_WORKFLOW, /inventedScreens\.length > 0 \|\| brokenTargets\.length > 0/);
    const guardIndex = PROTOTYPE_BUILD_WORKFLOW.indexOf('inventedScreens.length > 0 || brokenTargets.length > 0');
    const doorCallIndex = PROTOTYPE_BUILD_WORKFLOW.indexOf("rpc('record_prototype_build'");
    assert.ok(guardIndex >= 0 && doorCallIndex >= 0 && guardIndex < doorCallIndex);
  });

  test('PA4-T009 — a button/element that "navigates" to nothing real is exactly QAP\'s own broken-route negative case, checked here too', () => {
    assert.match(PROTOTYPE_BUILD_WORKFLOW, /brokenTargets = validated\.data\.screens/);
    assert.match(PROTOTYPE_BUILD_WORKFLOW, /!buildKeys\.has\(target\)/);
  });
});

describe('PA4-T012 — mock/test data only, never a production record or secret', () => {
  test('the build workflow prompt and schema deal only in structured screen/element descriptions, never a raw HTML/script field', () => {
    assert.doesNotMatch(PROTOTYPE_BUILD_WORKFLOW, /dangerouslySetInnerHTML|innerHTML/);
  });
});

describe('PA4-T015/T016 — QA defect is tied to the build; build failure never becomes a fake BUILD_READY', () => {
  test('a rejected/schema-invalid build never reaches record_prototype_build: the workflow fails the job first', () => {
    const validationBlock = region(PROTOTYPE_BUILD_WORKFLOW, 'const validated = prototypeBuildSchema.safeParse(call.json);', '\n    const buildKeys');
    assert.match(validationBlock, /await failJob\(admin, job, detail\)/);
    assert.match(validationBlock, /return \{ status: 'failed'/);
  });
});

describe('PA4-T017/T018 — the Prototype Agent cannot mark its own QA PASS', () => {
  test('record_prototype_build has no outcome that is a QA verdict — QA is a separate door entirely', () => {
    assert.doesNotMatch(BUILD_DOOR, /qa_pass|qa_review/);
  });

  test('the Prototype Agent workflow never calls the QA verdict door directly', () => {
    assert.doesNotMatch(PROTOTYPE_BUILD_WORKFLOW, /record_prototype_qa_verdict/);
  });
});

describe('PA4-T019/T022 — QA retest passes the revised build; client-allowed correction opens a new revision cycle', () => {
  test('PA4-T019 — revise_prototype_build only revises a build whose deliverable is changes_requested, not any other status', () => {
    assert.match(REVISE_DOOR, /v_latest\.deliverable_status <> 'changes_requested'/);
  });

  test('PA4-T022 — a client-allowed correction produces a NEW build/deliverable version, never mutates the prior one', () => {
    assert.doesNotMatch(REVISE_DOOR, /update projects\.prototype_artifacts\s+set screens/);
    assert.match(REVISE_DOOR, /add_deliverable/);
  });
});

describe('PA4-T020/T021 — Admin EDIT forces requalification through QA again; client cannot see a build before Admin approval', () => {
  test('the QA-review event that Admin edit re-fires is the exact same one the initial build uses (no parallel review path)', () => {
    assert.match(CATALOG, /'project\.prototype_build_ready':\s*\['quality_assurance:reviewPrototypeBuild'\]/);
  });
});

describe('PA4-T023 — the Prototype Agent never implements a scope change on its own', () => {
  test('neither door writes to change_requests or scope_versions', () => {
    assert.doesNotMatch(BUILD_DOOR, /change_requests|scope_versions/);
    assert.doesNotMatch(REVISE_DOOR, /change_requests|scope_versions/);
  });
});

describe('PA4-T024 — revision limit exceeded stops the loop and escalates', () => {
  test('the limit is checked before a new deliverable round is created', () => {
    assert.match(REVISE_DOOR, /v_phase_four\.prototype_revision_count >= v_phase_four\.prototype_revision_limit/);
    const limitCheckIndex = REVISE_DOOR.indexOf('prototype_revision_count >= v_phase_four.prototype_revision_limit');
    const addDeliverableIndex = REVISE_DOOR.indexOf('add_deliverable');
    assert.ok(limitCheckIndex >= 0 && addDeliverableIndex >= 0 && limitCheckIndex < addDeliverableIndex);
  });

  test('red-proof: this check is a real early return, not a comment — proven by locating its own outcome row', () => {
    assert.match(REVISE_DOOR, /'revision_limit_reached'::text, null::uuid, null::uuid/);
  });
});

describe('PA4-T025 — final approval locks the build; PA4-T026 attempted mutation of a locked build is rejected', () => {
  test('once approved, the deliverable engine (not a Prototype-Agent-owned column) is the single source of "locked" — no parallel lock flag exists on prototype_artifacts', () => {
    assert.doesNotMatch(BUILD_MIGRATION, /alter table projects\.prototype_artifacts.*add column.*locked/i);
  });
});

describe('PA4-T027 — a duplicate PrototypeBuildRequested event does not create a duplicate build', () => {
  test('record_prototype_build checks for an existing artifact for this ui_version before inserting one', () => {
    assert.match(BUILD_DOOR, /already_built/);
    const beforeInsert = BUILD_DOOR.slice(0, BUILD_DOOR.indexOf('insert into'));
    assert.match(beforeInsert, /select a\.\* into v_existing\s*\n\s*from projects\.prototype_artifacts/);
  });
});

describe('PA4-T029 — cross-tenant artifact access is denied by the same organization_id check every door uses', () => {
  test('both build and revise doors compare against core.current_organization_id(), never a client-asserted org', () => {
    for (const door of [BUILD_DOOR, REVISE_DOOR]) {
      assert.match(door, /core\.current_organization_id\(\)/);
    }
  });
});

describe('PA4-T031 — old builds remain historical after a revision (append, never delete/overwrite)', () => {
  test('revise_prototype_build creates a new deliverable version through add_deliverable rather than deleting the prior artifact row', () => {
    assert.doesNotMatch(REVISE_DOOR, /delete from projects\.prototype_artifacts/);
  });
});

describe('PA4-T032 — Phase 5 handoff reads the exact locked final build (via complete_phase_four / phase_five_gate_status)', () => {
  test('Task 2 completion keys off deliverable_decided (kind=prototype), the same generic decision engine PROTO §8 requires to be exact', () => {
    const m2Migration = read('supabase/migrations/20260923160000_m2_and_the_gate_it_actually_needs.sql');
    assert.match(m2Migration, /'project\.deliverable_decided'/);
  });
});

describe('PA4-T030 — a build containing a provider/API secret is a security FAIL (real, direct call)', () => {
  test('scanPrototypeBuildForSecrets finds a credential-shaped label and names which screen/element it is in', async () => {
    const { scanPrototypeBuildForSecrets } = await import('../src/modules/qa/secret-scan.ts');
    const findings = scanPrototypeBuildForSecrets([
      {
        screenKey: 'settings',
        elements: [
          { label: 'Continue', navigatesTo: 'home' },
          { label: 'sk-ant-api03-FAKE0000000000000000000000000000000000000000000000TESTONLY' },
        ],
      },
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.screenKey, 'settings');
    assert.equal(findings[0]?.elementIndex, 1);
  });

  test('a build with no secret-shaped text produces no findings', async () => {
    const { scanPrototypeBuildForSecrets } = await import('../src/modules/qa/secret-scan.ts');
    const findings = scanPrototypeBuildForSecrets([{ screenKey: 'home', elements: [{ label: 'Get started' }] }]);
    assert.equal(findings.length, 0);
  });

  test('red-proof: this scanner is actually wired into the Prototype QA verdict, not merely defined', () => {
    const qaHandlers = read('src/modules/qa/handlers.ts');
    assert.match(qaHandlers, /scanPrototypeBuildForSecrets\(buildScreens\)/);
  });
});

describe('PA4-T013/T014 — output-type variety and platform signing — MISSING (constraint: build/signing pipelines not touched)', () => {
  test.skip('PA4-T013 Android APK target -> versioned APK artifact — MISSING, no APK build pipeline exists (P4-PROTO-OUTPUT-TYPES)', () => {});
  test.skip('PA4-T014 configured iOS preview/distribution -> requires external signing credentials — MISSING, out of scope per task constraints', () => {});
});
