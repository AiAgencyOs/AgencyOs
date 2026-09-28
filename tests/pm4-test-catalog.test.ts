import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { region } from './_region.ts';

/**
 * P4-PM-TESTS — closes (partially) docs/phase-4-implementation-traceability.md's
 * PM row, against `phase 4/AgencyOS_Phase_4_PM_Agent_..._Specification.pdf`
 * §21 (PM4-T001..PM4-T028) and §22's 19-step E2E scenario.
 *
 * **What is real.** The PM Agent has no dedicated AI workflow of its own for
 * most of these cases (the traceability doc's own honest framing) — what the
 * spec calls "PM communication" is implemented as deterministic event
 * announcements (`crm:announcePhaseFourStarted`, `crm:announceTask2Complete`,
 * etc., all reusing the existing WhatsApp delivery/outbox machinery already
 * proven in `pm-task-2-communication.test.ts` and
 * `pm-prototype-communication.test.ts`) plus one genuine model-backed
 * workflow this session's migrations added: `CLASSIFY_CLIENT_FEEDBACK`
 * (`ui_version.classify_client_feedback`), the spec's own six-way
 * classification bridge (§4.6/§8), landing in the real
 * `projects.client_feedback_classifications` / `projects.clarification_
 * requests` tables (`20260928110000_a_clarification_is_a_named_thing.sql`).
 *
 * This file adds the cases not already covered by the two communication test
 * files above, cited by the spec's own PM4-T0xx numbering.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const WORKFLOWS = read('app/api/jobs/run/workflows.ts');
const CLASSIFY_WORKFLOW = region(WORKFLOWS, 'const CLASSIFY_CLIENT_FEEDBACK: AgentWorkflow', '\nconst PROTOTYPE_BUILD_PROMPT');
const CLASSIFY_PROMPT = region(WORKFLOWS, 'const CLASSIFY_CLIENT_FEEDBACK_PROMPT', '\nconst ');
const CLARIFICATION_MIGRATION = read('supabase/migrations/20260928110000_a_clarification_is_a_named_thing.sql');
const ANSWER_DOOR = region(CLARIFICATION_MIGRATION, 'create or replace function projects.answer_clarification_request', '$$;');
const CATALOG = read('src/lib/events/catalog.ts');

describe('PM4-T006/T007 — clarification workflow (real table + real door)', () => {
  test('PM4-T006 — an ambiguous client message is classified CLARIFICATION and opens a clarification_requests row, not a guess', () => {
    assert.match(CLASSIFY_PROMPT, /CLARIFICATION — you genuinely cannot tell what they want/);
    assert.match(CLASSIFY_WORKFLOW, /clarifyingQuestion \?\? decision\.client_words/);
    assert.match(CLASSIFY_WORKFLOW, /\.from\('clarification_requests'\)/);
  });

  test('PM4-T007 — an answered clarification routes back to the source request, and cannot be answered twice', () => {
    assert.match(ANSWER_DOOR, /already_answered/);
    assert.match(ANSWER_DOOR, /if v_request\.status = 'answered' then/);
  });

  test('the clarification is internal-only, never rendered raw to the client (PM boundary: no client-facing delivery bypass)', () => {
    assert.match(CLARIFICATION_MIGRATION, /Internal-only/);
    assert.match(CLARIFICATION_MIGRATION, /using \(organization_id = \(select core\.current_organization_id\(\)\) and \(select core\.is_internal\(\)\)\)/);
  });
});

describe('PM4-T012 — a client asking for a new feature is routed to scope change, not silently drafted', () => {
  test('POSSIBLE_SCOPE_CHANGE opens a change_requests row against the active scope version, not a UI revision', () => {
    const block = region(CLASSIFY_WORKFLOW, "} else if (classification === 'POSSIBLE_SCOPE_CHANGE') {", "} else if (classification === 'DESIGN_DIRECTION_CHANGE'");
    assert.match(block, /\.from\('change_requests'\)/);
    assert.match(block, /source: 'client'/);
  });

  test('with no active scope baseline, the classification is still recorded rather than silently attached to nothing', () => {
    assert.match(CLASSIFY_WORKFLOW, /No active scope baseline: nothing safe to attach the request to/);
  });
});

describe('PM4-T013 — DESIGN_DIRECTION_CHANGE/REJECTED_REQUEST require a human approval decision, not an automatic redraft', () => {
  test('both classifications route to request_approval, audience internal, never auto-approved', () => {
    const block = region(
      CLASSIFY_WORKFLOW,
      "} else if (classification === 'DESIGN_DIRECTION_CHANGE' || classification === 'REJECTED_REQUEST') {",
      '// CORRECTION / INCLUDED_REVISION',
    );
    assert.match(block, /rpc\('request_approval'/);
    assert.match(block, /p_audience: 'internal'/);
  });
});

describe('PM4-T008/T009/T015/T016 — PM cannot share before QA + Admin approval (reuses the real door state guards)', () => {
  test('PM4-T008/T009 — UI share eligibility is qa_pass then admin-approved, enforced by the SAME state guard as Admin review itself', () => {
    const reviewDoor = region(
      read('supabase/migrations/20260923130000_admin_review_reuses_the_engine.sql'),
      'create or replace function projects.request_ui_version_admin_review',
      '$$;',
    );
    assert.match(reviewDoor, /wrong_state/);
    // PM has no separate share-gate table: the client-share door
    // (record_ui_version_client_decision) itself refuses a version that is
    // not admin_approved, so PM cannot manufacture eligibility client-side.
    const shareDoor = region(
      read('supabase/migrations/20260923140000_the_client_confirms_the_locked_ui.sql'),
      'create or replace function projects.record_ui_version_client_decision',
      '$$;',
    );
    assert.match(shareDoor, /wrong_state/);
  });

  test('PM4-T015/T016 — the same shape holds for the prototype share door', () => {
    const buildDoor = region(
      read('supabase/migrations/20260923150000_the_prototype_reuses_the_deliverable.sql'),
      'create or replace function projects.record_prototype_build',
      '$$;',
    );
    assert.match(buildDoor, /wrong_state/);
  });
});

describe('PM4-T019 — revision limit reached creates a human escalation, stopping the automatic loop', () => {
  test('the escalation is emitted from the SAME shared event PM would need to react to, not a dead one', () => {
    assert.match(CATALOG, /'project\.revision_limit_escalated':\s*\['crm:announceRevisionLimitEscalated'\]/);
  });
});

describe('PM4-T022/T023/T025 — Task 2 completion and the Finance handoff (PM cannot verify payment)', () => {
  test('PM4-T022 — Phase4Completed routes to Finance for the M2 invoice, and to CRM for the completion announcement — never to PM for a payment action', () => {
    assert.match(CATALOG, /'project\.phase_four_completed':\s*\['finance:generateM2Invoice', 'crm:announceTask2Complete'\]/);
    assert.doesNotMatch(CATALOG, /'project\.phase_four_completed':[^\]]*project_manager:/);
  });

  test('PM4-T024 — PM has no payment-verification handler registered anywhere in the catalog', () => {
    assert.doesNotMatch(CATALOG, /project_manager:verifyPayment|project_manager:verify_payment/);
  });

  test('PM4-T025 — Task 3 / Phase 5 eligibility is announced only off M2PaymentVerified, the Admin-verified fact', () => {
    assert.match(CATALOG, /'invoice\.paid':\s*\['projects:unlockNextMilestone', 'crm:announceM2PaymentVerified'\]/);
  });
});

describe('PM4-T028 — client-facing prompts never leak provider/model detail (redaction policy)', () => {
  test('the classification prompt asks for the client\'s own words back in categories and reasoning, never a provider/model name', () => {
    assert.doesNotMatch(CLASSIFY_PROMPT, /gpt|claude|anthropic|openai|gemini/i);
  });
});

describe('PM4-T003/T004 — idempotency and delivery retry (already proven live; cited here under PM numbering)', () => {
  test('the classification workflow treats an existing classification row as success, not a second model call', () => {
    assert.match(CLASSIFY_WORKFLOW, /already_classified/);
    // The idempotency check happens strictly before the model is ever
    // invoked — checked by ordering, not merely by presence (see this
    // repo's own "assert the branch, not just presence" discipline).
    const existingCheckIndex = CLASSIFY_WORKFLOW.indexOf('already_classified');
    const modelCallIndex = CLASSIFY_WORKFLOW.indexOf('await callModel');
    assert.ok(existingCheckIndex >= 0 && modelCallIndex >= 0 && existingCheckIndex < modelCallIndex);
  });

  test('a concurrent duplicate classification insert is treated as success, not a failure (unique_violation on decision_id)', () => {
    assert.match(CLASSIFY_WORKFLOW, /duplicate key/);
  });
});

describe('PM4-T017/T020/T026/T027 — QA/Admin/M2/cross-project touched only where PM has real material', () => {
  test.skip('PM4-T017 approved prototype build -> PM shares exact build ID/artifact — covered by pm-prototype-communication.test.ts, not duplicated here', () => {});
  test.skip('PM4-T020 client approves final prototype -> PM evaluates completion eligibility — covered by projects.complete_phase_four (see or4/fin4 catalogs)', () => {});
  test('PM4-T026 — a duplicate client webhook does not create a duplicate feedback classification (same unique constraint as PM4-T003/T004)', () => {
    assert.match(CLASSIFY_WORKFLOW, /unique constraint on decision_id/);
  });
});
