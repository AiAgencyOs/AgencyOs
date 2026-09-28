import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';

import { parseRows, sqlJson, sqlString, startLivePostgres, type LivePostgres } from './support/live-postgres.ts';
import { buildPhase3Handoff, sampleScreens, type Phase3Handoff } from './support/phase4-fixtures.ts';

/**
 * The full Phase 4 pipeline, driven as ONE continuous live session against a
 * real, scratch Postgres — the piece of test evidence this repository's own
 * `docs/phase-4-implementation-traceability.md` never had. Every earlier
 * "Live-verified on scratch Postgres" row there describes a one-off manual
 * session (`KEEP=1 scripts/apply-migrations-locally.sh`, driven by hand,
 * then pinned as a regex over the migration source). This file is the
 * automated version of that manual session: `tests/support/live-postgres.ts`
 * boots the same scratch instance the same way, and every assertion below
 * reads a REAL value a real SQL door produced, not a string match against
 * source text.
 *
 * The chain: Phase 3 baseline locked -> start_phase_four -> UI version draft
 * -> Design QA (qa_pass) -> Admin review (approved) -> client review
 * (approved) -> lock -> prototype build -> Prototype QA (qa_pass) -> submit
 * for review (the real approvals/deliverables engine, client-audience
 * approval) -> client approves -> phase_four completes -> M2 (20%) invoice
 * -> payment verified through finance.verify_payment_submission's real
 * admin-session path -> record_manual_payment -> finance.verify_payment ->
 * phase_five_gate_status() returns its real success value.
 *
 * Every step is a real door/RPC call; the only direct INSERTs are for rows
 * that genuinely have no door (an org, a client account, the project itself,
 * a scope version, a screen) — see `tests/support/phase4-fixtures.ts`'s own
 * header for why Phase 2/3 are treated as pre-existing state here rather
 * than driven through their own start doors.
 */

const BUDGET_MINOR = 1_000_000; // an arbitrary, round contract value: 20% of it must be exactly 200000
const M2_PERCENT = 20;
const EXPECTED_M2_AMOUNT_MINOR = Math.round((BUDGET_MINOR * M2_PERCENT) / 100);

function assertOutcome(actual: string, expected: string, step: string): void {
  assert.equal(actual, expected, `${step}: expected outcome '${expected}', got '${actual}'`);
}

function firstRow(output: string): string[] {
  const rows = parseRows(output);
  assert.ok(rows.length > 0, `expected at least one row, got:\n${output}`);
  return rows[0]!;
}

function scalar(output: string): string {
  return firstRow(output)[0]!;
}

// ── Task 1's own proof: the harness tears down even when a test throws ─────
//
// node:test's `after()` hook is documented to run regardless of whether an
// earlier test in the same scope passed or threw. This test proves the
// harness's OWN `stop()` actually does its job when driven the way a real
// test failure would drive it: acquire a live instance, throw from inside
// the code path that was using it, and confirm — from OUTSIDE, by asking
// the OS/pg_ctl, not by trusting the harness's own bookkeeping — that no
// server process and no work directory are left behind.
describe('Harness: teardown runs even when the caller throws', () => {
  test('stop() tears down a live instance acquired right before an intentional throw', () => {
    const scratch = startLivePostgres({ timeoutMs: 120_000 });
    const dataDir = scratch.dataDir;
    const workDir = scratch.host;

    let caught: unknown;
    try {
      try {
        // A real query first, so this is provably a live instance and not a
        // stub — then the intentional failure a real test body would throw.
        scratch.admin('select 1;');
        throw new Error('intentional failure inside the harness-using test body');
      } finally {
        // This mirrors what a `node:test` `after()` hook does for the real
        // pipeline suite below: teardown runs in a `finally`/`after`, not
        // conditionally on success.
        scratch.stop();
      }
    } catch (err) {
      caught = err;
    }

    assert.ok(caught instanceof Error);
    assert.equal((caught as Error).message, 'intentional failure inside the harness-using test body');

    // Proof from outside the harness: pg_ctl itself says nothing is running
    // at that data directory, and the scratch work directory is gone.
    const status = spawnSync('pg_ctl', ['-D', dataDir, 'status'], { encoding: 'utf8' });
    assert.notEqual(status.status, 0, 'expected pg_ctl to report no server running after stop()');
    assert.equal(existsSync(workDir), false, 'expected the scratch work directory to be removed after stop()');

    // stop() must also be safe to call again (a real after() hook might run
    // after a test already called it in a finally, or vice versa).
    assert.doesNotThrow(() => scratch.stop());
  });
});

// ── The full pipeline ───────────────────────────────────────────────────────

describe('Phase 4 full pipeline, live end to end', () => {
  let db: LivePostgres;
  let fx: Phase3Handoff;
  let phaseFourId: string;
  let uiVersionId: string;
  let prototypeArtifactId: string;
  let deliverableId: string;
  let m2Invoice: { id: string; number: string };
  let m2MilestoneId: string;

  before(() => {
    db = startLivePostgres({ timeoutMs: 180_000 });
  }, { timeout: 200_000 });

  after(() => {
    db?.stop();
  }, { timeout: 30_000 });

  test('Phase 3 locks with phase_four_ready = true', async () => {
    fx = await buildPhase3Handoff(db, { label: 'Main', budgetMinor: BUDGET_MINOR }, assertOutcome);

    const ready = scalar(
      db.admin(
        `select phase_four_ready from projects.phase_three_handoffs where id = '${fx.phaseThreeHandoffId}';`,
      ),
    );
    assert.equal(ready, 't', 'expected the locked handoff to be phase_four_ready');
  });

  test('start_phase_four opens the Task 2 workspace', () => {
    const started = firstRow(
      db.queryAs(
        'authenticated',
        `select * from projects.start_phase_four(p_project_id => '${fx.projectId}');`,
        fx.ownerClaims,
      ),
    );
    assertOutcome(started[0]!, 'started', 'start_phase_four');
    phaseFourId = started[1]!;

    const state = scalar(db.admin(`select state from projects.phase_four where id = '${phaseFourId}';`));
    assert.equal(state, 'task2_started');
  });

  test('the UI Designer drafts a version', () => {
    const drafted = firstRow(
      db.queryAs(
        'service_role',
        `select * from projects.record_ui_version_draft(
           p_phase_four_id => '${phaseFourId}', p_screens => ${sqlJson(sampleScreens(1))}
         );`,
      ),
    );
    assertOutcome(drafted[0]!, 'drafted', 'record_ui_version_draft');
    uiVersionId = drafted[1]!;

    const status = scalar(db.admin(`select status from projects.ui_versions where id = '${uiVersionId}';`));
    assert.equal(status, 'draft');
  });

  test('Design QA passes the version', () => {
    const verdict = firstRow(
      db.queryAs(
        'service_role',
        `select * from projects.record_ui_version_qa_verdict(
           p_ui_version_id => '${uiVersionId}', p_outcome => 'qa_pass',
           p_findings => ${sqlJson({ notes: 'Meets the locked design tokens.' })}
         );`,
      ),
    );
    assertOutcome(verdict[0]!, 'recorded', 'record_ui_version_qa_verdict');

    const status = scalar(db.admin(`select status from projects.ui_versions where id = '${uiVersionId}';`));
    assert.equal(status, 'qa_pass');
  });

  test('Admin review: a policy is required, then the real approvals engine decides it', () => {
    const policy = firstRow(
      db.queryAs(
        'authenticated',
        `select * from approvals.set_policy(
           p_subject_type => 'ui_version', p_min_amount_minor => 0,
           p_required_role => 'owner', p_sla_hours => 24, p_audience => 'internal'
         );`,
        fx.ownerClaims,
      ),
    );
    assertOutcome(policy[0]!, 'saved', 'approvals.set_policy(ui_version)');

    const requested = firstRow(
      db.queryAs(
        'service_role',
        `select * from projects.request_ui_version_admin_review(p_ui_version_id => '${uiVersionId}');`,
      ),
    );
    assertOutcome(requested[0]!, 'requested', 'request_ui_version_admin_review');

    const statusAfterRequest = scalar(
      db.admin(`select status from projects.ui_versions where id = '${uiVersionId}';`),
    );
    assert.equal(statusAfterRequest, 'admin_review');

    const requestId = scalar(
      db.admin(
        `select id from approvals.approval_requests where subject_type = 'ui_version' and subject_id = '${uiVersionId}' order by created_at desc limit 1;`,
      ),
    );

    const decided = firstRow(
      db.queryAs(
        'authenticated',
        `select * from approvals.decide_approval(p_request_id => '${requestId}', p_decision => 'approved', p_note => 'Looks right.');`,
        fx.ownerClaims,
      ),
    );
    assertOutcome(decided[0]!, 'decided', 'approvals.decide_approval(ui_version)');

    const synced = scalar(
      db.queryAs(
        'authenticated',
        `select projects.sync_ui_version_decision(p_ui_version_id => '${uiVersionId}');`,
        fx.ownerClaims,
      ),
    );
    assert.equal(synced, 'admin_approved', `sync_ui_version_decision: expected 'admin_approved', got '${synced}'`);
  });

  test('the client reviews and approves the UI version, and it locks', () => {
    const shared = firstRow(
      db.queryAs(
        'authenticated',
        `select * from projects.share_ui_version_with_client(
           p_ui_version_id => '${uiVersionId}', p_evidence_ref => 'whatsapp-thread-ui-share'
         );`,
        fx.ownerClaims,
      ),
    );
    assertOutcome(shared[0]!, 'shared', 'share_ui_version_with_client');

    const decision = firstRow(
      db.queryAs(
        'authenticated',
        `select * from projects.record_ui_version_client_decision(
           p_ui_version_id => '${uiVersionId}', p_decision => 'final_confirmed',
           p_client_words => 'This matches what we agreed, please build it.'
         );`,
        fx.ownerClaims,
      ),
    );
    assertOutcome(decision[0]!, 'recorded', 'record_ui_version_client_decision');

    const statusAfterConfirm = scalar(
      db.admin(`select status from projects.ui_versions where id = '${uiVersionId}';`),
    );
    assert.equal(statusAfterConfirm, 'client_approved');

    const locked = firstRow(
      db.queryAs(
        'authenticated',
        `select * from projects.lock_ui_version(p_ui_version_id => '${uiVersionId}');`,
        fx.ownerClaims,
      ),
    );
    assertOutcome(locked[0]!, 'locked', 'lock_ui_version');

    const finalStatus = scalar(db.admin(`select status from projects.ui_versions where id = '${uiVersionId}';`));
    assert.equal(finalStatus, 'locked');
  });

  test('the prototype is built and passes QA', () => {
    const built = firstRow(
      db.queryAs(
        'service_role',
        `select * from projects.record_prototype_build(
           p_ui_version_id => '${uiVersionId}', p_screens => ${sqlJson(sampleScreens(1))}
         );`,
      ),
    );
    assertOutcome(built[0]!, 'built', 'record_prototype_build');
    prototypeArtifactId = built[1]!;
    deliverableId = built[2]!;
    assert.ok(prototypeArtifactId, 'expected a prototype_artifact_id');
    assert.ok(deliverableId, 'expected a deliverable_id');

    const verdict = firstRow(
      db.queryAs(
        'service_role',
        `select * from projects.record_prototype_qa_verdict(
           p_prototype_artifact_id => '${prototypeArtifactId}', p_outcome => 'qa_pass',
           p_findings => ${sqlJson({ notes: 'Interactive prototype matches the locked UI version.' })}
         );`,
      ),
    );
    assertOutcome(verdict[0]!, 'recorded', 'record_prototype_qa_verdict');

    const artifactStatus = scalar(
      db.admin(`select status from projects.prototype_artifacts where id = '${prototypeArtifactId}';`),
    );
    assert.equal(artifactStatus, 'qa_pass');
  });

  test('the prototype deliverable is submitted for review and the client approves it, through the real approvals engine', () => {
    const policy = firstRow(
      db.queryAs(
        'authenticated',
        `select * from approvals.set_policy(
           p_subject_type => 'deliverable', p_min_amount_minor => 0,
           p_required_role => 'owner', p_sla_hours => 24, p_audience => 'client'
         );`,
        fx.ownerClaims,
      ),
    );
    assertOutcome(policy[0]!, 'saved', 'approvals.set_policy(deliverable, client audience)');

    const submitted = firstRow(
      db.queryAs(
        'authenticated',
        `select * from projects.submit_deliverable(
           p_deliverable_id => '${deliverableId}', p_requested_by => '${fx.ownerId}',
           p_summary => 'Prototype v1 ready for client review'
         );`,
        fx.ownerClaims,
      ),
    );
    assertOutcome(submitted[0]!, 'submitted', 'submit_deliverable');
    const requestId = submitted[1]!;

    const deliverableStatusAfterSubmit = scalar(
      db.admin(`select status from projects.deliverables where id = '${deliverableId}';`),
    );
    assert.equal(deliverableStatusAfterSubmit, 'in_review');

    // A client-audience decision requires evidence — approval_requests_client_evidence
    // — the real record of how the client actually said yes.
    const decided = firstRow(
      db.queryAs(
        'authenticated',
        `select * from approvals.decide_approval(
           p_request_id => '${requestId}', p_decision => 'approved',
           p_note => 'Client approved on the review call.',
           p_evidence_ref => 'call-transcript-prototype-approval'
         );`,
        fx.ownerClaims,
      ),
    );
    assertOutcome(decided[0]!, 'decided', 'approvals.decide_approval(deliverable, client)');

    const synced = scalar(
      db.queryAs(
        'authenticated',
        `select projects.sync_deliverable_decision(p_deliverable_id => '${deliverableId}');`,
        fx.ownerClaims,
      ),
    );
    assert.equal(synced, 'approved', `sync_deliverable_decision: expected 'approved', got '${synced}'`);
  });

  test('phase_four completes', () => {
    // In production a `project.deliverable_decided` job handler filters to
    // kind='prototype', status='approved' and calls this door (see
    // 20260923160000_m2_and_the_gate_it_actually_needs.sql's header) — there
    // is no job runner here, so the door itself, the actual unit under test,
    // is called directly.
    const completed = firstRow(
      db.queryAs('service_role', `select * from projects.complete_phase_four(p_project_id => '${fx.projectId}');`),
    );
    assertOutcome(completed[0]!, 'completed', 'complete_phase_four');

    const state = scalar(db.admin(`select state from projects.phase_four where id = '${phaseFourId}';`));
    assert.equal(state, 'completed');
    const completedAt = scalar(
      db.admin(`select completed_at is not null from projects.phase_four where id = '${phaseFourId}';`),
    );
    assert.equal(completedAt, 't');
  });

  test('the locked payment structure installs with M2 at exactly 20% of the contract value', () => {
    // Mirrors installLockedPaymentStructure (src/modules/projects/service.ts)
    // exactly: percentages 30/20/30/20, each amount round()ed except the
    // last, which absorbs the remainder so the four sum to budget_minor.
    const percents = [30, 20, 30, 20];
    let taken = 0;
    const amounts = percents.map((percent, index) => {
      const amount =
        index === percents.length - 1 ? BUDGET_MINOR - taken : Math.round((BUDGET_MINOR * percent) / 100);
      taken += amount;
      return amount;
    });
    assert.equal(amounts[1]!, EXPECTED_M2_AMOUNT_MINOR, 'sanity: M2 amount must equal 20% of the contract value');

    const milestones = [
      { name: 'Advance (30%)', percent: 30, amountMinor: amounts[0]!, dueOn: null },
      { name: 'On UI prototype approval (20%)', percent: 20, amountMinor: amounts[1]!, dueOn: null },
      { name: 'On development completion (30%)', percent: 30, amountMinor: amounts[2]!, dueOn: null },
      { name: 'On testing completion (20%)', percent: 20, amountMinor: amounts[3]!, dueOn: null },
    ];

    const replaced = firstRow(
      db.queryAs(
        'authenticated',
        `select * from projects.replace_payment_plan(p_project_id => '${fx.projectId}', p_milestones => ${sqlJson(milestones)});`,
        fx.ownerClaims,
      ),
    );
    assertOutcome(replaced[0]!, 'replaced', 'replace_payment_plan');

    // projects.replace_payment_plan numbers milestones 0-indexed
    // (jsonb_array_elements ... WITH ORDINALITY minus one) — M2 is the
    // SECOND element, position 1, not 2. Confirmed against the real function
    // (see 20260929100000_the_gate_read_the_wrong_milestone.sql, the fix
    // this test file's own run against a live Postgres found necessary).
    const m2Row = firstRow(
      db.admin(
        `select id, amount_minor, payment_percent, name from projects.milestones where project_id = '${fx.projectId}' and position = 1;`,
      ),
    );
    m2MilestoneId = m2Row[0]!;
    assert.equal(Number(m2Row[1]!), EXPECTED_M2_AMOUNT_MINOR, 'M2 milestone amount_minor must equal 20% of budget_minor');
    assert.equal(Number(m2Row[2]!), 20, 'M2 milestone payment_percent must be 20');
  });

  test('the M2 invoice is generated for exactly 20% of the contract value', () => {
    // generateM2Invoice (src/modules/finance/service.ts) reads the M2
    // milestone and calls this same SQL door with an admin (service-role)
    // client; called directly here since there is no Next.js server in this
    // harness, but it is the identical real door with the identical
    // pre-computed amount.
    const number = `E2E-M2-${fx.projectId.slice(0, 8)}`;
    const lines = [
      {
        position: 0,
        description: 'On UI prototype approval (20%)',
        quantity: 1,
        unit_price_minor: EXPECTED_M2_AMOUNT_MINOR,
        amount_minor: EXPECTED_M2_AMOUNT_MINOR,
        tax_rate_bp: 0,
      },
    ];

    const created = firstRow(
      db.queryAs(
        'service_role',
        `select * from finance.create_milestone_invoice(
           p_organization_id => '${fx.orgId}', p_client_account_id => '${fx.clientAccountId}',
           p_project_id => '${fx.projectId}', p_milestone_id => '${m2MilestoneId}',
           p_number => ${sqlString(number)}, p_currency => 'INR',
           p_subtotal_minor => ${EXPECTED_M2_AMOUNT_MINOR}, p_tax_minor => 0,
           p_total_minor => ${EXPECTED_M2_AMOUNT_MINOR}, p_lines => ${sqlJson(lines)}
         );`,
      ),
    );
    assertOutcome(created[0]!, 'created', 'finance.create_milestone_invoice');
    m2Invoice = { id: created[1]!, number: created[2]! };

    const invoiceRow = firstRow(
      db.admin(
        `select subtotal_minor, total_minor, status, milestone_id from finance.invoices where id = '${m2Invoice.id}';`,
      ),
    );
    assert.equal(Number(invoiceRow[0]!), EXPECTED_M2_AMOUNT_MINOR, 'M2 invoice subtotal_minor must equal 20% of budget_minor');
    assert.equal(Number(invoiceRow[1]!), EXPECTED_M2_AMOUNT_MINOR, 'M2 invoice total_minor must equal 20% of budget_minor');
    assert.equal(invoiceRow[2]!, 'draft');
    assert.equal(invoiceRow[3]!, m2MilestoneId);

    const issued = firstRow(
      db.queryAs(
        'authenticated',
        `select * from finance.issue_invoice(p_invoice_id => '${m2Invoice.id}');`,
        fx.ownerClaims,
      ),
    );
    assertOutcome(issued[0]!, 'issued', 'finance.issue_invoice');
  });

  test('the payment is verified through the real finance.verify_payment_submission admin-session path, and the invoice reaches paid', () => {
    // recordPaymentSubmission (src/modules/finance/service.ts) is a plain,
    // RLS-gated INSERT (no RPC exists) requiring an owner/ops_admin session —
    // reproduced here exactly, as the authenticated owner.
    const submissionId = scalar(
      db.queryAs(
        'authenticated',
        `insert into finance.payment_submissions (
           organization_id, invoice_id, amount_minor, method, reference, payer_name, submitted_by
         ) values (
           '${fx.orgId}', '${m2Invoice.id}', ${EXPECTED_M2_AMOUNT_MINOR}, 'bank_transfer',
           'UTR-E2E-0001', 'Acme Client', '${fx.ownerId}'
         ) returning id;`,
        fx.ownerClaims,
      ),
    );

    // The real admin-session door: finance.verify_payment_submission. This is
    // the exact function the task names — not a job, not the service role.
    const verified = firstRow(
      db.queryAs(
        'authenticated',
        `select * from finance.verify_payment_submission(
           p_submission_id => '${submissionId}', p_verified_by => '${fx.ownerId}',
           p_evidence => 'Bank statement confirms UTR-E2E-0001 for the full M2 amount.',
           p_decision => 'confirm'
         );`,
        fx.ownerClaims,
      ),
    );
    assertOutcome(verified[0]!, 'verified', 'finance.verify_payment_submission');

    const submissionStatus = scalar(
      db.admin(`select status from finance.payment_submissions where id = '${submissionId}';`),
    );
    assert.equal(submissionStatus, 'verified');

    // Verifying the CLAIM is not paying — finance.verify_payment_submission
    // never touches finance.invoices/finance.payments (Finance §12-17's rule,
    // restated in 20260923160000's own migration header). The ledger entry
    // and its own separate verification are what move the invoice to 'paid'.
    const recorded = firstRow(
      db.queryAs(
        'authenticated',
        `select * from finance.record_manual_payment(
           p_invoice_id => '${m2Invoice.id}', p_provider_payment_id => 'UTR-E2E-0001',
           p_amount_minor => ${EXPECTED_M2_AMOUNT_MINOR}, p_captured_at => now(),
           p_method => 'bank_transfer'
         );`,
        fx.ownerClaims,
      ),
    );
    assertOutcome(recorded[0]!, 'recorded', 'finance.record_manual_payment');
    const paymentId = recorded[1]!;

    const statusAfterRecord = scalar(
      db.admin(`select status from finance.invoices where id = '${m2Invoice.id}';`),
    );
    assert.equal(statusAfterRecord, 'partially_paid', 'recording money is a claim, not yet a settlement');

    const paymentVerified = firstRow(
      db.queryAs(
        'authenticated',
        `select * from finance.verify_payment(p_payment_id => '${paymentId}', p_verified_by => '${fx.ownerId}');`,
        fx.ownerClaims,
      ),
    );
    assertOutcome(paymentVerified[0]!, 'verified', 'finance.verify_payment');

    const invoiceRow = firstRow(
      db.admin(`select status, verified_minor, total_minor from finance.invoices where id = '${m2Invoice.id}';`),
    );
    assert.equal(invoiceRow[0]!, 'paid', 'the M2 invoice must reach paid once verified_minor covers total_minor');
    assert.equal(Number(invoiceRow[1]!), Number(invoiceRow[2]!));
  });

  test('phase_five_gate_status() returns its real success value', () => {
    const gate = firstRow(
      db.queryAs(
        'authenticated',
        `select * from projects.phase_five_gate_status(p_project_id => '${fx.projectId}');`,
        fx.ownerClaims,
      ),
    );
    assert.equal(gate[0]!, 'verified', `phase_five_gate_status: expected 'verified', got '${gate[0]!}'`);
    assert.equal(gate[1]!, m2Invoice.id);
    assert.equal(gate[2]!, 'paid');
  });
});

// ── Negative path: the UI revision loop stops at its configured limit ──────

describe('Negative path: the UI revision loop stops at its configured limit', () => {
  let db: LivePostgres;
  let fx: Phase3Handoff;
  let phaseFourId: string;

  before(() => {
    db = startLivePostgres({ timeoutMs: 180_000 });
  }, { timeout: 200_000 });

  after(() => {
    db?.stop();
  }, { timeout: 30_000 });

  test('drives client-requested revisions to phase_four.ui_revision_limit (default 3), then refuses one more without writing a new row', async () => {
    fx = await buildPhase3Handoff(db, { label: 'Revision', budgetMinor: BUDGET_MINOR }, assertOutcome);

    const started = firstRow(
      db.queryAs(
        'authenticated',
        `select * from projects.start_phase_four(p_project_id => '${fx.projectId}');`,
        fx.ownerClaims,
      ),
    );
    assertOutcome(started[0]!, 'started', 'start_phase_four');
    phaseFourId = started[1]!;

    const configuredLimit = Number(
      scalar(db.admin(`select ui_revision_limit from projects.phase_four where id = '${phaseFourId}';`)),
    );
    assert.equal(configuredLimit, 3, 'sanity: the documented default ui_revision_limit is 3');

    // Set up the ui_version admin-review policy once, reused every round.
    const policy = firstRow(
      db.queryAs(
        'authenticated',
        `select * from approvals.set_policy(
           p_subject_type => 'ui_version', p_min_amount_minor => 0,
           p_required_role => 'owner', p_sla_hours => 24, p_audience => 'internal'
         );`,
        fx.ownerClaims,
      ),
    );
    assertOutcome(policy[0]!, 'saved', 'approvals.set_policy(ui_version)');

    const drafted = firstRow(
      db.queryAs(
        'service_role',
        `select * from projects.record_ui_version_draft(
           p_phase_four_id => '${phaseFourId}', p_screens => ${sqlJson(sampleScreens(0))}
         );`,
      ),
    );
    assertOutcome(drafted[0]!, 'drafted', 'record_ui_version_draft');

    // One full round: draft -> qa_pass -> admin_review -> admin_approved ->
    // client_review -> client_change -> revise_ui_version (a NEW draft row).
    async function driveOneClientChangeRound(versionId: string, variant: number): Promise<string> {
      const qa = firstRow(
        db.queryAs(
          'service_role',
          `select * from projects.record_ui_version_qa_verdict(
             p_ui_version_id => '${versionId}', p_outcome => 'qa_pass', p_findings => ${sqlJson({})}
           );`,
        ),
      );
      assertOutcome(qa[0]!, 'recorded', 'record_ui_version_qa_verdict');

      const requested = firstRow(
        db.queryAs(
          'service_role',
          `select * from projects.request_ui_version_admin_review(p_ui_version_id => '${versionId}');`,
        ),
      );
      assertOutcome(requested[0]!, 'requested', 'request_ui_version_admin_review');

      const requestId = scalar(
        db.admin(
          `select id from approvals.approval_requests where subject_type = 'ui_version' and subject_id = '${versionId}' order by created_at desc limit 1;`,
        ),
      );
      const decided = firstRow(
        db.queryAs(
          'authenticated',
          `select * from approvals.decide_approval(p_request_id => '${requestId}', p_decision => 'approved');`,
          fx.ownerClaims,
        ),
      );
      assertOutcome(decided[0]!, 'decided', 'approvals.decide_approval');

      const synced = scalar(
        db.queryAs(
          'authenticated',
          `select projects.sync_ui_version_decision(p_ui_version_id => '${versionId}');`,
          fx.ownerClaims,
        ),
      );
      assert.equal(synced, 'admin_approved');

      const shared = firstRow(
        db.queryAs(
          'authenticated',
          `select * from projects.share_ui_version_with_client(
             p_ui_version_id => '${versionId}', p_evidence_ref => 'whatsapp-round-${variant}'
           );`,
          fx.ownerClaims,
        ),
      );
      assertOutcome(shared[0]!, 'shared', 'share_ui_version_with_client');

      const clientDecision = firstRow(
        db.queryAs(
          'authenticated',
          `select * from projects.record_ui_version_client_decision(
             p_ui_version_id => '${versionId}', p_decision => 'change_requested',
             p_client_words => 'Round ${variant}: please adjust the layout.'
           );`,
          fx.ownerClaims,
        ),
      );
      assertOutcome(clientDecision[0]!, 'recorded', 'record_ui_version_client_decision(change_requested)');

      return versionId;
    }

    let currentVersionId = drafted[1]!;

    // Three real rounds bring ui_revision_count from 0 to the configured
    // limit (3): each revise_ui_version call succeeds and opens a new draft.
    for (let round = 1; round <= configuredLimit; round += 1) {
      await driveOneClientChangeRound(currentVersionId, round);

      const revised = firstRow(
        db.queryAs(
          'service_role',
          `select * from projects.revise_ui_version(
             p_phase_four_id => '${phaseFourId}', p_screens => ${sqlJson(sampleScreens(round + 1))}
           );`,
        ),
      );
      assertOutcome(revised[0]!, 'revised', `revise_ui_version round ${round}`);
      currentVersionId = revised[1]!;

      const countAfter = Number(
        scalar(db.admin(`select ui_revision_count from projects.phase_four where id = '${phaseFourId}';`)),
      );
      assert.equal(countAfter, round, `ui_revision_count should be ${round} after round ${round}`);
    }

    const countBeforeOverLimit = Number(
      scalar(db.admin(`select count(*) from projects.ui_versions where phase_four_id = '${phaseFourId}';`)),
    );
    assert.equal(
      countBeforeOverLimit,
      configuredLimit + 1,
      'expected one draft plus one new row per successful revision round',
    );

    // The 4th round: drive the SAME client-change cycle once more, then the
    // revise call itself must refuse.
    await driveOneClientChangeRound(currentVersionId, configuredLimit + 1);

    const overLimit = firstRow(
      db.queryAs(
        'service_role',
        `select * from projects.revise_ui_version(
           p_phase_four_id => '${phaseFourId}', p_screens => ${sqlJson(sampleScreens(99))}
         );`,
      ),
    );
    assertOutcome(overLimit[0]!, 'revision_limit_reached', 'revise_ui_version over the limit');

    const workspace = firstRow(
      db.admin(
        `select state, blocked_reason, ui_revision_count from projects.phase_four where id = '${phaseFourId}';`,
      ),
    );
    assert.equal(workspace[0]!, 'revision_limit_escalation');
    assert.ok(workspace[1]! && workspace[1]!.length > 0, 'expected a non-empty blocked_reason');
    assert.equal(Number(workspace[2]!), configuredLimit, 'ui_revision_count must not have incremented past the limit');

    // The count that matters most: no additional ui_versions row was written
    // by the refused 4th attempt.
    const countAfterRefusal = Number(
      scalar(db.admin(`select count(*) from projects.ui_versions where phase_four_id = '${phaseFourId}';`)),
    );
    assert.equal(
      countAfterRefusal,
      configuredLimit + 1,
      'a refused revision past the limit must not write a new ui_versions row',
    );
  });
});
