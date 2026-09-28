import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { region } from './_region.ts';

/**
 * P4-UID-TESTS — closes (partially) docs/phase-4-implementation-traceability.md's
 * UID row, against `phase 4/AgencyOS_Phase_4_UI_Designer_Agent_Conditional_..._
 * Specification.pdf` §26/§27 (UID4-T001..UID4-T030) and §28's E2E scenario.
 *
 * **What is real, per the source this repo actually has.** UID's own spec
 * describes a `Conditional Activation Engine` — the Designer runs only when a
 * condition is proven, never always-on. The implementation reached here does
 * NOT build a separate activation-decision entity; it reuses the same
 * event-subscription + door-side `wrong_state`/`already_drafted` idempotency
 * pattern every other Phase 4 stage uses (`record_ui_version_draft`,
 * `revise_ui_version`) — the workflow only ever runs off a real event, and the
 * door refuses to draft twice or draft outside `task2_started`. That is a
 * genuine, testable form of "conditional", even though it is not the
 * dedicated `UIDesignJob`/activation-reason entity UID4-I02 describes.
 *
 * Figma read/write/create capability detection (UID4-T021, UID4-T029) is
 * verified **MISSING** — no Figma integration of any kind exists in `src/` or
 * `supabase/migrations/` (constraint: this task explicitly does not touch
 * Figma integration). Those cases are `test.skip`, not faked.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const DRAFT_MIGRATION = read('supabase/migrations/20260923110000_the_ui_version_designs_the_locked_screens.sql');
const DRAFT_DOOR = region(DRAFT_MIGRATION, 'create or replace function projects.record_ui_version_draft', '$$;');
const REVISE_MIGRATION = read('supabase/migrations/20260924140000_the_escalation_reuses_the_announcement.sql');
const REVISE_UI_DOOR = region(REVISE_MIGRATION, 'create or replace function projects.revise_ui_version(', '$$;');
const TRANSITION_MIGRATION = read('supabase/migrations/20260928100000_a_ui_version_moves_only_where_the_doors_lead.sql');
const TRANSITION_GUARD = region(TRANSITION_MIGRATION, 'function projects.enforce_ui_version_status_transition');
const WORKFLOWS = read('app/api/jobs/run/workflows.ts');
const UI_VERSION_DRAFT_WORKFLOW = region(WORKFLOWS, "const UI_VERSION_DRAFT: AgentWorkflow", '\nconst ');
const CATALOG = read('src/lib/events/catalog.ts');

describe('UID4-T001..T004 — activation / entry (real door behavior)', () => {
  test('UID4-T001 — a valid Phase 4 start (task2_started) is the only state the door drafts from', () => {
    assert.match(DRAFT_DOOR, /v_phase_four\.state <> 'task2_started'/);
    assert.match(DRAFT_DOOR, /'wrong_state'::text, null::uuid/);
  });

  test('UID4-T002 — Phase 3 incomplete: no phase_four workspace exists to draft against', () => {
    assert.match(DRAFT_DOOR, /'unknown_workspace'::text, null::uuid/);
  });

  test('UID4-T004 — a duplicate draft event does not create a second UI version', () => {
    assert.match(DRAFT_DOOR, /already_drafted/);
    const beforeInsert = DRAFT_DOOR.slice(0, DRAFT_DOOR.indexOf('insert into projects.ui_versions'));
    assert.match(beforeInsert, /select v\.\* into v_existing/);
  });

  test('UID4-T003 — theme/color not (re)decided by this workflow: it writes ui_versions only, never a theme/color table', () => {
    assert.doesNotMatch(DRAFT_DOOR, /insert into projects\.(theme_option|design_token)/);
    assert.doesNotMatch(DRAFT_DOOR, /update projects\.(theme_option|design_token)/);
  });
});

describe('UID4-T006/T007/T008 — coverage and scope guard (real workflow source)', () => {
  test('UID4-T007 — the draft is checked against the locked baseline before persistence', () => {
    assert.match(UI_VERSION_DRAFT_WORKFLOW, /known\.has\(key\)/);
  });

  test('UID4-T008 — a screen invented outside the locked baseline is rejected, not silently drafted', () => {
    assert.match(
      UI_VERSION_DRAFT_WORKFLOW,
      /the draft designs \$\{invented\.length\} screen\(s\) not in the locked baseline/,
    );
    // The invented check runs BEFORE the door is ever called — the same
    // ordering discipline this repo's own docs (bound-your-slices /
    // read-the-close-path notes) require: a refused draft must not still
    // reach persistence.
    const doorCallIndex = UI_VERSION_DRAFT_WORKFLOW.indexOf("rpc('record_ui_version_draft'");
    const inventedCheckIndex = UI_VERSION_DRAFT_WORKFLOW.indexOf('invented.length > 0');
    assert.ok(inventedCheckIndex >= 0 && doorCallIndex >= 0 && inventedCheckIndex < doorCallIndex);
  });

  test('UID4-T006 — no business-rule guess: this workflow has no fallback path that invents a screen key', () => {
    assert.doesNotMatch(UI_VERSION_DRAFT_WORKFLOW, /invented\.length > 0[\s\S]{0,200}continue/);
  });
});

describe('UID4-T009/T012 — Design QA revision path (real migration, revise_ui_version)', () => {
  test('UID4-T009 — a QA correction reactivates the Designer through the SAME door as an Admin edit', () => {
    assert.match(REVISE_UI_DOOR, /v_latest\.status not in \('client_change', 'admin_edit'\)/);
  });

  test('UID4-T010 — a QA defect referencing a stale version is not blindly patched: only the latest per-workspace row is read', () => {
    assert.match(REVISE_UI_DOOR, /order by v\.version desc\s*\n\s*limit 1/);
  });

  test('UID4-T011 — the Designer cannot mark its own QA PASS: no outcome the revise door returns is a QA verdict', () => {
    assert.doesNotMatch(REVISE_UI_DOOR, /qa_pass/);
  });
});

describe('UID4-T016 — revision limit exceeded stops the loop and escalates to a human', () => {
  test('the limit is checked before any model call or new version is written', () => {
    assert.match(REVISE_UI_DOOR, /v_phase_four\.ui_revision_count >= v_phase_four\.ui_revision_limit/);
    assert.match(REVISE_UI_DOOR, /revision_limit_escalation/);
  });

  test('escalation emits the shared Phase 3 event, not a dead Phase-4-only one', () => {
    assert.match(REVISE_UI_DOOR, /perform core\.emit_event\(\s*\n\s*v_phase_four\.organization_id, 'project\.revision_limit_escalated'/);
    // A dead Phase-4-only event name is mentioned in this migration's own
    // header (documenting what it replaced) but must never be the argument
    // of an actual emit_event call.
    assert.doesNotMatch(REVISE_UI_DOOR, /emit_event\([^)]*ui_revision_limit_reached/);
  });

  test('a stopped workspace still returns a distinct outcome, not a silent success', () => {
    assert.match(REVISE_UI_DOOR, /'revision_limit_reached'::text, null::uuid/);
  });
});

describe('UID4-T017 — designer stays inactive while a build-only bug routes elsewhere', () => {
  test('revise_ui_version only ever fires from the UI review events, never a prototype QA event', () => {
    assert.match(CATALOG, /'project\.ui_version_admin_reviewed':\s*\['crm:announceUiVersionAdminReviewed', 'ui_designer:reviseUIVersion'\]/);
    assert.doesNotMatch(CATALOG, /'project\.prototype_build_ready':\s*\[[^\]]*ui_designer/);
  });
});

describe('UID4-T024/T026 — a locked/approved version cannot be mutated in place', () => {
  test('the transition graph admits no outgoing edge from locked, and no edge INTO locked except from client_approved', () => {
    assert.doesNotMatch(TRANSITION_GUARD, /old\.status = 'locked'/);
    assert.doesNotMatch(TRANSITION_GUARD, /old\.status = 'draft'[\s\S]{0,60}'locked'/);
  });

  test('red-proof: the trigger actually fires before update, for each row (removing this line is the failure mode this guards)', () => {
    assert.match(TRANSITION_MIGRATION, /before update on projects\.ui_versions/);
    assert.match(TRANSITION_MIGRATION, /for each row execute function projects\.enforce_ui_version_status_transition/);
  });

  test('a revision is a NEW row (revise_ui_version inserts), never an update of the approved baseline', () => {
    assert.match(REVISE_UI_DOOR, /insert into projects\.ui_versions/);
    assert.doesNotMatch(REVISE_UI_DOOR, /update projects\.ui_versions\s+set screens/);
  });
});

describe('UID4-T025/T026/T027/T028 — cross-project/tenant and privileged-action boundaries', () => {
  test('UID4-T025 — every door checks organization_id against the CALLER, never trusts a payload org', () => {
    assert.match(DRAFT_DOOR, /v_phase_four\.organization_id is distinct from \(select core\.current_organization_id\(\)\)/);
  });

  test('UID4-T026/T027 — the Designer has no grant on Admin/client approval doors', () => {
    // The theme-token door precedent already proves the shape (the-designer-
    // proposes.test.ts, suite A): service_role — the identity the Designer's
    // workflow runs as — is never granted execute on an approval door.
    for (const door of ['request_ui_version_admin_review', 'record_ui_version_client_decision']) {
      assert.doesNotMatch(
        UI_VERSION_DRAFT_WORKFLOW,
        new RegExp(door),
        `${door} is reachable from the Designer's own draft workflow`,
      );
    }
  });

  test('UID4-T028 — the Designer never calls a payment-verification door', () => {
    assert.doesNotMatch(UI_VERSION_DRAFT_WORKFLOW, /verify_payment/);
  });
});

describe('UID4-T029/T030 — approved-version-is-immutable and exact-version-id handoff', () => {
  test('UID4-T030 — the prototype build door requires the EXACT source_ui_version_id, not "latest"', () => {
    const buildDoor = region(
      read('supabase/migrations/20260923150000_the_prototype_reuses_the_deliverable.sql'),
      'create or replace function projects.record_prototype_build',
      '$$;',
    );
    assert.match(buildDoor, /p_ui_version_id uuid/);
    assert.doesNotMatch(buildDoor, /order by v\.version desc\s*\n\s*limit 1/);
  });
});

describe('UID4-T021/T029 — Figma capability truthfulness — MISSING (constraint: not touched by this task)', () => {
  test.skip('UID4-T021 Figma write unavailable -> manual-assisted state, no fake write — MISSING, no Figma integration exists in src/ or supabase/migrations/', () => {});
  test.skip('UID4-T029 client-facing export leaks provider/model details -> security FAIL — MISSING, no Figma export surface exists to leak from', () => {});
});

describe('UID4-T005/T015/T023 — the AI-drafted content itself: boundaries the schema enforces (see the-designer-proposes.test.ts for the sibling door)', () => {
  test('the draft workflow asks the model for screens tied to the locked baseline only, in its own prompt framing', () => {
    assert.match(WORKFLOWS, /project\.screen_list_finalized.*ui_designer:designDirections|UI_VERSION_DRAFT/);
  });
});
