import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

/**
 * Gap G-079 — the audit row was written in its own transaction.
 *
 * `recordAudit` opened its own client and inserted into `audit.audit_log`
 * after the state change had already committed. Its doc comment defended that
 * honestly — an audit write that fails should not roll back the business
 * change it describes — and the trade it named is real. What it did not say is
 * the cost: `audit.audit_log` is append-only by trigger (`reject_mutation`
 * raises on UPDATE and DELETE), so a row that was never written cannot be
 * written later. A payment could commit with no history, permanently, with
 * nothing anywhere to notice or reconcile from.
 *
 * Four of the sixteen call sites sit beside a Postgres function that already
 * holds a transaction, so for those the trade was never necessary. This file
 * pins what moving them made true, and is deliberate about what it does not
 * claim:
 *
 *   A. `core.record_audit` inserts under the caller's own policy, and does not
 *      assert an actor it does not have
 *   B. each audit row is written inside its function, after the write
 *   C. no refusal audits anything
 *   D. the `before` values come from the locked read — the property the
 *      service-level tests used to hold, moved rather than dropped
 *   E. the services no longer write these four rows a second time
 *   F. the remaining call sites are untouched, counted by scanning
 *
 * Structural rather than executed, because these are properties of a Postgres
 * function that a node:test run has no database to call. The end-to-end proof
 * — an audit row actually present, in the same commit as the money, with the
 * status the lock saw — is verify-milestone-invoicing.mjs §7g, against real
 * Postgres.
 */

const MIGRATION = '../supabase/migrations/20260812120010_audit_in_the_transaction.sql';

/** Scanned, not listed — see §F on why. */
const MODULES_DIR = fileURLToPath(new URL('../src/modules', import.meta.url));

const migration = readFileSync(fileURLToPath(new URL(MIGRATION, import.meta.url)), 'utf8');

function read(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
}

const financeService = read('../src/modules/finance/service.ts');
const projectsService = read('../src/modules/projects/service.ts');

/** The SQL with comment lines removed, so a comment cannot satisfy an assertion. */
const executable = migration
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

/**
 * One function's body, from its `create or replace` to the `$$;` that closes
 * it. Every positional assertion below is made inside one of these rather than
 * across the file, so a match in a neighbouring function cannot stand in.
 */
function body(signature: string): string {
  const start = executable.indexOf(signature);
  assert.ok(start >= 0, `${signature} is not in the migration`);
  const end = executable.indexOf('$$;', start);
  assert.ok(end > start, `${signature} has no closing $$;`);
  return executable.slice(start, end);
}

/** An index that is a real position, or the assertion fails saying which. */
function at(haystack: string, needle: string, label: string): number {
  const index = haystack.indexOf(needle);
  assert.ok(index >= 0, `${label}: "${needle}" is missing`);
  return index;
}

const recordPayment = body('create or replace function finance.record_manual_payment');
const issue = body('create or replace function finance.issue_invoice');
const voidInvoice = body('create or replace function finance.void_invoice');
const replacePlan = body('create or replace function projects.replace_payment_plan');

// ═══════════════════════════════════════════════════════════════════════════
// A. The append itself
// ═══════════════════════════════════════════════════════════════════════════

describe('A. core.record_audit', () => {
  const fn = body('create or replace function core.record_audit');

  test('is SECURITY INVOKER, so the append-only policy still decides', () => {
    // The whole reason this is safe to expose. `audit_log_insert` admits a row
    // only when `actor_id = auth.uid()`, which is precisely what stops one
    // caller attributing an action to somebody else. A definer function would
    // run as the owner and bypass that — turning a helper into a way to forge
    // history.
    assert.match(fn, /security invoker/);
    assert.doesNotMatch(fn, /security definer/);
  });

  test('pins its search path, like every other function in this schema', () => {
    assert.match(fn, /set search_path = ''/);
  });

  test('is not reachable by anon or the public role', () => {
    assert.match(
      migration,
      /revoke all on function core\.record_audit\(uuid, text, text, uuid, jsonb, jsonb, uuid\)\s*\n\s*from public, anon;/,
    );
    assert.match(
      migration,
      /grant execute on function core\.record_audit\(uuid, text, text, uuid, jsonb, jsonb, uuid\)\s*\n\s*to authenticated, service_role;/,
    );
  });

  test('calls the actor what it is, rather than asserting a user with no id', () => {
    // `auth.uid()` is null under the service role. Writing 'user' with a null
    // actor_id would be a small lie told in the one table that exists to be
    // believed, and audit.audit_log's own check constraint already has the
    // word for it.
    assert.match(fn, /case when \(select auth\.uid\(\)\) is null then 'system' else 'user' end/);
  });

  test('takes the organization rather than deriving one', () => {
    // Every caller is inside a function that has already read the row under a
    // lock, so it has the tenancy. Re-deriving it here would mean a second
    // read that could disagree with the one the write was decided on.
    assert.match(fn, /p_organization_id uuid,/);
    assert.match(fn, /insert into audit\.audit_log \(\s*\n\s*organization_id,/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. Written inside the function, after the write
// ═══════════════════════════════════════════════════════════════════════════

describe('B. each audit row is written where the state changes', () => {
  test('the payment is audited after the invoice total it changes', () => {
    const update = at(recordPayment, 'update finance.invoices', 'record_manual_payment');
    const audit = at(recordPayment, "core.record_audit(\n    v_org, 'payment.recorded'", 'audit');
    assert.ok(
      audit > update,
      'the payment audit is written before the update it describes',
    );
  });

  test('the issue is audited after the status it reports', () => {
    const update = at(issue, "set status    = 'issued'", 'issue_invoice');
    const audit = at(issue, "core.record_audit(\n    v_org, 'invoice.issued'", 'audit');
    assert.ok(audit > update, 'the issue audit is written before the update it describes');
  });

  test('the void is audited after the status and the note', () => {
    const update = at(voidInvoice, "set status = 'void'", 'void_invoice');
    const audit = at(voidInvoice, "core.record_audit(\n    v_org, 'invoice.voided'", 'audit');
    assert.ok(audit > update, 'the void audit is written before the update it describes');
  });

  test('the plan is audited after the milestones are inserted', () => {
    const insert = at(replacePlan, 'insert into projects.milestones', 'replace_payment_plan');
    const audit = at(
      replacePlan,
      "core.record_audit(\n    v_org, 'project.payment_plan_configured'",
      'audit',
    );
    assert.ok(audit > insert, 'the plan audit is written before the rows it describes');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. A refusal audits nothing
// ═══════════════════════════════════════════════════════════════════════════

describe('C. refusals write no history', () => {
  // Every refusal is a `return query select '<outcome>'` before the write. If
  // an audit call ever appeared above the first one, a rejected overpayment
  // would leave a row claiming money was recorded.
  const refusals: [string, string, string[]][] = [
    [
      'record_manual_payment',
      recordPayment,
      ["'not_payable'", "'non_positive'", "'overpayment'", "'duplicate'"],
    ],
    ['issue_invoice', issue, ["'already_issued'", "'not_issuable'", "'no_amount'", "'no_items'"]],
    ['void_invoice', voidInvoice, ["'already_void'", "'not_voidable'", "'has_payments'"]],
    ['replace_payment_plan', replacePlan, ["'not_found'", "'met'", "'billed'"]],
  ];

  for (const [name, fn, outcomes] of refusals) {
    test(`${name} audits nothing on any refusal`, () => {
      const audit = at(fn, 'core.record_audit(', name);
      for (const outcome of outcomes) {
        const refusal = at(fn, `return query select ${outcome}`, `${name} ${outcome}`);
        assert.ok(
          refusal < audit,
          `${name}: the ${outcome} refusal is below the audit call, so it would audit and then refuse`,
        );
      }
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// D. The property the service tests used to hold
// ═══════════════════════════════════════════════════════════════════════════

describe('D. before comes from the locked read', () => {
  test('the payment records the captured sum read under the lock', () => {
    // This is what tests/payment-ledger.test.ts used to assert against
    // `settled.captured_before_minor`. `v_captured` is read inside the lock,
    // after the SELECT … FOR UPDATE — so under a concurrent receipt it is the
    // total this payment was actually applied to, not one a caller read
    // earlier and would now be reporting wrongly.
    assert.match(
      recordPayment,
      /core\.record_audit\(\s*\n\s*v_org, 'payment\.recorded', 'invoice', p_invoice_id,\s*\n\s*jsonb_build_object\('paidMinor', v_captured, 'status', v_status\),/,
    );
    const lock = at(recordPayment, 'for update', 'record_manual_payment');
    const captured = at(recordPayment, 'into v_captured', 'record_manual_payment');
    assert.ok(captured > lock, 'the ledger sum is read before the lock is taken');
  });

  test('the payment records what changed, including the method the caller gave', () => {
    for (const field of [
      "'paidMinor',   v_after",
      "'status',      v_new",
      "'amountMinor', p_amount_minor",
      "'method',      p_method",
      "'reference',   p_provider_payment_id",
      "'provider',    'manual'",
    ]) {
      assert.ok(recordPayment.includes(field), `the payment audit lost ${field}`);
    }
  });

  test('the issue and the void record the status the lock saw', () => {
    // tests/invoice-issue.test.ts and tests/invoice-void.test.ts each used to
    // hold this against `settled.invoice_status`. `v_status` is that same
    // value: read through the FOR UPDATE, so a status that moved between the
    // caller's read and the lock is recorded as it actually was.
    assert.match(
      issue,
      /jsonb_build_object\('status', v_status\),\s*\n\s*jsonb_build_object\('status', 'issued'\)/,
    );
    assert.match(
      voidInvoice,
      /jsonb_build_object\('status', v_status\),\s*\n\s*jsonb_build_object\('status', 'void', 'reason', p_note\)/,
    );
    for (const [name, fn] of [
      ['issue_invoice', issue],
      ['void_invoice', voidInvoice],
    ] as const) {
      const lock = at(fn, 'for update', name);
      const status = at(fn, 'into v_status', name);
      assert.ok(status < lock, `${name}: v_status is not part of the locked read`);
    }
  });

  test('the void records the caller reason as the note it stored', () => {
    // The row and the invoice note come from the same argument, so they cannot
    // disagree about why an invoice was cancelled.
    assert.match(voidInvoice, /notes\s*= concat_ws\(chr\(10\), nullif\(v_notes, ''\), p_note\)/);
    assert.ok(voidInvoice.includes("'reason', p_note"), 'the void audit lost the reason');
  });

  test('the plan records the budget read under the lock, and no before at all', () => {
    // Null rather than `{}`: the previous plan was deleted above and never
    // read, so there is nothing to report. An empty object would assert there
    // was nothing there, which is a different claim from not knowing.
    assert.match(
      replacePlan,
      /core\.record_audit\(\s*\n\s*v_org, 'project\.payment_plan_configured', 'project', p_project_id,\s*\n\s*null::jsonb,\s*\n\s*jsonb_build_object\('items', p_milestones, 'budgetMinor', v_budget\)/,
    );
    assert.match(
      replacePlan,
      /select p\.organization_id, p\.currency, p\.budget_minor\s*\n\s*into v_org, v_currency, v_budget/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E. And not a second time from the application
// ═══════════════════════════════════════════════════════════════════════════

describe('E. the services do not write these four rows again', () => {
  // A surviving call would be a duplicate history entry — and because the
  // table is append-only, a duplicate nobody can remove.
  const moved = [
    ['invoice.issued', financeService],
    ['payment.recorded', financeService],
    ['invoice.voided', financeService],
    ['project.payment_plan_configured', projectsService],
  ] as const;

  for (const [action, source] of moved) {
    test(`${action} is not audited from TypeScript`, () => {
      assert.ok(
        !source.includes(`action: '${action}'`),
        `${action} is still audited from the service as well as the function`,
      );
    });
  }

  test('the method is passed to the function, since the row it writes carries it', () => {
    assert.match(
      financeService,
      /\.rpc\('record_manual_payment', \{[\s\S]*?p_method: parsed\.data\.method,/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F. What this deliberately does not do
// ═══════════════════════════════════════════════════════════════════════════

describe('F. no service writes an audit row any more', () => {
  test('there are zero recordAudit calls left in src/modules', () => {
    // This counter went 12 → 14 → 13 → 0. It counted the audit rows written in
    // a request of their own, after the change they described had committed —
    // recoverable by nothing, because audit.audit_log is append-only.
    //
    // G-093 closed it under ADM-51 by moving them into a trigger. Zero is now
    // the invariant: a call reappearing here means two mechanisms write the
    // history, which is the failure option D was rejected for.
    //
    // Still scanned rather than listed. The first version named five service
    // files, and the qa module — written days later — added two sites it never
    // saw: exactly the slip it exists to prevent, evaded by a file it had
    // never heard of.
    const services = readdirSync(MODULES_DIR)
      .map((name) => `${MODULES_DIR}/${name}/service.ts`)
      .filter((path) => existsSync(path));

    const remaining = services
      .map((path) => readFileSync(path, 'utf8').split('await recordAudit({').length - 1)
      .reduce((a, b) => a + b, 0);

    assert.ok(services.length >= 5, `expected several services, scanned ${services.length}`);

    assert.equal(remaining, 0, 'a service is writing its own audit row again — G-093 chose one mechanism');
  });

  test('nothing an earlier migration fixed was lost in the rewrite', () => {
    // These four functions are restated whole here, which means every earlier
    // fix to them has to survive being carried forward. One did not on the
    // first attempt: `replace_payment_plan` was regenerated from the migration
    // that introduced it rather than the one that last changed it, which
    // silently reverted D16 — the blocking-invoice lookup went back to reading
    // finance.invoices directly, so a delivery_lead, who may not read the
    // invoice book, got null and was allowed to rewrite a plan carrying a live
    // bill. verify-milestone-invoicing §7e caught it.
    //
    // Each assertion below is one earlier fix, named, so the next rewrite of
    // any of these functions fails here instead of in production.
    assert.ok(
      replacePlan.includes('finance.blocking_invoice_number(p_project_id, v_org)'),
      'D16: the blocking invoice must come from the definer helper, not a direct read',
    );
    assert.ok(
      recordPayment.includes("core.emit_event(\n    v_org, 'payment.recorded'") &&
        recordPayment.includes("core.emit_event(\n      v_org, 'invoice.paid'"),
      'D17: record_manual_payment must still publish both events itself',
    );
    assert.ok(
      issue.includes("core.emit_event(\n    v_org, 'invoice.issued'"),
      'D17: issue_invoice must still publish its own event',
    );
    assert.ok(
      voidInvoice.includes("core.emit_event(\n    v_org, 'invoice.voided'"),
      'D17: void_invoice must still publish its own event',
    );
    assert.ok(
      recordPayment.includes('for update') && issue.includes('for update'),
      'D1/D4: the money functions must still decide through a row lock',
    );
    assert.ok(
      recordPayment.includes("return query select 'overpayment'::text"),
      'the overpayment refusal must still refuse rather than clamp',
    );
  });

  test('invoice.created is no longer one of them — G-078 gave it a transaction to join', () => {
    // This test used to assert the opposite, and failing was how it announced
    // that G-078 had landed. generateInvoiceFromMilestone had no function
    // behind it, so there was no transaction for its audit row to join; now
    // finance.create_milestone_invoice writes the invoice, its lines, its
    // audit row and its event in one statement.
    //
    // The count above dropped 14 → 13 with it, which is the only way that
    // number is allowed to move: a call site gained a function, not a pin
    // loosened.
    assert.ok(
      !financeService.includes("action: 'invoice.created'"),
      'the audit row moved into the function; the application must not write it again',
    );

    const created = read('../supabase/migrations/20260813120011_invoice_created_in_its_transaction.sql');
    assert.match(created, /perform core\.record_audit\(/);
    assert.match(created, /'invoice\.created'/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// G. The trigger that replaced them — G-093, ADM-51
// ═══════════════════════════════════════════════════════════════════════════

describe('G. audit.record_row_change', () => {
  const trigger = read('../supabase/migrations/20260813120013_audit_by_trigger.sql');

  const executableTrigger = trigger
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

  test('is attached to every table whose audit calls were removed, and no others', () => {
    // Narrow on purpose, as the decision asked. Adding core.jobs or
    // outbox_events here would bury the log in machinery nobody reads.
    // Scoped to the array literal. Matching `'word.word'` across the whole
    // file also caught every action name, which read as a passing test with a
    // nonsense expectation — the shape this file exists to refuse.
    const block = executableTrigger.slice(
      at(executableTrigger, 'array[', 'the table list'),
      at(executableTrigger, ']\n  loop', 'the end of the table list'),
    );

    const listed = [...block.matchAll(/'([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1]);

    assert.deepEqual(listed, [
      'crm.leads',
      'crm.lead_activities',
      'crm.requirement_versions',
      'core.client_accounts',
      'sales.opportunities',
      'projects.projects',
      'qa.defects',
    ]);
  });

  test('fires after the write, for each row, on insert and update', () => {
    assert.match(executableTrigger, /after insert or update on %s\s*\n\s*for each row/);
  });

  test('keeps the vocabulary the services used to supply', () => {
    // The decision document argued a trigger would cost these names, because
    // it sees rows rather than intent, and recommended accepting the loss.
    // Every one of them is derivable from the diff — which is how the service
    // derived it a moment before writing the row — so none was lost.
    for (const action of [
      'lead.created',
      'lead.converted',
      'lead.status_changed',
      'lead.qualification_updated',
      'lead.follow_up_scheduled',
      'lead.note_added',
      'client_account.created',
      'opportunity.created',
      'opportunity.won',
      'opportunity.stage_changed',
      'project.created',
      'project.status_changed',
      'defect.raised',
    ]) {
      assert.match(executableTrigger, new RegExp(`'${action.replace('.', '\\.')}'`), `${action} is gone`);
    }

    // The two derived families keep their shape rather than being enumerated.
    assert.match(executableTrigger, /'requirement\.' \|\| new\.status/);
    assert.match(executableTrigger, /'defect\.' \|\| new\.status/);
  });

  test('converted beats status_changed, so the specific name wins', () => {
    // Order matters in a CASE. If the generic arm came first, `lead.converted`
    // would be unreachable and the most important event in the CRM would be
    // recorded as an ordinary status change.
    const converted = at(executableTrigger, "'lead.converted'", 'lead.converted');
    const changed = at(executableTrigger, "'lead.status_changed'", 'lead.status_changed');
    assert.ok(converted < changed, 'lead.status_changed shadows lead.converted');

    const won = at(executableTrigger, "'opportunity.won'", 'opportunity.won');
    const staged = at(executableTrigger, "'opportunity.stage_changed'", 'opportunity.stage_changed');
    assert.ok(won < staged, 'opportunity.stage_changed shadows opportunity.won');
  });

  test('records the real prior row, which the application could not', () => {
    // The service audited a `before` it had read earlier, or omitted it — see
    // the deleted test in lead-conversion.test.ts. The trigger has OLD.
    assert.match(executableTrigger, /v_before := case when tg_op = 'UPDATE' then to_jsonb\(old\) else null end/);
  });

  test('is SECURITY INVOKER, so audit_log_insert still decides', () => {
    // A definer function would run as the owner and bypass the policy that
    // stops one caller attributing an action to somebody else.
    assert.match(executableTrigger, /security invoker/);
    assert.doesNotMatch(executableTrigger, /security definer/);
  });

  test('calls the actor what it is rather than asserting a user with no id', () => {
    assert.match(
      executableTrigger,
      /case when \(select auth\.uid\(\)\) is null then 'system' else 'user' end/,
    );
  });

  test('refuses a row it cannot file, rather than dropping its history', () => {
    assert.match(executableTrigger, /raise exception 'audit\.record_row_change: % has no organization_id'/);
  });

  test('refuses a table it has no vocabulary for', () => {
    // Attaching the trigger to a new table without naming its actions would
    // otherwise fill the log with rows nobody can read.
    assert.match(executableTrigger, /raise exception 'audit\.record_row_change: no vocabulary for table %'/);
  });

  test('an update that changed nothing but updated_at writes no history', () => {
    assert.match(executableTrigger, /\(v_before - 'updated_at'\) = \(v_after - 'updated_at'\)/);
  });

  test('returns null, so it cannot alter the row it is recording', () => {
    assert.match(executableTrigger, /return null;\s*\nend;/);
  });
});
