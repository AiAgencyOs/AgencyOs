import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * A bill with nothing to collect — Finance §9.
 *
 * Eight checkboxes, and AgencyOS could not answer the first: *"check whether
 * free maintenance/support was included for the client."* `maintenance_plans`
 * carried versions, coverage, a period, a state machine and an accepted
 * proposal, and **nothing on it could say the maintenance was free.**
 *
 * The assertion this file exists for is the sentence that looks like a licence
 * to skip the Admin: *"No Admin payment verification is required because
 * payable amount is ₹0."* It is **not** an exemption from ADM-04, and the test
 * proves that by the rule rather than by the outcome.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260918120000_a_bill_with_nothing_to_collect.sql');
const SQL = MIGRATION.replace(/^\s*--.*$/gm, '');
const PROSE = MIGRATION.replace(/\n\s*--\s?/g, ' ');
const VERIFIED = read('supabase/migrations/20260813120015_payment_verified.sql');
const SERVICE = read('src/modules/finance/service.ts');
const FREE = SERVICE.slice(SERVICE.indexOf('Finance §9 — the ₹0 invoice'));
const QUERIES = read('src/modules/finance/queries.ts');
const PANEL = read('app/(internal)/projects/[projectId]/billing-panel.tsx');
const PAGE = read('app/(internal)/projects/[projectId]/page.tsx');

const door = (() => {
  const start = SQL.indexOf('create or replace function finance.issue_free_maintenance_invoice');
  assert.ok(start > 0);
  return SQL.slice(start, SQL.indexOf('$$;', start));
})();

describe('A. ADM-04 is not bypassed — it is satisfied at zero', () => {
  test('the paid rule this leans on is the one G-007 wrote, unchanged', () => {
    // `status = paid` follows net VERIFIED money covering the total. At a total
    // of zero that condition is true of nothing. This test asserts the RULE,
    // because asserting only that the door may write `paid` would pass just as
    // well if somebody later let it write `paid` on a real bill.
    assert.match(VERIFIED, /when v_after >= v_total then 'paid'/);
    assert.match(VERIFIED, /net_verified_minor/);
    assert.match(PROSE, /it is \*\*evaluated at zero\*\*/);
    assert.match(PROSE, /There is no\s+verification to skip, because there is no claim/);
  });

  test('THE DOOR TAKES NO AMOUNT — the safety property is the signature', () => {
    // Not a check that could be relaxed: there is no parameter, anywhere, that
    // could make this invoice non-zero.
    assert.match(SQL, /create or replace function finance\.issue_free_maintenance_invoice\(\s*p_plan_id uuid,\s*p_number\s+text\s*\)/);
    assert.doesNotMatch(SQL, /p_total_minor|p_amount|p_subtotal|p_minor/);
    assert.match(PROSE, /A `p_total_minor`\s+defaulted to 0 would have been the same function with a hole in it/);
  });

  test('and every money column is a literal zero in the body', () => {
    assert.match(door, /subtotal_minor, tax_minor, total_minor, paid_minor, verified_minor,/);
    assert.match(door, /\n\s*0, 0, 0, 0, 0,\n/);
  });

  test('the service says the same thing where its reader is', () => {
    assert.match(FREE.replace(/\n\s*\*\s?/g, ' '), /That sentence reads like an exemption from ADM-04, and it is not one/);
    assert.match(FREE.replace(/\n\s*\*\s?/g, ' '), /nobody claimed any money arrived/);
  });
});

describe('B. checkbox 1 — something to check', () => {
  test('`entitlement` is nullable with NO default', () => {
    // A default of 'paid' would answer for every maintenance plan recorded
    // before this column existed, and nobody was asked.
    assert.match(SQL, /add column if not exists entitlement text\s*\n\s*check \(entitlement in \('free_included', 'paid'\)\)/);
    assert.doesNotMatch(SQL, /entitlement text[\s\S]{0,80}default/);
    assert.match(PROSE, /Null\s+means \*nobody has said\*/);
  });

  test('an unclassified plan is NOT free', () => {
    // `is distinct from` rather than `<>`: a null entitlement compared with
    // `<>` is null, which is not true — and the branch would fall through to
    // raising a zero-rupee invoice for a plan somebody sold.
    assert.match(door, /if v_plan\.entitlement is distinct from 'free_included' then/);
    assert.match(door, /'not_free'::text/);
  });

  test('a free entitlement must carry an end date, at the row', () => {
    // Checkbox 8: "record the free-maintenance entitlement/period so later
    // renewal logic knows when it ends." Without an end, no renewal can fire.
    assert.match(SQL, /check \(entitlement is distinct from 'free_included' or ends_on is not null\)/);
    assert.match(SQL, /not valid;/);
    assert.match(PROSE, /no existing row can carry entitlement at all because the column did not exist/);
  });

  test('and there is deliberately no `no_period` branch to go with it', () => {
    // The lesson from G-268, applied the other way round: a branch the
    // constraint makes unreachable is a control no test can bite.
    assert.doesNotMatch(door, /no_period/);
    assert.match(PROSE, /a control no test can bite is a\s+comment with a semicolon/);
  });
});

describe('C. it refuses what it cannot prove', () => {
  test('100% NET verified, not 100% recorded', () => {
    // §8: Phase 7 starts only at 100% verified, so Phase 7 cannot have
    // completed below it. Through `project_payment_progress`, so a refund puts
    // a project back below the line (G-264).
    assert.match(door, /from finance\.project_payment_progress\(v_plan\.project_id\)/);
    assert.match(door, /v_progress\.measurable is not true or coalesce\(v_progress\.verified_percent, 0\) < 100/);
    assert.match(door, /'payment_incomplete'::text/);
  });

  test('an unmeasurable plan is shut, not treated as 100%', () => {
    assert.match(door, /measurable is not true/);
    assert.match(PROSE, /a project with\s+no payment plan has not been proven paid, it has been proven unmeasured/);
  });

  test('Phase 7 COMPLETION is admitted to be unrecorded, not faked', () => {
    assert.match(PROSE, /\*\*Phase 7 completion is recorded nowhere\.\*\*/);
    assert.match(PROSE, /a door a person\s+calls, not a trigger that fires/);
    // No invented flag anywhere.
    assert.doesNotMatch(MIGRATION, /phase_7_complete|phase7_completed|phase_seven/i);
  });

  test('clicking twice raises no second document', () => {
    assert.match(SQL, /create unique index if not exists invoices_maintenance_plan_live_key/);
    assert.match(SQL, /where maintenance_plan_id is not null and status <> 'void'/);
    assert.match(door, /'already_issued'::text, v_existing, v_existing_n/);
    assert.match(door, /and i\.status <> 'void'/);
  });

  test('the plan is locked before any of it is decided', () => {
    assert.match(door, /from projects\.maintenance_plans\s*\n\s*where id = p_plan_id\s*\n\s*for update/);
  });
});

describe('D. what it will not pretend', () => {
  test('it sends nothing, and says which blockers stop it', () => {
    assert.doesNotMatch(door, /send_outbound_message|conversation_messages|whatsapp_templates|email/i);
    assert.match(PROSE, /BLK-007/);
    assert.match(PROSE, /BLK-003/);
    assert.match(PANEL.replace(/\n\s*\*\s?/g, ' '), /\*\*AgencyOS does not send it\*\*/);
  });

  test('Phase 8 is announced into a registry that has no subscriber', () => {
    assert.match(SQL, /'maintenance\.free_invoice_issued'/);
    assert.match(SQL, /insert into core\.event_types/);
    assert.match(SQL, /NOTHING SUBSCRIBES/);
    // And no handler was quietly added for it.
    assert.doesNotMatch(read('src/lib/events/dispatch.ts'), /free_invoice_issued/);
  });

  test('Phase 8 is not smuggled into the plan phase vocabulary', () => {
    // It appears in the Finance specification and in none of the other three.
    // A plan schedules delivery work; Phase 8 is the life of a delivered
    // project.
    assert.doesNotMatch(SQL, /phase_8/);
    assert.match(PROSE, /Phase 8 appears in the Finance specification\s+and in none of the other three/);
  });

  test('the invoice still carries a line saying what was free', () => {
    // §9 asks for an invoice "for the applicable free-maintenance
    // period/service". A document with no lines names the service nowhere.
    assert.match(door, /insert into finance\.invoice_items/);
    assert.match(door, /free maintenance included, %s to %s/);
  });
});

describe('E. the boundaries it had to respect', () => {
  test('SECURITY INVOKER, because an invoice writer must be', () => {
    // 20260815290000 rejected DEFINER for every finance function that writes
    // an invoice: they lean on RLS for tenancy, and running as the owner
    // would open a cross-tenant hole unless org checks were bolted on.
    assert.match(SQL, /language plpgsql\s*\n\s*volatile\s*\n\s*security invoker/);
    assert.match(PROSE, /rejected SECURITY DEFINER for every finance function that\s+writes an invoice/);
  });

  test('and it carries the sanctioned-write marker the guard demands', () => {
    assert.match(door, /perform set_config\('finance\.sanctioned_write', 'on', true\)/);
    // Exactly one invoice row is written under it: the flag is single-use.
    assert.equal((door.match(/insert into finance\.invoices/g) ?? []).length, 1);
  });

  test('the new org-scoped FK is tenancy-guarded, like every other one', () => {
    assert.match(SQL, /core\.enforce_parent_org\('maintenance_plan_id', 'projects\.maintenance_plans'\)/);
  });

  test('not callable by the world', () => {
    assert.match(SQL, /revoke all on function finance\.issue_free_maintenance_invoice\(uuid, text\) from public, anon/);
    assert.match(SQL, /grant execute on function finance\.issue_free_maintenance_invoice\(uuid, text\) to authenticated, service_role/);
  });
});

describe('F. the surface, and the reads behind it', () => {
  test('only free_included plans are offered the button', () => {
    // A paid plan billed at ₹0 is a bill written off, and a plan nobody has
    // classified is one somebody still has to look at.
    assert.match(QUERIES, /\.eq\('entitlement', 'free_included'\)/);
  });

  test('an unreadable invoice list is not "no invoice yet"', () => {
    // It would offer to raise a second zero-rupee document for a plan that
    // already has one.
    assert.match(QUERIES, /if \(planError\) unreadable\('listFreeMaintenance\.plans', planError\)/);
    assert.match(QUERIES, /if \(invoiceError\) unreadable\('listFreeMaintenance\.invoices', invoiceError\)/);
    assert.match(
      QUERIES.replace(/\n\s*\/\/ ?/g, ' '),
      /A plan whose invoice could not be read is NOT a plan with no invoice/,
    );
  });

  test('a voided invoice does not occupy the plan, on both sides', () => {
    assert.match(QUERIES, /invoice\.status !== 'void'/);
    assert.match(SQL, /status <> 'void'/);
  });

  test('the action treats a second click as success, not failure', () => {
    const actions = read('src/modules/finance/actions.ts');
    const block = actions.slice(actions.indexOf('Finance §9 — the ₹0 invoice'));
    assert.match(block, /result\.data\.issued\s*\n?\s*\?/);
    assert.match(block, /was already raised for this plan/);
  });

  test('the page renders it behind invoice.read', () => {
    assert.match(PAGE, /can\(context\.role, 'invoice\.read'\)\s*\n\s*\? await listFreeMaintenance\(projectId\)\s*\n\s*: \[\]/);
    assert.match(PAGE, /<FreeMaintenanceInvoiceButton/);
  });

  test('the refusal is shown, not hidden by removing the button', () => {
    // A control that vanishes for a reason nobody is told is a control that
    // looks like a bug.
    assert.match(
      PAGE.replace(/\n\s*/g, ' '),
      /a project that is not fully verified gets the button and a refusal naming why/i,
    );
  });
});
