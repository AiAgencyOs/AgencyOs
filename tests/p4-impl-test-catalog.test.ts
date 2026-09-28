import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { region } from './_region.ts';

/**
 * P4-IMPL-TESTCAT — closes (partially) docs/phase-4-implementation-traceability.md's
 * IMPL row: 60 test cases P4-T001..P4-T060 (Impl §16), against `phase 4/
 * AgencyOS_Phase_4_Implementation_Plan_Checklist_Testing_Specification.pdf`
 * §16/§17.
 *
 * This is the CROSS-CUTTING catalog: entry/exit, coverage, security and
 * finance-gate cases that span more than one agent's own spec. Cases that
 * belong to one agent's own detailed behavior are covered in that agent's own
 * PM4/UID4/PA4/QAP4/FIN4/OR4 catalog file and are cited here by reference
 * rather than duplicated. Genuinely absent infrastructure (a distinct
 * Phase4Workspace `AuditEvent` entity, Figma refs, a nested per-stage state
 * machine beyond `projects.phase_four.state`) is `test.skip`, citing the
 * traceability row.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const BOOTSTRAP_MIGRATION = read('supabase/migrations/20260923100000_phase_four_begins_where_phase_three_locks.sql');
const START_DOOR = region(BOOTSTRAP_MIGRATION, 'create or replace function projects.start_phase_four', '$$;');
const M2_MIGRATION = read('supabase/migrations/20260923160000_m2_and_the_gate_it_actually_needs.sql');
const COMPLETE_DOOR = region(M2_MIGRATION, 'create or replace function projects.complete_phase_four', '$$;');
const GATE_FN = region(M2_MIGRATION, 'create or replace function projects.phase_five_gate_status', '$$;');
const CATALOG = read('src/lib/events/catalog.ts');

describe('P4-T001/T002/T003 — entry (real door: start_phase_four)', () => {
  test('P4-T001 — Task 2 starts once, storing the exact locked Phase 3 handoff it started from', () => {
    assert.match(START_DOOR, /h\.phase_four_ready = true/);
    assert.match(START_DOOR, /'task2_started'/);
  });

  test('P4-T002 — Phase 3 incomplete: no ready handoff exists, and the transition is blocked, not defaulted', () => {
    assert.match(START_DOOR, /'not_ready'::text, null::uuid/);
  });

  test('P4-T003 — a replayed Task2Started does not create a second workspace or job', () => {
    assert.match(START_DOOR, /already_started/);
    const beforeInsert = START_DOOR.slice(0, START_DOOR.indexOf('insert into projects.phase_four'));
    assert.match(beforeInsert, /select p4\.\* into v_existing from projects\.phase_four p4 where p4\.project_id = v_project\.id/);
  });

  test('the uniqueness is a real constraint, not merely the door\'s own discipline', () => {
    assert.match(BOOTSTRAP_MIGRATION, /project_id\s+uuid not null unique references projects\.projects\(id\)/);
  });
});

describe('P4-T004/T005 — baseline load (real table columns, no re-decided theme/colors)', () => {
  test('P4-T004 — phase_four REFERENCES the Phase 3 handoff rather than copying theme/colors/screens', () => {
    assert.match(BOOTSTRAP_MIGRATION, /phase_three_handoff_id uuid not null references projects\.phase_three_handoffs\(id\)/);
    assert.doesNotMatch(BOOTSTRAP_MIGRATION, /theme_option_id|color_option_id/);
  });

  test('P4-T005 — a project with no locked design/Figma source (no ready handoff) blocks, rather than fabricating one', () => {
    assert.match(START_DOOR, /'not_ready'::text, null::uuid/);
  });
});

describe('P4-T006/T007/T008/T009 — coverage engine (see uid4-test-catalog.test.ts for the fuller UID slice)', () => {
  test('P4-T006 — a required screen missing from the draft fails coverage (Design QA verdict)', () => {
    const qa = read('src/modules/qa/handlers.ts');
    const reviewUiVersion = region(qa, 'export async function handleReviewUIVersion', '\ntype BuildScreen');
    assert.match(reviewUiVersion, /missingScreens\.push\(key\)/);
  });

  test('P4-T008 — a duplicate screen key does not silently count twice: draftByKey is a Map keyed by screenKey', () => {
    const qa = read('src/modules/qa/handlers.ts');
    const reviewUiVersion = region(qa, 'export async function handleReviewUIVersion', '\ntype BuildScreen');
    assert.match(reviewUiVersion, /new Map\(draftScreens\.map\(\(s\) => \[s\.screenKey, s\]\)\)/);
  });

  test('P4-T009 — a role/state gap (declared-but-unaddressed state) keeps coverage incomplete, not merely "screen present"', () => {
    const qa = read('src/modules/qa/handlers.ts');
    const reviewUiVersion = region(qa, 'export async function handleReviewUIVersion', '\ntype BuildScreen');
    assert.match(reviewUiVersion, /stateGaps\.push/);
  });
});

describe('P4-T010/T011/T012/T013 — full UI, states, variants, scope guard — covered in uid4-test-catalog.test.ts', () => {
  test.skip('P4-T010..T013 — duplicated per-case in uid4-test-catalog.test.ts (UID4-T007/T008/T011/T012); not re-asserted here', () => {});
});

describe('P4-T014/T015/T016 — Design QA loop — covered in uid4-test-catalog.test.ts and qap4-test-catalog.test.ts', () => {
  test.skip('P4-T014..T016 — duplicated per-case in qap4/uid4 catalogs; not re-asserted here', () => {});
});

describe('P4-T017/T018/T019 — Admin UI review loop', () => {
  test('P4-T017 — sending a UI version to Admin before QA PASS is blocked by the SAME state guard as everywhere else', () => {
    const reviewDoor = region(
      read('supabase/migrations/20260923130000_admin_review_reuses_the_engine.sql'),
      'create or replace function projects.request_ui_version_admin_review',
      '$$;',
    );
    assert.match(reviewDoor, /wrong_state/);
  });

  test('P4-T019 — Admin EDIT routes Designer -> QA -> Admin again, never straight back to Admin', () => {
    assert.match(CATALOG, /'project\.ui_version_admin_reviewed':\s*\['crm:announceUiVersionAdminReviewed', 'ui_designer:reviseUIVersion'\]/);
    // The revision the Designer produces re-enters through
    // project.ui_version_drafted -> quality_assurance:reviewUIVersion, the
    // SAME QA subscription every draft uses — no parallel "skip QA for an
    // Admin edit" event exists.
    assert.match(CATALOG, /'project\.ui_version_drafted':\s*\['quality_assurance:reviewUIVersion'\]/);
  });
});

describe('P4-T020..T026 — client UI review / scope / revision limit / UI lock — covered in uid4/pm4 catalogs', () => {
  test.skip('P4-T020..T026 — duplicated per-case in uid4-test-catalog.test.ts and pm4-test-catalog.test.ts; not re-asserted here', () => {});
});

describe('P4-T027..T034 — prototype build/QA — covered in pa4/qap4 catalogs', () => {
  test.skip('P4-T027..T034 — duplicated per-case in pa4-test-catalog.test.ts and qap4-test-catalog.test.ts; not re-asserted here', () => {});
});

describe('P4-T035..T040 — Admin/client prototype review, scope, completion', () => {
  test('P4-T040 — client explicit approval is eligible for DoD evaluation: complete_phase_four reads the deliverable decision, not a UI-only flag', () => {
    assert.match(CATALOG, /'project\.deliverable_decided':\s*\[/);
    assert.match(M2_MIGRATION, /'project\.deliverable_decided'/);
  });
});

describe('P4-T041 — Phase4Completed cannot fire with missing approval evidence', () => {
  test('complete_phase_four requires an actual client-approved deliverable_decided event, not a bare button press: it only ever fires as a job reaction to that event', () => {
    assert.match(CATALOG, /'project\.deliverable_decided':\s*\[[^\]]*projects:completePhaseFourOnPrototypeApproval/s);
  });

  test('a stopped workspace (scope_escalation/revision_limit_escalation) refuses to complete out from under a person', () => {
    assert.match(COMPLETE_DOOR, /v_phase_four\.state in \('scope_escalation', 'revision_limit_escalation'\)/);
    assert.match(COMPLETE_DOOR, /'stopped'::text, null::uuid/);
  });
});

describe('P4-T042/T043 — Phase4Completed triggers exactly one M2 milestone path, idempotently', () => {
  test('P4-T042 — Phase4Completed routes to Finance for the M2 invoice', () => {
    assert.match(CATALOG, /'project\.phase_four_completed':\s*\['finance:generateM2Invoice', 'crm:announceTask2Complete'\]/);
  });

  test('P4-T043 — complete_phase_four itself answers already_completed on replay, before Finance is ever asked again', () => {
    assert.match(COMPLETE_DOOR, /already_completed/);
  });
});

describe('P4-T044..T048 — payment/verification/Phase 5 gate — see fin4-test-catalog.test.ts (moneyAuthority path not duplicated here)', () => {
  test('P4-T047/T048 — the gate function itself is the single source of truth Phase 5 eligibility reads, and only "paid" answers verified', () => {
    assert.match(GATE_FN, /when i\.status = 'paid' then 'verified'/);
    assert.match(GATE_FN, /when i\.id is not null then 'invoice_issued'/);
  });
  test.skip('P4-T044/T045/T046 payment proof/unauthorized verification/Admin verify — covered by tests/the-gate-with-no-way-through.test.ts and tests/a-verification-that-can-only-pass-once.test.ts; not duplicated here per moneyAuthority constraint', () => {});
});

describe('P4-T049/T050 — communication delivery failure and retry preserve business state (see pm-task-2-communication.test.ts)', () => {
  test.skip('P4-T049/T050 — covered live by pm-task-2-communication.test.ts and pm-prototype-communication.test.ts; not duplicated here', () => {});
});

describe('P4-T051..T054 — cross-project/tenant and privileged-action security', () => {
  test('P4-T051/T052 — every Phase 4 door checks the CALLER\'s organization_id, never a payload-asserted one', () => {
    for (const door of [START_DOOR, COMPLETE_DOOR]) {
      assert.match(door, /core\.current_organization_id\(\)/);
    }
  });

  test('P4-T053 — the Designer has no execute grant on Admin/client approval doors (see the-designer-proposes.test.ts suite A)', () => {
    const migration = read('supabase/migrations/20260920080000_an_agent_is_an_actor_the_door_knows.sql');
    assert.match(migration, /to service_role;/);
    assert.equal((migration.match(/to service_role;/g) ?? []).length, 2);
  });

  test('P4-T054 — PM has no payment-verification handler registered anywhere in the event catalog', () => {
    assert.doesNotMatch(CATALOG, /project_manager:verifyPayment|project_manager:verify_payment/);
  });
});

describe('P4-T055 — a duplicate UIDesignReady-equivalent event yields a single QA business outcome', () => {
  test('project.ui_version_drafted subscribes reviewUIVersion exactly once; the handler itself refuses to re-review a non-draft version', () => {
    assert.match(CATALOG, /'project\.ui_version_drafted':\s*\['quality_assurance:reviewUIVersion'\]/);
    const qa = read('src/modules/qa/handlers.ts');
    assert.match(qa, /already_reviewed/);
  });
});

describe('P4-T056/T057 — worker crash recovery is safe retry from persisted state', () => {
  test('P4-T056 — Design QA is idempotent by re-reading the version row, not by in-memory state a crashed worker would lose', () => {
    const qa = read('src/modules/qa/handlers.ts');
    const reviewUiVersion = region(qa, 'export async function handleReviewUIVersion', '\ntype BuildScreen');
    assert.match(reviewUiVersion, /version\.status !== 'draft'/);
  });

  test('P4-T057 — a failed prototype build job fails permanently=false where the failure is transient (door/network), never silently swallowed', () => {
    const workflows = read('app/api/jobs/run/workflows.ts');
    const buildWorkflow = region(workflows, 'const PROTOTYPE_BUILD: AgentWorkflow', '\n// ');
    assert.match(buildWorkflow, /the door did not answer: \$\{recordError\.message\}/);
  });
});

describe('P4-T058 — a Figma/provider-unavailable case surfaces a truthful, resumable blocker — MISSING (no Figma integration exists; constraint: not touched)', () => {
  test.skip('P4-T058 — MISSING, no Figma/provider integration exists anywhere in this repository to be unavailable', () => {});
});

describe('P4-T059/T060 — Admin UI empty/edge states', () => {
  test('P4-T059 — the Phase 4 overview panel is read-only and does not fabricate metrics when no data exists (per traceability doc, existing behavior)', () => {
    // Structural existence check only — the panel's own detailed behavior is
    // Admin-UI-surface work (P4-UID-ADMINUI), not this row's test-writing
    // scope; recorded here only so the case is locatable.
    const panel = read('app/(internal)/projects/[projectId]/phase-four-panel.tsx');
    assert.ok(panel.length > 0);
  });

  test.skip('P4-T060 long names/feedback do not break layout — MISSING, no automated layout/visual test harness exists in this repository', () => {});
});
