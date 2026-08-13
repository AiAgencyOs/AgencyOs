#!/usr/bin/env node
/**
 * Milestone → invoice verification, against the real database.
 *
 * The unit suite (`npm test`) covers the arithmetic and the decisions. This
 * covers the half that only Postgres can answer:
 *
 *   • the payment-plan trigger really refuses a plan that is not 100%
 *   • `invoices_milestone_live_key` really refuses a second live invoice for a
 *     milestone — the guarantee application-level idempotency rests on
 *   • voiding really frees the milestone again
 *   • the money CHECKs really refuse an overpayment
 *   • RLS really returns nothing to a caller with no organization claim
 *
 * Scope, stated honestly: this drives the schema, not the TypeScript service.
 * The service layer needs a signed-in session and Next's request context, and
 * this repository has no harness for that yet — so what runs here is the same
 * sequence of writes the service performs, and the invariants it depends on.
 * A failure here means the service's guarantees are not actually backed.
 *
 * Writes are made under a marker name and removed again at the end, including
 * after a failure. No payment provider is contacted; the only payments written
 * are provider = 'manual', exactly as the application writes them.
 *
 *   node scripts/verify-milestone-invoicing.mjs
 */

import { Buffer } from 'node:buffer';
import { createHmac, randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

/** Everything this run creates carries this, so cleanup can find it. */
const MARKER = 'ZZTEST milestone-invoicing';

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

const target = resolveTarget(fail, { cron: false, anon: true, jwt: true });
const URL_BASE = target.url;
const PUBLISHABLE = target.anonKey;
const SECRET = target.serviceKey;

// ── REST helpers ───────────────────────────────────────────────────────────

async function request(method, schema, path, { key = SECRET, body, prefer } = {}) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(schema && schema !== 'public'
        ? method === 'GET'
          ? { 'Accept-Profile': schema }
          : { 'Content-Profile': schema }
        : {}),
      ...(prefer ? { Prefer: prefer } : {}),
    },
    cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON bodies are reported through `text` */
  }
  return { status: res.status, ok: res.ok, json, text };
}

const select = (schema, path, key = SECRET) => request('GET', schema, path, { key });
const insert = (schema, table, body, key = SECRET) =>
  request('POST', schema, table, { key, body, prefer: 'return=representation' });
const patch = (schema, path, body) =>
  request('PATCH', schema, path, { body, prefer: 'return=representation' });
const remove = (schema, path) => request('DELETE', schema, path);

// ── Reporting ──────────────────────────────────────────────────────────────

let failures = 0;
const pass = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => {
  console.log(`  \x1b[31m✗\x1b[0m ${m}`);
  failures++;
};
const check = (condition, message, detail) =>
  condition ? pass(message) : bad(`${message}${detail ? ` — ${detail}` : ''}`);

// ── The same arithmetic the application uses ───────────────────────────────

/** Mirrors src/modules/projects/schema.ts splitBudget. */
function splitBudget(budgetMinor, percents) {
  const amounts = percents.map((p) => Math.floor((budgetMinor * p) / 100));
  const last = amounts.length - 1;
  if (last >= 0) {
    const assigned = amounts.reduce((sum, a) => sum + a, 0);
    amounts[last] += budgetMinor - assigned;
  }
  return amounts;
}

const BUDGET_MINOR = 999_999;

/** No plan is privileged — the same code path must serve all of these. */
const PLANS = {
  '30/20/30/20': [30, 20, 30, 20],
  '5/10/30/20/35': [5, 10, 30, 20, 35],
  '50/50': [50, 50],
  '33.33/33.33/33.34': [33.33, 33.33, 33.34],
};

// ── Fixture lifecycle ──────────────────────────────────────────────────────

const created = {
  projectId: null,
  organizationId: null,
  clientAccountId: null,
  // §7g needs a project with no billing history of its own, because the thing
  // it asserts is what a *successful* plan replacement records — and the main
  // fixture carries live invoices by the time it runs, so the guard would
  // refuse and there would be nothing to audit.
  planProjectId: null,
};
let invoiceSequence = 0;
const invoiceNumber = () => `${MARKER}-${Date.now()}-${(invoiceSequence += 1)}`;

async function cleanup() {
  if (!created.projectId) return;

  const invoices = await select('finance', `invoices?project_id=eq.${created.projectId}&select=id`);
  const invoiceIds = (invoices.json ?? []).map((i) => i.id);
  for (const invoiceId of invoiceIds) {
    // payments → invoices is ON DELETE RESTRICT, so receipts go first.
    await remove('finance', `payments?invoice_id=eq.${invoiceId}`);
  }

  // Every invoice event in the fixture organization, not a marker match.
  //
  // The payloads are written by finance's own functions now (D17), so nothing
  // this script chooses appears in them — the old `payload->>marker` filter
  // matched nothing and left every row behind. Nor is filtering by the
  // surviving invoice ids enough: §7b, §7c and §7d delete their invoices
  // inline between resets, so by the time this runs those rows are gone and
  // their events would have no subject left to find them by.
  //
  // Scoped to the fixture organization and to invoice subjects, which is
  // exactly the class this script creates. Every verification script ends with
  // an empty outbox — verify-milestone-unlock asserts it globally — so leaving
  // rows here fails a later script rather than this one, which is how this was
  // found.
  await remove(
    'core',
    `outbox_events?subject_type=eq.invoice&organization_id=eq.${created.organizationId}`,
  );

  await remove('finance', `invoices?project_id=eq.${created.projectId}`);
  await remove('projects', `milestones?project_id=eq.${created.projectId}`);
  await remove('projects', `projects?id=eq.${created.projectId}`);

  if (created.planProjectId) {
    await remove('projects', `milestones?project_id=eq.${created.planProjectId}`);
    await remove('projects', `projects?id=eq.${created.planProjectId}`);
  }

  // The audit rows these sections wrote are deliberately left behind.
  // audit.reject_mutation raises on DELETE, so they cannot be removed — which
  // is the property §7g exists to protect, and the reason a row that is never
  // written can never be repaired. Every assertion there is scoped by
  // subject_id, and subjects are fresh uuids each run, so the rows accumulate
  // without any of them being able to satisfy a later run's check.
}

async function replacePlan(percents) {
  await remove('projects', `milestones?project_id=eq.${created.projectId}`);

  const amounts = splitBudget(BUDGET_MINOR, percents);
  return insert(
    'projects',
    'milestones',
    percents.map((percent, index) => ({
      organization_id: created.organizationId,
      project_id: created.projectId,
      name: `${MARKER} milestone ${index + 1}`,
      position: index,
      payment_percent: percent,
      amount_minor: amounts[index],
      currency: 'INR',
    })),
  );
}

/** The write generateInvoiceFromMilestone performs, minus the session. */
function draftInvoiceFor(milestone) {
  return {
    organization_id: created.organizationId,
    client_account_id: created.clientAccountId,
    project_id: created.projectId,
    milestone_id: milestone.id,
    number: invoiceNumber(),
    status: 'draft',
    currency: milestone.currency,
    subtotal_minor: milestone.amount_minor,
    tax_minor: 0,
    total_minor: milestone.amount_minor,
  };
}

// ── Run ────────────────────────────────────────────────────────────────────

console.log('\n\x1b[1mAgencyOS — milestone → invoice verification\x1b[0m');
announceTarget(target);

try {
  // ── 0. Fixture ───────────────────────────────────────────────────────────
  console.log('\n0. Fixture');
  {
    const orgs = await select('core', 'organizations?select=id&limit=1');
    const accounts = await select('core', 'client_accounts?select=id,organization_id&limit=1');

    created.organizationId = orgs.json?.[0]?.id ?? null;
    created.clientAccountId = accounts.json?.[0]?.id ?? null;

    if (!created.organizationId || !created.clientAccountId) {
      fail('No organization or client account found. Run the seed first.');
    }

    const project = await insert('projects', 'projects', {
      organization_id: created.organizationId,
      client_account_id: created.clientAccountId,
      name: `${MARKER} project`,
      status: 'planning',
      currency: 'INR',
      budget_minor: BUDGET_MINOR,
    });

    created.projectId = project.json?.[0]?.id ?? null;
    check(Boolean(created.projectId), 'A. project created with a budget', project.text);
    if (!created.projectId) throw new Error('cannot continue without a project');
  }

  // ── 1. Payment plans ─────────────────────────────────────────────────────
  console.log('\n1. Payment plans (H — custom percentages, I — invalid plans)');
  for (const [name, percents] of Object.entries(PLANS)) {
    const result = await replacePlan(percents);
    const amounts = (result.json ?? []).map((m) => m.amount_minor);
    const total = amounts.reduce((sum, a) => sum + a, 0);

    check(
      result.ok && amounts.length === percents.length && total === BUDGET_MINOR,
      `${name} accepted, ${percents.length} milestones summing to exactly the budget`,
      result.ok ? `sum ${total} ≠ ${BUDGET_MINOR}` : result.text,
    );
  }

  for (const [name, percents] of Object.entries({
    'under 100 (30/20/30)': [30, 20, 30],
    'over 100 (50/40/30)': [50, 40, 30],
    'a zero-percent milestone': [0, 100],
    'a negative milestone': [-10, 110],
    'a single milestone over 100': [110],
  })) {
    await remove('projects', `milestones?project_id=eq.${created.projectId}`);
    const amounts = splitBudget(BUDGET_MINOR, percents);
    const result = await insert(
      'projects',
      'milestones',
      percents.map((percent, index) => ({
        organization_id: created.organizationId,
        project_id: created.projectId,
        name: `${MARKER} bad ${index}`,
        position: index,
        payment_percent: percent,
        amount_minor: Math.max(0, amounts[index]),
        currency: 'INR',
      })),
    );
    check(!result.ok, `I. rejected: ${name}`, `the database accepted it (${result.status})`);
  }

  // ── 2. Milestone → draft invoice ─────────────────────────────────────────
  console.log('\n2. Invoice generation (B–E)');
  const plan = await replacePlan(PLANS['30/20/30/20']);
  const milestones = (plan.json ?? []).sort((a, b) => a.position - b.position);
  const first = milestones[0];

  let firstInvoiceId = null;
  {
    const result = await insert('finance', 'invoices', draftInvoiceFor(first));
    const invoice = result.json?.[0];
    firstInvoiceId = invoice?.id ?? null;

    check(Boolean(invoice), 'B. invoice generated from milestone 1', result.text);
    check(invoice?.status === 'draft', 'C. invoice is DRAFT', `status was ${invoice?.status}`);
    check(
      invoice?.milestone_id === first.id &&
        invoice?.project_id === created.projectId &&
        invoice?.client_account_id === created.clientAccountId,
      'D. invoice links milestone, project and client account',
    );
    check(
      invoice?.total_minor === first.amount_minor && invoice?.currency === first.currency,
      'D. amount and currency copied verbatim from the milestone',
      `${invoice?.total_minor} ${invoice?.currency} vs ${first.amount_minor} ${first.currency}`,
    );

    const item = await insert('finance', 'invoice_items', {
      organization_id: created.organizationId,
      invoice_id: firstInvoiceId,
      position: 0,
      description: `${MARKER} line`,
      quantity: 1,
      unit_price_minor: first.amount_minor,
      amount_minor: first.amount_minor,
      tax_rate_bp: 0,
    });

    const items = await select('finance', `invoice_items?invoice_id=eq.${firstInvoiceId}&select=*`);
    check(
      item.ok && (items.json ?? []).length === 1 && items.json[0].amount_minor === first.amount_minor,
      'E. exactly one invoice item, at the milestone amount',
      item.text,
    );
  }

  // ── 3. Duplicate prevention ──────────────────────────────────────────────
  console.log('\n3. Duplicate prevention and idempotency (F)');
  {
    const duplicate = await insert('finance', 'invoices', draftInvoiceFor(first));
    check(
      !duplicate.ok && duplicate.text.includes('invoices_milestone_live_key'),
      'F. a second live invoice for the same milestone is refused by the database',
      duplicate.ok ? 'a duplicate was created' : duplicate.text.slice(0, 120),
    );

    const all = await select(
      'finance',
      `invoices?milestone_id=eq.${first.id}&select=id&status=neq.void`,
    );
    check((all.json ?? []).length === 1, 'F. exactly one live invoice exists for milestone 1');

    // Voiding is the documented way back: it must free the milestone again.
    await patch('finance', `invoices?id=eq.${firstInvoiceId}`, { status: 'void' });
    const afterVoid = await insert('finance', 'invoices', draftInvoiceFor(first));
    check(afterVoid.ok, 'F. voiding frees the milestone to be invoiced again', afterVoid.text);

    // Restore a single live invoice for the payment checks below.
    await remove('finance', `invoices?id=eq.${afterVoid.json?.[0]?.id ?? 'none'}`);
    await patch('finance', `invoices?id=eq.${firstInvoiceId}`, { status: 'draft' });
  }

  // ── 3b. A plan cannot be rewritten out from under a bill ─────────────────
  //
  // configurePaymentPlan refused a rewrite only when a milestone was 'met',
  // and nothing in the repository ever writes 'met'. It never looked at
  // finance.invoices — and because invoices.milestone_id is `on delete set
  // null`, replacing the plan unhooked every invoice raised against it and
  // re-inserted the milestones as fresh pending rows, billable again.
  console.log('\n3b. A plan cannot be rewritten out from under a bill');
  {
    const planOf = async () =>
      (await select('projects', `milestones?project_id=eq.${created.projectId}&select=id,name,payment_percent&order=position`)).json ?? [];

    const replacePlanRpc = (items) =>
      request('POST', 'projects', 'rpc/replace_payment_plan', {
        body: { p_project_id: created.projectId, p_milestones: items },
      });

    const before = await planOf();
    const invoiceBefore = (
      await select('finance', `invoices?id=eq.${firstInvoiceId}&select=id,number,status,milestone_id`)
    ).json?.[0];

    check(
      Boolean(invoiceBefore?.milestone_id),
      'the fixture invoice really is attached to a milestone',
      `milestone_id ${invoiceBefore?.milestone_id}`,
    );

    const rewrite = await replacePlanRpc([
      { name: `${MARKER} rewritten A`, percent: 50, amountMinor: 500_000, dueOn: null },
      { name: `${MARKER} rewritten B`, percent: 50, amountMinor: 499_999, dueOn: null },
    ]);

    check(
      rewrite.json?.[0]?.outcome === 'billed',
      'the rewrite is refused while a live invoice exists',
      `outcome: ${rewrite.json?.[0]?.outcome}`,
    );
    check(
      rewrite.json?.[0]?.blocking_number === invoiceBefore?.number,
      'and it names the invoice that refused it',
      `reported ${rewrite.json?.[0]?.blocking_number}, expected ${invoiceBefore?.number}`,
    );

    const invoiceAfter = (
      await select('finance', `invoices?id=eq.${firstInvoiceId}&select=id,status,milestone_id`)
    ).json?.[0];
    check(
      invoiceAfter?.milestone_id === invoiceBefore?.milestone_id,
      'the invoice keeps the milestone it bills — the end state this prevents',
      `${invoiceBefore?.milestone_id} -> ${invoiceAfter?.milestone_id}`,
    );

    const after = await planOf();
    check(
      after.length === before.length,
      'and the plan is untouched',
      `${before.length} -> ${after.length}`,
    );

    // A second rewrite, this one also invalid on its own terms. The invoice
    // guard is checked first so this is still refused as 'billed' — what it
    // proves is that no refusal path writes: the plan is whole either way.
    //
    // That the delete and the insert share a transaction, so a plan rejected
    // by the 100% trigger rolls back to the previous one, is asserted over the
    // migration text in tests/payment-plan-atomic.test.ts. It cannot be shown
    // here without destroying the fixture every later section depends on.
    const bad = await replacePlanRpc([
      { name: `${MARKER} bad`, percent: 30, amountMinor: 1, dueOn: null },
    ]);
    check(
      bad.json?.[0]?.outcome === 'billed',
      'a second rewrite is refused too, and refusals never write',
      `outcome: ${bad.json?.[0]?.outcome}`,
    );
    const afterBad = await planOf();
    check(
      afterBad.length === before.length,
      'and the plan that was already there is still there',
      `${before.length} -> ${afterBad.length}`,
    );
  }

  // ── 4. Structural invariants ─────────────────────────────────────────────
  console.log('\n4. Relationship invariants');
  {
    const orphan = await insert('finance', 'invoices', {
      organization_id: created.organizationId,
      client_account_id: created.clientAccountId,
      project_id: null,
      milestone_id: milestones[1].id,
      number: invoiceNumber(),
      status: 'draft',
      currency: 'INR',
      subtotal_minor: 1,
      total_minor: 1,
    });
    check(
      !orphan.ok && orphan.text.includes('invoices_milestone_implies_project'),
      'a milestone invoice cannot omit its project',
      orphan.ok ? 'one was created' : orphan.text.slice(0, 120),
    );
  }

  // ── 5. Every milestone, and the budget ───────────────────────────────────
  console.log('\n5. Multiple milestones (G)');
  {
    for (const milestone of milestones.slice(1)) {
      const result = await insert('finance', 'invoices', draftInvoiceFor(milestone));
      if (!result.ok) bad(`G. could not invoice milestone ${milestone.position + 1}: ${result.text}`);
    }

    const invoices = await select(
      'finance',
      `invoices?project_id=eq.${created.projectId}&status=neq.void&select=total_minor,milestone_id`,
    );
    const rows = invoices.json ?? [];
    const total = rows.reduce((sum, i) => sum + i.total_minor, 0);

    check(rows.length === milestones.length, `G. one invoice per milestone (${rows.length})`);
    check(
      total === BUDGET_MINOR,
      'G. invoicing every milestone bills the project budget exactly once',
      `sum ${total} ≠ ${BUDGET_MINOR}`,
    );
    check(
      new Set(rows.map((i) => i.milestone_id)).size === rows.length,
      'G. no milestone is billed twice',
    );
  }

  // ── 6. Payment is explicit and separate ──────────────────────────────────
  console.log('\n6. Manual payment (11, 12)');
  {
    await patch('finance', `invoices?id=eq.${firstInvoiceId}`, {
      status: 'issued',
      issued_at: new Date().toISOString(),
    });

    const invoice = (await select('finance', `invoices?id=eq.${firstInvoiceId}&select=*`)).json[0];

    const over = await patch('finance', `invoices?id=eq.${firstInvoiceId}`, {
      paid_minor: invoice.total_minor + 1,
    });
    check(
      !over.ok && over.text.includes('invoices_paid_not_over_total'),
      'an invoice cannot be paid more than it is worth',
      over.ok ? 'the database allowed it' : over.text.slice(0, 120),
    );

    const partial = await insert('finance', 'payments', {
      organization_id: created.organizationId,
      invoice_id: firstInvoiceId,
      provider: 'manual',
      provider_payment_id: `${firstInvoiceId}:${MARKER}-UTR-1`,
      amount_minor: 1000,
      currency: 'INR',
      status: 'captured',
      captured_at: new Date().toISOString(),
    });
    check(partial.ok, 'a manual receipt is recorded with its bank reference', partial.text);

    const replay = await insert('finance', 'payments', {
      organization_id: created.organizationId,
      invoice_id: firstInvoiceId,
      provider: 'manual',
      provider_payment_id: `${firstInvoiceId}:${MARKER}-UTR-1`,
      amount_minor: 1000,
      currency: 'INR',
      status: 'captured',
    });
    check(
      !replay.ok,
      'the same reference cannot be recorded twice against one invoice',
      replay.ok ? 'it was double-counted' : '',
    );

    await patch('finance', `invoices?id=eq.${firstInvoiceId}`, {
      paid_minor: 1000,
      status: 'partially_paid',
    });

    const paidWithoutTimestamp = await patch('finance', `invoices?id=eq.${firstInvoiceId}`, {
      status: 'paid',
      paid_minor: invoice.total_minor,
    });
    check(
      !paidWithoutTimestamp.ok && paidWithoutTimestamp.text.includes('invoices_paid_at_set'),
      'an invoice cannot be marked paid without the moment it was paid',
      paidWithoutTimestamp.ok ? 'the database allowed it' : '',
    );
  }

  // ── 7. RLS ───────────────────────────────────────────────────────────────
  console.log('\n7. Row Level Security (J — publishable key, no organization claim)');
  for (const [schema, table] of [
    ['finance', 'invoices'],
    ['finance', 'invoice_items'],
    ['finance', 'payments'],
    ['projects', 'milestones'],
    ['core', 'outbox_events'],
  ]) {
    const result = await select(schema, `${table}?select=id&limit=5`, PUBLISHABLE);
    const rows = Array.isArray(result.json) ? result.json : null;
    check(
      result.status === 401 || result.status === 403 || (rows !== null && rows.length === 0),
      `J. ${schema}.${table} leaks nothing to a caller with no organization`,
      `status ${result.status}, ${rows?.length ?? '?'} row(s)`,
    );
  }

  {
    const forged = await insert(
      'core',
      'outbox_events',
      {
        organization_id: created.organizationId,
        type: 'invoice.paid',
        subject_type: 'invoice',
        subject_id: firstInvoiceId,
        payload: { marker: MARKER },
      },
      PUBLISHABLE,
    );
    check(
      !forged.ok,
      'J. an unauthenticated caller cannot publish an invoice.paid event',
      forged.ok ? 'the event was accepted' : '',
    );

    const forgedPayment = await insert(
      'finance',
      'payments',
      {
        organization_id: created.organizationId,
        invoice_id: firstInvoiceId,
        provider: 'razorpay',
        provider_payment_id: `${MARKER}-forged`,
        amount_minor: 1,
        currency: 'INR',
        status: 'captured',
      },
      PUBLISHABLE,
    );
    check(
      !forgedPayment.ok,
      'J. an unauthenticated caller cannot fabricate a gateway capture',
      forgedPayment.ok ? 'the payment was accepted' : '',
    );
  }

  // ── 7b. D1 — the ledger cannot exceed the invoice ────────────────────────
  //
  // recordManualPayment refused an overpayment by reading the captured total,
  // adding the new amount and comparing — a check and an insert with a gap in
  // between, and no constraint on finance.payments tying the sum of its rows
  // to the invoice. Two operators recording a receipt at once both passed the
  // check and both inserts landed, and because finance.invoices *does* carry
  // the ceiling, the reconcile that followed failed on that invoice forever.
  //
  // finance.record_manual_payment locks the invoice before summing, so the
  // second caller reads a total that already includes the first.
  //
  // What this section proves and what it does not. The refusals below are real
  // and deterministic: a receipt that would overshoot is refused, nothing is
  // written for it, and the invoice still reconciles. The *lock* is not proved
  // here. Requests submitted together through PostgREST do not reliably
  // interleave — each is a separate transaction it cannot hold open, and
  // locally they complete in under a millisecond — so these checks pass with
  // the FOR UPDATE removed as well. Verified, not assumed: the clause was
  // deleted from the migration, the database reset, and this section still
  // passed. The lock's presence and its position before the sum are pinned in
  // tests/milestone-invoicing.test.ts, which does fail when it is removed.
  {
    console.log('\n7b. D1 — a receipt that would overshoot is refused');

    const paidInvoice = async (id) =>
      (await select('finance', `invoices?id=eq.${id}&select=id,total_minor,paid_minor,verified_minor,status`)).json?.[0];

    const ledgerOf = async (id) => {
      const rows = (await select('finance', `payments?invoice_id=eq.${id}&status=eq.captured&select=amount_minor`)).json;
      return (rows ?? []).reduce((sum, row) => sum + row.amount_minor, 0);
    };

    const record = (id, reference, amountMinor) =>
      request('POST', 'finance', 'rpc/record_manual_payment', {
        body: {
          p_invoice_id: id,
          p_provider_payment_id: `${id}:${reference}`,
          p_amount_minor: amountMinor,
          p_captured_at: new Date().toISOString(),
          p_method: 'bank_transfer',
        },
      });

    const target = await paidInvoice(firstInvoiceId);
    const owed = target.total_minor - (await ledgerOf(firstInvoiceId));

    // Two receipts, each legal alone, together over what is owed.
    const half = Math.floor(owed / 2) + 1;
    const [first, second] = await Promise.all([
      record(firstInvoiceId, 'ZZ-RACE-1', half),
      record(firstInvoiceId, 'ZZ-RACE-2', half),
    ]);
    const outcomes = [first.json?.[0]?.outcome, second.json?.[0]?.outcome];

    check(
      outcomes.filter((o) => o === 'recorded').length === 1,
      'K. of two receipts that together overshoot, only one is recorded',
      `outcomes: ${outcomes.join(', ')}`,
    );
    check(
      outcomes.includes('overpayment'),
      'K. the other is refused as an overpayment, and nothing is written for it',
      `outcomes: ${outcomes.join(', ')}`,
    );

    const afterRace = await ledgerOf(firstInvoiceId);
    check(
      afterRace <= target.total_minor,
      `K. the ledger never exceeds the invoice — ${afterRace} of ${target.total_minor}`,
    );

    // G-008: the invoice no longer needs reconciling by anybody. The total is
    // written inside the same statement as the payment, under the same lock,
    // so paid_minor cannot lag the ledger it summarises — and the wedge D1
    // caused (a summed total the constraint refused, on every retry) has
    // nowhere left to form.
    const reconciledRow = await paidInvoice(firstInvoiceId);
    check(
      reconciledRow.paid_minor === afterRace,
      'K. the invoice total already matches the ledger — nothing to reconcile',
      `paid_minor ${reconciledRow.paid_minor}, ledger ${afterRace}`,
    );
    // G-007 replaced this invariant rather than removing it. It used to read
    // "paid_minor === total_minor ⟺ status paid". Recording money no longer
    // makes an invoice paid — confirming it does — so the pairing is now
    // against verified_minor, and a fully *recorded* invoice with nothing
    // confirmed must NOT be paid.
    check(
      (reconciledRow.verified_minor === reconciledRow.total_minor) ===
        (reconciledRow.status === 'paid'),
      'K. and its status agrees with what has been confirmed, not merely recorded',
      `status ${reconciledRow.status}, verified ${reconciledRow.verified_minor} of ${reconciledRow.total_minor}`,
    );
    check(
      reconciledRow.status !== 'paid',
      'K. money recorded and not yet confirmed leaves the invoice unpaid — ADM-04',
      `status ${reconciledRow.status}, recorded ${reconciledRow.paid_minor}`,
    );

    // Serialisation under real contention: only as many as fit may land.
    const remaining = target.total_minor - (await ledgerOf(firstInvoiceId));
    if (remaining > 0) {
      const slice = Math.max(1, Math.floor(remaining / 4));
      const burst = await Promise.all(
        Array.from({ length: 10 }, (_, i) => record(firstInvoiceId, `ZZ-BURST-${i}`, slice)),
      );
      const landed = burst.filter((r) => r.json?.[0]?.outcome === 'recorded').length;
      const ledgerAfterBurst = await ledgerOf(firstInvoiceId);

      check(
        ledgerAfterBurst <= target.total_minor,
        `L. ten receipts submitted together still cannot overshoot — ${ledgerAfterBurst} of ${target.total_minor}`,
      );
      check(
        landed === Math.floor(remaining / slice),
        `L. exactly the ${Math.floor(remaining / slice)} that fit were recorded, ${landed} landed`,
      );
      check(
        burst.filter((r) => r.json?.[0]?.outcome === 'overpayment').length === 10 - landed,
        'L. every receipt that did not fit was refused as an overpayment',
      );

      // G-008 under real contention: ten writers, and the cache still agrees
      // with the rows. Before the total moved inside the lock, each of the
      // recorded ones reconciled separately afterwards and a slow one could
      // write its lower total over a faster one's.
      const afterBurstRow = await paidInvoice(firstInvoiceId);
      check(
        afterBurstRow.paid_minor === ledgerAfterBurst,
        'L. the invoice total matches the ledger after ten concurrent receipts',
        `paid_minor ${afterBurstRow.paid_minor}, ledger ${ledgerAfterBurst}`,
      );
    }

    // The refusals the function inherits from applyPayment, under the lock.
    // The reference that actually won K, not a guess at which one did.
    //
    // This asked for ZZ-RACE-1 unconditionally, which is only a duplicate if
    // that call was the one that landed. When it lost the race the reference
    // was never recorded, so re-sending it was a legitimate new receipt and
    // the check saw 'recorded'. It passed on every local run and failed the
    // first time CI ran it on different hardware — the race has no preferred
    // winner, and the check had assumed one.
    const landedReference = first.json?.[0]?.outcome === 'recorded' ? 'ZZ-RACE-1' : 'ZZ-RACE-2';
    const dup = await record(firstInvoiceId, landedReference, 1);
    check(
      ['duplicate', 'overpayment'].includes(dup.json?.[0]?.outcome),
      'M. the same bank reference is never recorded twice',
      `reference ${landedReference}, outcome: ${dup.json?.[0]?.outcome}`,
    );

    const nonPositive = await record(firstInvoiceId, 'ZZ-ZERO', 0);
    check(
      nonPositive.json?.[0]?.outcome === 'non_positive',
      'M. a zero payment is refused',
      `outcome: ${nonPositive.json?.[0]?.outcome}`,
    );

    const missing = await record('00000000-0000-4000-8000-000000000000', 'ZZ-GHOST', 100);
    check(
      missing.json?.[0]?.outcome === 'not_found',
      'M. a payment against no invoice is refused',
      `outcome: ${missing.json?.[0]?.outcome}`,
    );
  }

  // ── 7c. D2 — a void cannot land on money ─────────────────────────────────
  //
  // voidInvoice read the invoice, refused if the cached `paid_minor` was above
  // zero, and then wrote status = 'void' with the id as its only predicate. A
  // payment committing in between was neither seen by the check nor excluded
  // by the write, so the invoice ended void while holding captured money — and
  // because invoices_milestone_live_key excludes void rows, the milestone the
  // client had just paid for became billable again.
  //
  // finance.void_invoice locks the invoice, sums the payment rows through that
  // lock, and writes in the same statement.
  //
  // What this section proves, and it proves more than §7b could.
  //
  // Check N is deterministic: it builds the exact state the old guard got
  // wrong — captured rows present, the cached sum stale at zero — and requires
  // a refusal. A fix that consulted the cache instead of the ledger fails it
  // here. Verified, not assumed: the sum was replaced with a read of
  // paid_minor, the database reset, and N failed with `status partially_paid →
  // void`, which is D2 exactly.
  //
  // Check Q catches the missing lock, which §7b explicitly could not. The
  // difference is what the two racers are doing. §7b raced two calls of one
  // short function; here a void races a *payment*, so the window in which the
  // void can sum a ledger the payment has not yet committed to is as wide as
  // the payment's own work. Verified the same way: FOR UPDATE was deleted from
  // finance.void_invoice, the database reset, and the section run five times —
  // all five ended with an invoice void and a captured payment against it, and
  // all five failed.
  //
  // What is still not proved here is serialisation in general, only for this
  // pair. The clause's presence and its position before the sum are pinned in
  // tests/invoice-void.test.ts, which fails under all seven mutations of the
  // migration that were tried.
  {
    console.log('\n7c. D2 — a void cannot land on money');

    const invoiceRow = async (id) =>
      (
        await select(
          'finance',
          `invoices?id=eq.${id}&select=id,status,notes,total_minor,paid_minor,milestone_id`,
        )
      ).json?.[0];

    const ledgerOf = async (id) => {
      const rows = (
        await select('finance', `payments?invoice_id=eq.${id}&status=eq.captured&select=amount_minor`)
      ).json;
      return (rows ?? []).reduce((sum, row) => sum + row.amount_minor, 0);
    };

    const voidIt = (id, note) =>
      request('POST', 'finance', 'rpc/void_invoice', {
        body: { p_invoice_id: id, p_note: note },
      });

    const now = () => new Date().toISOString();

    // ── N. the ledger decides, not the cache ───────────────────────────────
    //
    // firstInvoiceId carries the receipts §6 and §7b recorded. Setting
    // paid_minor back to zero reproduces a reconcile that never landed — which
    // is a real state, because invoices_paid_not_over_total only bounds the
    // cache from above (§6 proves that). This is precisely what the old guard
    // consulted.
    const ledgerBefore = await ledgerOf(firstInvoiceId);
    const rowBefore = await invoiceRow(firstInvoiceId);
    check(
      ledgerBefore > 0,
      'N. the fixture invoice really does hold captured money',
      `ledger ${ledgerBefore}`,
    );

    await patch('finance', `invoices?id=eq.${firstInvoiceId}`, { paid_minor: 0 });

    const onStale = await voidIt(firstInvoiceId, 'Voided: ZZTEST stale cache');
    check(
      onStale.json?.[0]?.outcome === 'has_payments',
      'N. a void is refused from the payment rows, not the cached paid_minor',
      `ledger ${ledgerBefore}, cache 0, outcome ${onStale.json?.[0]?.outcome}`,
    );
    check(
      onStale.json?.[0]?.captured_minor === ledgerBefore,
      'N. and it reports the sum it read under the lock',
      `reported ${onStale.json?.[0]?.captured_minor}, ledger ${ledgerBefore}`,
    );

    const afterRefusal = await invoiceRow(firstInvoiceId);
    check(
      afterRefusal.status === rowBefore.status && afterRefusal.notes === rowBefore.notes,
      'N. a refused void writes nothing at all',
      `status ${rowBefore.status} → ${afterRefusal.status}`,
    );

    await patch('finance', `invoices?id=eq.${firstInvoiceId}`, { paid_minor: ledgerBefore });

    // The spare drafts §5 raised for the remaining milestones.
    const spares = (
      await select(
        'finance',
        `invoices?project_id=eq.${created.projectId}&status=eq.draft&select=id,total_minor,milestone_id&order=number.asc`,
      )
    ).json ?? [];

    if (spares.length < 3) {
      bad(`7c needs three spare draft invoices, found ${spares.length}`);
    } else {
      // ── O. a paid invoice is a refund, not a void ────────────────────────
      const paid = spares[0];
      await patch('finance', `invoices?id=eq.${paid.id}`, {
        status: 'paid',
        issued_at: now(),
        paid_at: now(),
        paid_minor: paid.total_minor,
      });

      const onPaid = await voidIt(paid.id, 'Voided: ZZTEST paid');
      check(
        onPaid.json?.[0]?.outcome === 'not_voidable',
        'O. a paid invoice cannot be voided, even with an empty ledger',
        `outcome: ${onPaid.json?.[0]?.outcome}`,
      );
      check(
        onPaid.json?.[0]?.invoice_status === 'paid',
        'O. and the refusal names the status the lock saw',
        `reported: ${onPaid.json?.[0]?.invoice_status}`,
      );

      // ── P. the void that lands ───────────────────────────────────────────
      const clean = spares[1];
      await patch('finance', `invoices?id=eq.${clean.id}`, {
        status: 'issued',
        issued_at: now(),
        notes: 'ZZTEST raised early',
      });

      const voided = await voidIt(clean.id, 'Voided: ZZTEST superseded');
      check(
        voided.json?.[0]?.outcome === 'voided',
        'P. an invoice with nothing against it is withdrawn',
        `outcome: ${voided.json?.[0]?.outcome}`,
      );

      const cleanRow = await invoiceRow(clean.id);
      check(cleanRow.status === 'void', 'P. and the row really is void', `status ${cleanRow.status}`);
      check(
        cleanRow.notes === 'ZZTEST raised early\nVoided: ZZTEST superseded',
        'P. the reason is appended to the note read under the lock',
        JSON.stringify(cleanRow.notes),
      );

      // Voiding through the function still frees the milestone — the same
      // property §3 checks of a raw PATCH.
      const replacement = await insert(
        'finance',
        'invoices',
        draftInvoiceFor({ id: cleanRow.milestone_id, currency: 'INR', amount_minor: 1 }),
      );
      check(
        replacement.ok,
        'P. a voided invoice frees its milestone to be billed again',
        replacement.text.slice(0, 120),
      );
      await remove('finance', `invoices?id=eq.${replacement.json?.[0]?.id ?? 'none'}`);

      const twice = await voidIt(clean.id, 'Voided: ZZTEST again');
      check(
        twice.json?.[0]?.outcome === 'already_void',
        'P. voiding it a second time is the same answer, not an error',
        `outcome: ${twice.json?.[0]?.outcome}`,
      );
      const afterTwice = await invoiceRow(clean.id);
      check(
        afterTwice.notes === cleanRow.notes,
        'P. and it appends nothing the second time',
        JSON.stringify(afterTwice.notes),
      );

      // ── Q. a void and a receipt, submitted together ──────────────────────
      const contested = spares[2];
      await patch('finance', `invoices?id=eq.${contested.id}`, {
        status: 'issued',
        issued_at: now(),
      });

      const [race1, race2] = await Promise.all([
        voidIt(contested.id, 'Voided: ZZTEST raced'),
        request('POST', 'finance', 'rpc/record_manual_payment', {
          body: {
            p_invoice_id: contested.id,
            p_provider_payment_id: `${contested.id}:ZZ-VOID-RACE`,
            p_amount_minor: 1,
            p_captured_at: now(),
            p_method: 'bank_transfer',
          },
        }),
      ]);

      const voidOutcome = race1.json?.[0]?.outcome;
      const payOutcome = race2.json?.[0]?.outcome;
      const winners = [voidOutcome === 'voided', payOutcome === 'recorded'].filter(Boolean).length;

      check(
        winners === 1,
        'Q. of a void and a receipt racing, exactly one lands',
        `void: ${voidOutcome}, payment: ${payOutcome}`,
      );
      check(
        voidOutcome !== 'voided' || payOutcome !== 'recorded',
        'Q. the loser is refused, never silently overwritten',
        `void: ${voidOutcome}, payment: ${payOutcome}`,
      );

      const contestedRow = await invoiceRow(contested.id);
      const contestedLedger = await ledgerOf(contested.id);
      check(
        !(contestedRow.status === 'void' && contestedLedger > 0),
        'Q. no invoice ends void while holding captured money — the D2 end state',
        `status ${contestedRow.status}, ledger ${contestedLedger}`,
      );

      const ghost = await voidIt('00000000-0000-4000-8000-000000000000', 'Voided: ZZTEST ghost');
      check(
        ghost.json?.[0]?.outcome === 'not_found',
        'Q. voiding an invoice that does not exist is refused',
        `outcome: ${ghost.json?.[0]?.outcome}`,
      );
    }
  }

  // ── 7d. D4 — an issue cannot land on a decision already taken ────────────
  //
  // issueInvoice read the invoice, decided from that copy, counted its line
  // items in a separate round trip, and wrote status = 'issued' with the id as
  // its only predicate. A void landing in one of those gaps was overwritten —
  // a withdrawn invoice went live again, still carrying its 'Voided:' note and
  // still holding the milestone's live slot. A payment landing in one of them
  // was worse: a settled invoice came back as outstanding, keeping its paid_at
  // and its full ledger, with no way back through the application.
  //
  // finance.issue_invoice decides under a lock on the invoice, and locks the
  // line items while it checks them.
  //
  // What this proves: every refusal, deterministically, including the two the
  // old code could not make at all — a voided or a paid invoice reaching the
  // write. Whether it also catches a missing lock was measured rather than
  // assumed, and the answer is "sometimes"; the note at the end of the section
  // gives the number.
  {
    console.log('\n7d. D4 — an issue cannot land on a decision already taken');

    const invoiceRow = async (id) =>
      (await select('finance', `invoices?id=eq.${id}&select=id,status,issued_at,due_at,notes`)).json?.[0];

    const issueIt = (id, dueAt) =>
      request('POST', 'finance', 'rpc/issue_invoice', {
        body: { p_invoice_id: id, ...(dueAt ? { p_due_at: dueAt } : {}) },
      });

    // §7c's helper is scoped to its own block; the race below needs one too.
    const voidFor = (id, note) =>
      request('POST', 'finance', 'rpc/void_invoice', {
        body: { p_invoice_id: id, p_note: note },
      });

    // Postgres renders timestamptz as +00:00, not Z. Compare the instants.
    const sameInstant = (a, b) => a !== null && b !== null && Date.parse(a) === Date.parse(b);

    const stamp = () => new Date().toISOString();

    // A milestone of its own, so this section does not depend on which live
    // invoice slots the sections above left free. `payment_percent: null` is a
    // delivery checkpoint with money attached but no share of the plan, so
    // assert_payment_plan_totals still sees the same 100%.
    const spareMilestone = await insert('projects', 'milestones', {
      organization_id: created.organizationId,
      project_id: created.projectId,
      name: `${MARKER} issue-check milestone`,
      position: milestones.length,
      payment_percent: null,
      amount_minor: 50_000,
      currency: 'INR',
    });

    if (!spareMilestone.ok) {
      bad(`7d could not add a milestone: ${spareMilestone.text.slice(0, 120)}`);
    }

    const fresh = spareMilestone.ok
      ? await insert('finance', 'invoices', draftInvoiceFor(spareMilestone.json[0]))
      : { ok: false, text: 'no milestone' };

    if (!fresh.ok) {
      bad(`7d could not raise a draft: ${fresh.text.slice(0, 120)}`);
    } else {
      const draftId = fresh.json[0].id;
      const lineAmount = spareMilestone.json[0].amount_minor;

      // ── R. a bill with no lines is not a bill ──────────────────────────
      const bare = await issueIt(draftId);
      check(
        bare.json?.[0]?.outcome === 'no_items',
        'R. an invoice with no line items is refused',
        `outcome: ${bare.json?.[0]?.outcome}`,
      );
      const stillDraft = await invoiceRow(draftId);
      check(
        stillDraft.status === 'draft' && stillDraft.issued_at === null,
        'R. and a refused issue writes nothing at all',
        `status ${stillDraft.status}, issued_at ${stillDraft.issued_at}`,
      );

      await insert('finance', 'invoice_items', {
        organization_id: created.organizationId,
        invoice_id: draftId,
        position: 0,
        description: `${MARKER} line`,
        quantity: 1,
        unit_price_minor: lineAmount,
        amount_minor: lineAmount,
        tax_rate_bp: 0,
      });

      // ── S. the issue that lands ────────────────────────────────────────
      const due = '2026-12-31T00:00:00.000Z';
      const sent = await issueIt(draftId, due);
      check(
        sent.json?.[0]?.outcome === 'issued',
        'S. an invoice with lines and an amount is issued',
        `outcome: ${sent.json?.[0]?.outcome}`,
      );
      check(
        sent.json?.[0]?.invoice_status === 'draft',
        'S. and it reports the status the lock saw',
        `reported: ${sent.json?.[0]?.invoice_status}`,
      );
      const issued = await invoiceRow(draftId);
      check(
        issued.status === 'issued' && issued.issued_at !== null,
        'S. the row is issued, and carries the moment it happened',
        `status ${issued.status}, issued_at ${issued.issued_at}`,
      );
      check(
        sameInstant(issued.due_at, due),
        'S. the due date supplied is the one stored',
        `${issued.due_at}`,
      );

      const again = await issueIt(draftId);
      check(
        again.json?.[0]?.outcome === 'already_issued',
        'S. issuing it a second time is the same answer, not an error',
        `outcome: ${again.json?.[0]?.outcome}`,
      );
      const afterAgain = await invoiceRow(draftId);
      check(
        sameInstant(afterAgain.due_at, due),
        'S. and asking again writes nothing over the due date',
        `${afterAgain.due_at}`,
      );

      // The check above rides the already_issued branch, which returns before
      // the UPDATE — so it cannot see the coalesce. Put the invoice back to
      // draft with its due date intact and issue it again with none supplied:
      // that reaches the write, and fails if the coalesce is dropped.
      await patch('finance', `invoices?id=eq.${draftId}`, { status: 'draft', issued_at: null });
      const reissued = await issueIt(draftId);
      const afterReissue = await invoiceRow(draftId);
      check(
        reissued.json?.[0]?.outcome === 'issued' && sameInstant(afterReissue.due_at, due),
        'S. an issue with no due date leaves the existing one alone',
        `outcome ${reissued.json?.[0]?.outcome}, due_at ${afterReissue.due_at}`,
      );

      // ── T. the two states the old code could write over ────────────────
      await patch('finance', `invoices?id=eq.${draftId}`, { status: 'void' });
      const onVoid = await issueIt(draftId);
      check(
        onVoid.json?.[0]?.outcome === 'not_issuable',
        'T. a voided invoice cannot be issued back to life',
        `outcome: ${onVoid.json?.[0]?.outcome}`,
      );
      check(
        onVoid.json?.[0]?.invoice_status === 'void',
        'T. and the refusal names the status the lock saw',
        `reported: ${onVoid.json?.[0]?.invoice_status}`,
      );

      await patch('finance', `invoices?id=eq.${draftId}`, {
        status: 'paid',
        paid_at: stamp(),
        paid_minor: lineAmount,
      });
      const onPaid = await issueIt(draftId);
      check(
        onPaid.json?.[0]?.outcome === 'not_issuable',
        'T. a settled invoice cannot be re-issued as outstanding',
        `outcome: ${onPaid.json?.[0]?.outcome}`,
      );
      const afterPaid = await invoiceRow(draftId);
      check(
        afterPaid.status === 'paid',
        'T. and the settled invoice is untouched — the D4 end state',
        `status ${afterPaid.status}`,
      );

      // ── U. an issue and a void, submitted together ─────────────────────
      await patch('finance', `invoices?id=eq.${draftId}`, {
        status: 'draft',
        paid_minor: 0,
        paid_at: null,
        issued_at: null,
      });

      const [issueRace, voidRace] = await Promise.all([
        issueIt(draftId),
        voidFor(draftId, 'Voided: ZZTEST issue race'),
      ]);
      const issueOutcome = issueRace.json?.[0]?.outcome;
      const voidOutcome2 = voidRace.json?.[0]?.outcome;
      const both = `issue: ${issueOutcome}, void: ${voidOutcome2}`;

      // NOT the "exactly one lands" §7c makes of a void and a payment. These
      // two are not mutually exclusive, and asserting that they are would fail
      // against a correct database: void_invoice admits an issued invoice, so
      // if the issue takes the lock first the void follows it legitimately and
      // both report success. Only the reverse ordering produces one winner,
      // because a void invoice is not issuable.
      //
      // What must hold either way is that neither call claims an outcome the
      // row does not show, and that the two orderings are the only two.
      check(
        issueOutcome === 'issued' || issueOutcome === 'not_issuable',
        'U. the issue either lands or is refused because the void got there first',
        both,
      );
      check(
        voidOutcome2 === 'voided',
        'U. the void lands in both orderings — an issued invoice is still voidable',
        both,
      );

      const raced = await invoiceRow(draftId);
      check(
        raced.status === 'void',
        'U. and the invoice ends withdrawn, whichever order they arrived in',
        `${both}, status: ${raced.status}`,
      );
      check(
        issueOutcome !== 'not_issuable' || issueRace.json?.[0]?.invoice_status === 'void',
        'U. a refused issue names the status the lock saw, not the caller stale copy',
        `reported: ${issueRace.json?.[0]?.invoice_status}`,
      );
      check(
        !(raced.status === 'issued' && (raced.notes ?? '').includes('Voided:')),
        'U. no invoice ends issued carrying a void note — the D4 end state',
        `status ${raced.status}, notes ${JSON.stringify(raced.notes)}`,
      );

      const ghostIssue = await issueIt('00000000-0000-4000-8000-000000000000');
      check(
        ghostIssue.json?.[0]?.outcome === 'not_found',
        'U. issuing an invoice that does not exist is refused',
        `outcome: ${ghostIssue.json?.[0]?.outcome}`,
      );

      await remove('finance', `invoice_items?invoice_id=eq.${draftId}`);
      await remove('finance', `invoices?id=eq.${draftId}`);
    }

    console.log(
      '  \x1b[2mnote: check U catches a deleted FOR UPDATE intermittently — measured at\n' +
        '  three failures in five resets. Not the 5/5 of §7c, not the 0/5 of §7b.\n' +
        '  With the clause present it passes every time, so it never fails falsely;\n' +
        '  it simply cannot be relied on alone to notice the clause going missing.\n' +
        '  tests/invoice-issue.test.ts pins it, and does fail under all ten mutations\n' +
        '  of the migration that were tried.\x1b[0m',
    );
  }
  // ── 7e. D16 — the database refuses what the application refuses ─────────
  //
  // §7 proves the database denies a caller with no organization claim. This
  // proves something narrower and, until D16, untrue: that it denies a caller
  // who has a perfectly good claim but not the capability.
  //
  // RLS was the wider of the two authorization layers. invoices_select
  // admitted every internal role, so a contractor — an external collaborator —
  // could read the whole invoice book straight from the Data API, and the
  // delivery and crm write policies admitted member, who holds none of those
  // capabilities. The application refused all of it, and the application is
  // not what this codebase calls the backstop.
  //
  // The owner control runs first and is not decoration. Without it every "sees
  // nothing" reads as a pass even when the token shape is wrong and nobody
  // sees anything — which is exactly how the first draft of this check fooled
  // its author.
  {
    console.log('\n7e. D16 — RLS matches the capability model');

    /** An HS256 token shaped the way core.current_user_role() reads it. */
    const mint = (role) => {
      const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const now = Math.floor(Date.now() / 1000);
      const header = b64({ alg: 'HS256', typ: 'JWT' });
      const body = b64({
        sub: randomUUID(),
        aud: 'authenticated',
        role: 'authenticated',
        iat: now,
        exp: now + 600,
        app_metadata: { role, organization_id: created.organizationId },
      });
      const sig = createHmac('sha256', target.jwtSecret)
        .update(`${header}.${body}`)
        .digest('base64url');
      return `${header}.${body}.${sig}`;
    };

    const rowsFor = async (role, schema, path) => {
      const res = await request('GET', schema, path, { key: mint(role) });
      return Array.isArray(res.json) ? res.json : null;
    };

    const ownerSees = await rowsFor('owner', 'finance', 'invoices?select=id&limit=5');
    const controlHolds = Array.isArray(ownerSees) && ownerSees.length > 0;
    check(
      controlHolds,
      'control: an owner reads invoices, so the refusals below mean something',
      `owner saw ${ownerSees === null ? 'an error' : ownerSees.length + ' rows'}`,
    );

    if (controlHolds) {
      for (const role of ['contractor', 'member', 'delivery_lead']) {
        for (const table of ['invoices', 'invoice_items']) {
          const seen = await rowsFor(role, 'finance', `${table}?select=id&limit=5`);
          check(
            Array.isArray(seen) && seen.length === 0,
            `${role} reads nothing from finance.${table}`,
            `saw ${seen === null ? 'an error' : seen.length + ' row(s)'} — invoice.read is owner and ops_admin only`,
          );
        }
      }

      // The write side, and the coupling. A delivery_lead may rewrite a plan
      // but may not read the invoice book — and the D8 guard must still find
      // the bill that blocks the rewrite, which is what
      // finance.blocking_invoice_number exists for.
      // The guard needs a live invoice on a priced milestone to find. Earlier
      // sections have voided, paid and orphaned their way through the fixture,
      // so this asserts the precondition rather than assuming it — a check
      // that silently ran without one would pass while proving nothing.
      const liveOnPriced = (
        await select(
          'finance',
          `invoices?project_id=eq.${created.projectId}&status=neq.void&milestone_id=not.is.null&select=id,number,milestone_id`,
        )
      ).json ?? [];

      const pricedIds = new Set(
        (
          await select(
            'projects',
            `milestones?project_id=eq.${created.projectId}&payment_percent=not.is.null&select=id`,
          )
        ).json?.map((m) => m.id) ?? [],
      );

      const blocker = liveOnPriced.find((i) => pricedIds.has(i.milestone_id));

      check(
        Boolean(blocker),
        'a live invoice sits on a priced milestone, so the guard has something to find',
        `${liveOnPriced.length} live invoice(s), none on a priced milestone`,
      );

      const guarded = await request('POST', 'projects', 'rpc/replace_payment_plan', {
        key: mint('delivery_lead'),
        body: {
          p_project_id: created.projectId,
          p_milestones: [{ name: `${MARKER} x`, percent: 100, amountMinor: 1, dueOn: null }],
        },
      });
      check(
        guarded.json?.[0]?.outcome === 'billed',
        'a delivery_lead still cannot rewrite a plan carrying a live invoice',
        `outcome: ${guarded.json?.[0]?.outcome} — D16 must not re-open D8`,
      );
      check(
        guarded.json?.[0]?.blocking_number === blocker?.number,
        'and the definer helper names the same invoice the owner can see',
        `reported ${guarded.json?.[0]?.blocking_number}, expected ${blocker?.number}`,
      );

      const memberWrite = await request('PATCH', 'projects', `projects?id=eq.${created.projectId}`, {
        key: mint('member'),
        body: { name: `${MARKER} member-write` },
        prefer: 'return=representation',
      });
      check(
        !Array.isArray(memberWrite.json) || memberWrite.json.length === 0,
        'a member writes no projects — project.write is not theirs',
        `wrote ${Array.isArray(memberWrite.json) ? memberWrite.json.length : '?'} row(s)`,
      );
    }
  }

  // ── 7f. D17 — the event is written by the statement that writes the state ─
  //
  // The outbox was documented as transactional and was not. emitEvent inserted
  // from the application, over its own connection, after the state change had
  // already committed — so a failure there left the money written and the
  // event gone. Not delayed: gone, because an INSERT that failed leaves no row
  // to find and nothing to replay.
  //
  // What this section proves, and how it would have failed before the fix:
  // every call below goes straight to the RPC over PostgREST, with no
  // application process in the loop at all. Before D17 the functions published
  // nothing — every event came from TypeScript — so each outbox assertion here
  // would find zero rows. After it, the events are there because the function
  // wrote them.
  //
  // What it does not prove, stated plainly: that the INSERT shares the
  // transaction. That follows from it being inside a plpgsql function, which
  // Postgres guarantees and no test needs to re-establish; the structural
  // assertions live in tests/outbox-transactional.test.ts. What *is* proved
  // here is the observable half — a refusal leaves nothing behind, including
  // the duplicate path, which refuses only after its INSERT has already raised
  // inside the function.
  {
    console.log('\n7f. D17 — events are published by the function, not after it');

    const eventsFor = async (invoiceId) => {
      const res = await select(
        'core',
        `outbox_events?subject_id=eq.${invoiceId}&select=id,type,payload&order=id.asc`,
      );
      return Array.isArray(res.json) ? res.json : [];
    };

    const plan = await replacePlan([50, 50]);
    const milestones = [...(plan.json ?? [])].sort((a, b) => a.position - b.position);
    const [first, second] = milestones;

    if (!first || !second) {
      bad('7f could not build a two-milestone plan');
    } else {
      const draft = await insert('finance', 'invoices', draftInvoiceFor(first));
      const invoice = draft.json?.[0];
      await insert('finance', 'invoice_items', {
        organization_id: created.organizationId,
        invoice_id: invoice.id,
        position: 0,
        description: `${MARKER} line`,
        quantity: 1,
        unit_price_minor: first.amount_minor,
        amount_minor: first.amount_minor,
        tax_rate_bp: 0,
      });

      // ── issue ───────────────────────────────────────────────────────────
      await request('POST', 'finance', 'rpc/issue_invoice', {
        body: { p_invoice_id: invoice.id },
      });

      let events = await eventsFor(invoice.id);
      const issued = events.filter((e) => e.type === 'invoice.issued');
      check(
        issued.length === 1,
        'issuing an invoice publishes exactly one invoice.issued, from the RPC alone',
        `found ${issued.length} — before D17 the function published nothing`,
      );
      check(
        issued[0]?.payload?.number === invoice.number &&
          issued[0]?.payload?.milestoneId === first.id &&
          issued[0]?.payload?.totalMinor === first.amount_minor,
        'and it carries the number, milestone and total a sender needs',
        JSON.stringify(issued[0]?.payload ?? null),
      );

      // ── a partial payment ───────────────────────────────────────────────
      const half = Math.floor(first.amount_minor / 2);
      // Captured, because G-007 needs it to confirm this receipt separately
      // from the one that settles the balance.
      const halfPayment = await request('POST', 'finance', 'rpc/record_manual_payment', {
        body: {
          p_invoice_id: invoice.id,
          p_provider_payment_id: `${MARKER}-part`,
          p_amount_minor: half,
          p_captured_at: new Date().toISOString(),
          p_method: 'bank_transfer',
        },
      });
      const halfPaymentId = halfPayment.json?.[0]?.payment_id;

      events = await eventsFor(invoice.id);
      check(
        events.filter((e) => e.type === 'payment.recorded').length === 1,
        'a partial payment publishes payment.recorded',
        `found ${events.filter((e) => e.type === 'payment.recorded').length}`,
      );
      check(
        events.filter((e) => e.type === 'invoice.paid').length === 0,
        'and does not announce the milestone gate — the invoice is not covered',
      );

      // ── the same receipt twice ──────────────────────────────────────────
      //
      // Sent here, while the invoice is only partially paid and therefore
      // still payable. Once it is covered the status check refuses first and
      // the duplicate path is never reached — which is what the first draft of
      // this section got wrong, and why the assertion below is placed by what
      // it needs to exercise rather than by what reads tidily.
      //
      // This is the refusal worth proving: it is the only one that returns
      // from inside the exception handler, after an INSERT has already been
      // attempted in the function's transaction.
      const partial = (await eventsFor(invoice.id)).length;
      const twice = await request('POST', 'finance', 'rpc/record_manual_payment', {
        body: {
          p_invoice_id: invoice.id,
          p_provider_payment_id: `${MARKER}-part`,
          p_amount_minor: 1,
          p_captured_at: new Date().toISOString(),
          p_method: 'bank_transfer',
        },
      });
      check(
        twice.json?.[0]?.outcome === 'duplicate',
        'the same bank reference is still refused as a duplicate',
        `outcome: ${twice.json?.[0]?.outcome}`,
      );
      check(
        (await eventsFor(invoice.id)).length === partial,
        'and the duplicate publishes nothing — the refusal returns before the emit',
      );

      // ── an overpayment, refused ─────────────────────────────────────────
      const before = (await eventsFor(invoice.id)).length;
      const over = await request('POST', 'finance', 'rpc/record_manual_payment', {
        body: {
          p_invoice_id: invoice.id,
          p_provider_payment_id: `${MARKER}-over`,
          p_amount_minor: first.amount_minor,
          p_captured_at: new Date().toISOString(),
          p_method: 'bank_transfer',
        },
      });
      check(
        over.json?.[0]?.outcome === 'overpayment',
        'an overpayment is still refused',
        `outcome: ${over.json?.[0]?.outcome}`,
      );
      check(
        (await eventsFor(invoice.id)).length === before,
        'and a refused payment publishes nothing at all',
      );

      // ── the rest of the money ───────────────────────────────────────────
      const settle = await request('POST', 'finance', 'rpc/record_manual_payment', {
        body: {
          p_invoice_id: invoice.id,
          p_provider_payment_id: `${MARKER}-rest`,
          p_amount_minor: first.amount_minor - half,
          p_captured_at: new Date().toISOString(),
          p_method: 'bank_transfer',
        },
      });
      check(
        settle.json?.[0]?.outcome === 'recorded' &&
          settle.json?.[0]?.status_after === 'partially_paid',
        'the balance is recorded, and the invoice is NOT paid — nobody has confirmed it (G-007)',
        JSON.stringify(settle.json?.[0] ?? null),
      );

      // The heart of ADM-04. Every rupee is recorded; the client's word is in
      // the ledger; delivery has not moved.
      check(
        (await eventsFor(invoice.id)).filter((e) => e.type === 'invoice.paid').length === 0,
        'and recording the whole amount publishes no invoice.paid at all',
      );

      // ── confirming it ───────────────────────────────────────────────────
      const verifyFirst = await request('POST', 'finance', 'rpc/verify_payment', {
        body: { p_payment_id: halfPaymentId, p_verified_by: null },
      });
      check(
        verifyFirst.json?.[0]?.outcome === 'verified' &&
          verifyFirst.json?.[0]?.status_after !== 'paid',
        'confirming half the money confirms half the money',
        JSON.stringify(verifyFirst.json?.[0] ?? null),
      );
      check(
        (await eventsFor(invoice.id)).filter((e) => e.type === 'invoice.paid').length === 0,
        'and still publishes no invoice.paid, because the invoice is not covered',
      );

      const verifyRest = await request('POST', 'finance', 'rpc/verify_payment', {
        body: { p_payment_id: settle.json?.[0]?.payment_id, p_verified_by: null },
      });
      check(
        verifyRest.json?.[0]?.outcome === 'verified' &&
          verifyRest.json?.[0]?.status_after === 'paid',
        'confirming the rest is what makes the invoice paid',
        JSON.stringify(verifyRest.json?.[0] ?? null),
      );

      events = await eventsFor(invoice.id);
      const paid = events.filter((e) => e.type === 'invoice.paid');
      check(
        paid.length === 1,
        'and publishes exactly one invoice.paid — from the confirmation, not the recording',
        `found ${paid.length}`,
      );

      // Confirming twice is the answer, not a second unlock.
      const verifiedTwice = await request('POST', 'finance', 'rpc/verify_payment', {
        body: { p_payment_id: settle.json?.[0]?.payment_id, p_verified_by: null },
      });
      check(
        verifiedTwice.json?.[0]?.outcome === 'already_verified',
        'confirming the same payment twice is answered, not repeated',
        `outcome: ${verifiedTwice.json?.[0]?.outcome}`,
      );
      check(
        (await eventsFor(invoice.id)).filter((e) => e.type === 'invoice.paid').length === 1,
        'and publishes no second invoice.paid',
      );
      // The rule: the first priced milestone, in plan order, with no paid
      // invoice. The first is paid now, the second has no invoice at all, so
      // the second is the answer — and the same answer nextUnlockedMilestone
      // gives for these rows in TypeScript.
      check(
        paid[0]?.payload?.unlockedMilestoneId === second.id,
        'and it names the next priced milestone the plan actually points at',
        `named ${paid[0]?.payload?.unlockedMilestoneId}, expected ${second.id}`,
      );
      check(
        verifyRest.json?.[0]?.unlocked_milestone_id === paid[0]?.payload?.unlockedMilestoneId,
        'the caller is told the same milestone the event carries, from one statement',
        `returned ${verifyRest.json?.[0]?.unlocked_milestone_id}`,
      );

      // ── and nothing more lands on a covered invoice ─────────────────────
      const settled = (await eventsFor(invoice.id)).length;
      const again = await request('POST', 'finance', 'rpc/record_manual_payment', {
        body: {
          p_invoice_id: invoice.id,
          p_provider_payment_id: `${MARKER}-after`,
          p_amount_minor: 1,
          p_captured_at: new Date().toISOString(),
          p_method: 'bank_transfer',
        },
      });
      check(
        again.json?.[0]?.outcome === 'not_payable',
        'a payment against a settled invoice is still refused',
        `outcome: ${again.json?.[0]?.outcome}`,
      );
      check(
        (await eventsFor(invoice.id)).length === settled,
        'and publishes no second invoice.paid',
      );

      // ── void, on a separate invoice ─────────────────────────────────────
      const spare = await insert('finance', 'invoices', draftInvoiceFor(second));
      const spareId = spare.json?.[0]?.id;
      const voided = await request('POST', 'finance', 'rpc/void_invoice', {
        body: { p_invoice_id: spareId, p_note: 'Voided: raised in error' },
      });
      check(
        voided.json?.[0]?.outcome === 'voided',
        'a draft invoice is still voidable',
        `outcome: ${voided.json?.[0]?.outcome}`,
      );

      const voidEvents = (await eventsFor(spareId)).filter((e) => e.type === 'invoice.voided');
      check(
        voidEvents.length === 1,
        'voiding publishes exactly one invoice.voided, from the RPC alone',
        `found ${voidEvents.length}`,
      );
      check(
        voidEvents[0]?.payload?.reason === 'Voided: raised in error' &&
          voidEvents[0]?.payload?.milestoneId === second.id,
        'and it carries the reason and the milestone it frees',
        JSON.stringify(voidEvents[0]?.payload ?? null),
      );

      // Voiding something already void is an answer, not a write — so it must
      // not publish a second withdrawal of the same invoice.
      await request('POST', 'finance', 'rpc/void_invoice', {
        body: { p_invoice_id: spareId, p_note: 'Voided: again' },
      });
      check(
        (await eventsFor(spareId)).filter((e) => e.type === 'invoice.voided').length === 1,
        'voiding it twice still publishes once',
      );
    }
  }

  // ── 7g. G-079 — the audit row is written by the statement it describes ────
  //
  // `recordAudit` opened its own client and inserted after the state change had
  // already committed. The doc comment defended the trade honestly — an audit
  // failure should not roll back the business change — but `audit.audit_log` is
  // append-only by trigger, so a row that was never written can never be
  // written later. A payment could commit with no history, permanently.
  //
  // How this would have failed before the fix, precisely: every call below goes
  // straight to the RPC over PostgREST with no application process in the loop.
  // Before G-079 the functions wrote no audit rows at all — every one came from
  // TypeScript — so each assertion here would find zero.
  //
  // The `before` assertions are the sharp ones. They are set up so the status
  // the lock sees differs from the one a caller would have read a moment
  // earlier, which is exactly the case the application path got wrong.
  {
    console.log('\n7g. G-079 — the audit row is written by the function, not after it');

    const auditFor = async (subjectId) => {
      const res = await select(
        'audit',
        `audit_log?subject_id=eq.${subjectId}&select=action,actor_type,actor_id,organization_id,before,after&order=created_at.asc`,
      );
      return Array.isArray(res.json) ? res.json : [];
    };

    // ── the plan, on a project of its own ─────────────────────────────────
    //
    // Through the RPC, which is the only thing that writes this row. The main
    // fixture's `replacePlan` helper inserts milestones directly and never
    // calls the function at all, so asserting against it would prove nothing —
    // and by this point that project carries live invoices, so a real call
    // would be refused as `billed` and correctly audit nothing.
    const planProject = await insert('projects', 'projects', {
      organization_id: created.organizationId,
      client_account_id: created.clientAccountId,
      name: `${MARKER} plan-audit project`,
      status: 'planning',
      currency: 'INR',
      budget_minor: BUDGET_MINOR,
    });
    created.planProjectId = planProject.json?.[0]?.id ?? null;

    if (!created.planProjectId) {
      bad(`7g could not create a project to replace a plan on: ${planProject.text}`);
    } else {
      const replaced = await request('POST', 'projects', 'rpc/replace_payment_plan', {
        body: {
          p_project_id: created.planProjectId,
          p_milestones: splitBudget(BUDGET_MINOR, [60, 40]).map((amountMinor, index) => ({
            name: `${MARKER} plan milestone ${index + 1}`,
            percent: [60, 40][index],
            amountMinor,
            dueOn: null,
          })),
        },
      });
      check(
        replaced.json?.[0]?.outcome === 'replaced',
        'a plan replacement lands, so there is a successful write to audit',
        `outcome: ${replaced.json?.[0]?.outcome} — ${replaced.text}`,
      );

      const planAudits = (await auditFor(created.planProjectId)).filter(
        (row) => row.action === 'project.payment_plan_configured',
      );
      check(
        planAudits.length === 1,
        'replacing a payment plan writes exactly one audit row, from the RPC alone',
        `found ${planAudits.length} — before G-079 the function wrote none`,
      );
      check(
        planAudits[0]?.before === null,
        'and records no before state rather than claiming there was nothing there',
        `before: ${JSON.stringify(planAudits[0]?.before ?? undefined)}`,
      );
      check(
        planAudits[0]?.after?.budgetMinor === BUDGET_MINOR,
        'and carries the budget the milestone amounts were resolved against',
        `budgetMinor: ${planAudits[0]?.after?.budgetMinor}, expected ${BUDGET_MINOR}`,
      );
      check(
        (planAudits[0]?.after?.items ?? []).length === 2,
        'and the plan it was given, whole',
        JSON.stringify(planAudits[0]?.after?.items ?? null),
      );
    }

    // ── the invoice path, on the main fixture ─────────────────────────────
    const plan = await replacePlan([60, 40]);
    const milestones = [...(plan.json ?? [])].sort((a, b) => a.position - b.position);
    const [first, second] = milestones;

    if (!first || !second) {
      bad('7g could not build a two-milestone plan');
    } else {
      const draft = await insert('finance', 'invoices', draftInvoiceFor(first));
      const invoice = draft.json?.[0];
      await insert('finance', 'invoice_items', {
        organization_id: created.organizationId,
        invoice_id: invoice.id,
        position: 0,
        description: `${MARKER} line`,
        quantity: 1,
        unit_price_minor: first.amount_minor,
        amount_minor: first.amount_minor,
        tax_rate_bp: 0,
      });

      // ── issue ───────────────────────────────────────────────────────────
      //
      // Moved to pending_approval first, so the status the lock reads is not
      // the 'draft' the row was created with. An audit that reported 'draft'
      // here would be reporting a state the transition did not come from.
      await request('PATCH', 'finance', `invoices?id=eq.${invoice.id}`, {
        body: { status: 'pending_approval' },
      });
      await request('POST', 'finance', 'rpc/issue_invoice', {
        body: { p_invoice_id: invoice.id },
      });

      let audits = await auditFor(invoice.id);
      const issued = audits.filter((row) => row.action === 'invoice.issued');
      check(
        issued.length === 1,
        'issuing an invoice writes exactly one invoice.issued audit row',
        `found ${issued.length} — before G-079 the function wrote none`,
      );
      check(
        issued[0]?.before?.status === 'pending_approval' &&
          issued[0]?.after?.status === 'issued',
        'and its before is the status the lock read, not the one the row started as',
        JSON.stringify({ before: issued[0]?.before, after: issued[0]?.after }),
      );
      check(
        issued[0]?.organization_id === created.organizationId,
        'and it is filed under the organization that owns the invoice',
        `organization_id: ${issued[0]?.organization_id}`,
      );
      check(
        issued[0]?.actor_type === 'system' && issued[0]?.actor_id === null,
        'and the service role is recorded as system rather than as a user with no id',
        `actor_type: ${issued[0]?.actor_type}, actor_id: ${issued[0]?.actor_id}`,
      );

      // ── a partial payment ───────────────────────────────────────────────
      const half = Math.floor(first.amount_minor / 2);
      await request('POST', 'finance', 'rpc/record_manual_payment', {
        body: {
          p_invoice_id: invoice.id,
          p_provider_payment_id: `${MARKER}-audit-part`,
          p_amount_minor: half,
          p_captured_at: new Date().toISOString(),
          p_method: 'upi',
        },
      });

      audits = await auditFor(invoice.id);
      const part = audits.filter((row) => row.action === 'payment.recorded');
      check(
        part.length === 1,
        'a payment writes exactly one payment.recorded audit row',
        `found ${part.length}`,
      );
      check(
        part[0]?.before?.paidMinor === 0 && part[0]?.after?.paidMinor === half,
        'and it records the total before and after, from inside the lock',
        JSON.stringify({ before: part[0]?.before, after: part[0]?.after }),
      );
      check(
        part[0]?.after?.method === 'upi' && part[0]?.after?.provider === 'manual',
        'and the method the caller gave survives into the history',
        JSON.stringify(part[0]?.after ?? null),
      );

      // ── a refusal writes nothing ────────────────────────────────────────
      const beforeRefusal = (await auditFor(invoice.id)).length;
      const over = await request('POST', 'finance', 'rpc/record_manual_payment', {
        body: {
          p_invoice_id: invoice.id,
          p_provider_payment_id: `${MARKER}-audit-over`,
          p_amount_minor: first.amount_minor,
          p_captured_at: new Date().toISOString(),
          p_method: 'cash',
        },
      });
      check(
        over.json?.[0]?.outcome === 'overpayment',
        'an overpayment is still refused',
        `outcome: ${over.json?.[0]?.outcome}`,
      );
      check(
        (await auditFor(invoice.id)).length === beforeRefusal,
        'and a refused payment writes no history at all',
      );

      // ── the balance, and the status the lock computed ───────────────────
      await request('POST', 'finance', 'rpc/record_manual_payment', {
        body: {
          p_invoice_id: invoice.id,
          p_provider_payment_id: `${MARKER}-audit-rest`,
          p_amount_minor: first.amount_minor - half,
          p_captured_at: new Date().toISOString(),
          p_method: 'bank_transfer',
        },
      });

      const settleAudit = (await auditFor(invoice.id)).filter(
        (row) => row.action === 'payment.recorded',
      );
      check(
        settleAudit.length === 2,
        'the balance is audited as its own row rather than replacing the first',
        `found ${settleAudit.length}`,
      );
      check(
        settleAudit[1]?.before?.paidMinor === half &&
          settleAudit[1]?.before?.status === 'partially_paid' &&
          settleAudit[1]?.after?.status === 'paid',
        'and it opens from where the first left off and closes as paid',
        JSON.stringify({ before: settleAudit[1]?.before, after: settleAudit[1]?.after }),
      );

      // ── void, on a separate invoice ─────────────────────────────────────
      const spare = await insert('finance', 'invoices', draftInvoiceFor(second));
      const spareId = spare.json?.[0]?.id;
      await request('POST', 'finance', 'rpc/void_invoice', {
        body: { p_invoice_id: spareId, p_note: 'Voided: audit check' },
      });

      const voidAudits = (await auditFor(spareId)).filter(
        (row) => row.action === 'invoice.voided',
      );
      check(
        voidAudits.length === 1,
        'voiding writes exactly one invoice.voided audit row',
        `found ${voidAudits.length}`,
      );
      check(
        voidAudits[0]?.after?.reason === 'Voided: audit check',
        'and the reason it records is the note the function stored',
        JSON.stringify(voidAudits[0]?.after ?? null),
      );

      // Voiding something already void is an answer, not a write — so it must
      // not write a second history entry for the same withdrawal.
      await request('POST', 'finance', 'rpc/void_invoice', {
        body: { p_invoice_id: spareId, p_note: 'Voided: again' },
      });
      check(
        (await auditFor(spareId)).filter((row) => row.action === 'invoice.voided').length === 1,
        'voiding it twice still audits once',
      );
    }
  }

  // ── 7h. G-078 — the invoice, its lines, its history and its event, or none ─
  //
  // The last event on the application path. generateInvoiceFromMilestone used
  // to write four things in four transactions: the invoice, its lines, the
  // audit row, the outbox row. A failure after the first left a bill that
  // occupied the milestone's one live slot with no lines under it — so the old
  // code hand-rolled a compensating DELETE, which is a rollback that runs only
  // if the process lives long enough to run it.
  //
  // What this proves, and how it would have failed before: every call goes
  // straight to the RPC over PostgREST with no application process in the loop.
  // The refusal case is the one that matters — a line the database refuses
  // takes the invoice with it, which no amount of application code can promise.
  {
    console.log('\n7h. G-078 — invoice, lines, history and event commit together');

    const plan = await replacePlan([70, 30]);
    const milestones = [...(plan.json ?? [])].sort((a, b) => a.position - b.position);
    const [target, spare] = milestones;

    // §7g's copy is scoped to its own block; this section runs independently of
    // it and must not depend on the order the two are written in.
    const auditFor = async (subjectId) => {
      const res = await select(
        'audit',
        `audit_log?subject_id=eq.${subjectId}&select=action,actor_type,organization_id,after&order=created_at.asc`,
      );
      return Array.isArray(res.json) ? res.json : [];
    };

    const lineFor = (m, quantity = 1) => [
      {
        position: 0,
        description: `${MARKER} milestone line`,
        quantity,
        unit_price_minor: m.amount_minor,
        amount_minor: m.amount_minor,
        tax_rate_bp: 0,
      },
    ];

    const createInvoice = (m, { number, lines }) =>
      request('POST', 'finance', 'rpc/create_milestone_invoice', {
        body: {
          p_organization_id: created.organizationId,
          p_client_account_id: created.clientAccountId,
          p_project_id: created.projectId,
          p_milestone_id: m.id,
          p_number: number,
          p_currency: 'INR',
          p_subtotal_minor: m.amount_minor,
          p_tax_minor: 0,
          p_total_minor: m.amount_minor,
          p_lines: lines,
        },
      });

    if (!target || !spare) {
      bad('7h could not build a two-milestone plan');
    } else {
      // ── the happy path writes all four ──────────────────────────────────
      const number = `${MARKER}-G078-1`;
      const ok = await createInvoice(target, { number, lines: lineFor(target) });
      const row = ok.json?.[0];

      check(row?.outcome === 'created', 'a milestone invoice is created', `outcome: ${row?.outcome}`);

      const invoiceId = row?.invoice_id;

      if (!invoiceId) {
        bad('7h got no invoice id back, so nothing below can be checked');
      } else {
        const items = await select(
          'finance',
          `invoice_items?invoice_id=eq.${invoiceId}&select=id,description`,
        );
        check((items.json ?? []).length === 1, 'its lines are there', `found ${(items.json ?? []).length}`);

        const audits = (await auditFor(invoiceId)).filter((r) => r.action === 'invoice.created');
        check(
          audits.length === 1,
          'and exactly one invoice.created audit row, written by the function',
          `found ${audits.length} — before G-078 the function wrote none`,
        );
        check(
          audits[0]?.after?.number === number,
          'carrying the number the invoice was given',
          JSON.stringify(audits[0]?.after ?? null),
        );

        const events = await select(
          'core',
          `outbox_events?subject_id=eq.${invoiceId}&type=eq.invoice.created&select=id,payload`,
        );
        check(
          (events.json ?? []).length === 1,
          'and exactly one invoice.created event, published by the same statement',
          `found ${(events.json ?? []).length}`,
        );
      }

      // ── the same milestone again is answered, not billed twice ──────────
      const again = await createInvoice(target, {
        number: `${MARKER}-G078-2`,
        lines: lineFor(target),
      });
      check(
        again.json?.[0]?.outcome === 'already_invoiced',
        'billing the same milestone again is answered rather than refused or duplicated',
        `outcome: ${again.json?.[0]?.outcome}`,
      );
      check(
        again.json?.[0]?.invoice_id === row?.invoice_id,
        'and it answers with the invoice that already exists',
      );

      // ── a number somebody else took is a retry, not a failure ───────────
      const taken = await createInvoice(spare, { number, lines: lineFor(spare) });
      check(
        taken.json?.[0]?.outcome === 'number_taken',
        'a number already used in this organization is reported for the caller to retry',
        `outcome: ${taken.json?.[0]?.outcome}`,
      );

      // ── THE ONE THAT MATTERS: a refused line takes the invoice with it ──
      //
      // quantity 0 violates invoice_items_quantity_check. On the old path the
      // invoice had already committed by the time this failed, and only the
      // hand-rolled DELETE removed it. Here the statement raises and the
      // invoice never existed.
      const doomedNumber = `${MARKER}-G078-doomed`;

      // Counted across the organization, not against the milestone. Audit rows
      // and events are filed under the *invoice* id, and the whole point is
      // that no invoice id exists — so a lookup by milestone would find
      // nothing whether or not the fix works, and pass for the wrong reason.
      const createdRowsInOrg = async () => {
        const [audits, events] = await Promise.all([
          select(
            'audit',
            `audit_log?organization_id=eq.${created.organizationId}&action=eq.invoice.created&select=id`,
          ),
          select(
            'core',
            `outbox_events?organization_id=eq.${created.organizationId}&type=eq.invoice.created&select=id`,
          ),
        ]);
        return {
          audits: (audits.json ?? []).length,
          events: (events.json ?? []).length,
        };
      };

      const before = await createdRowsInOrg();

      const doomed = await createInvoice(spare, {
        number: doomedNumber,
        lines: lineFor(spare, 0),
      });

      check(
        !doomed.ok,
        'a line the database refuses fails the whole call',
        `status: ${doomed.status}`,
      );

      const orphan = await select(
        'finance',
        `invoices?number=eq.${encodeURIComponent(doomedNumber)}&select=id`,
      );
      check(
        (orphan.json ?? []).length === 0,
        'and leaves no invoice behind — the compensating DELETE is not needed because nothing was written',
        `found ${(orphan.json ?? []).length}`,
      );

      // The milestone must still be billable. An orphan would have occupied
      // its one live slot and made it permanently unbillable.
      const stillFree = await select(
        'finance',
        `invoices?milestone_id=eq.${spare.id}&status=neq.void&select=id`,
      );
      check(
        (stillFree.json ?? []).length === 0,
        'and the milestone is still billable, its one live slot unoccupied',
        `found ${(stillFree.json ?? []).length}`,
      );

      const after = await createdRowsInOrg();
      check(
        after.audits === before.audits,
        'and wrote no history for an invoice that does not exist',
        `${before.audits} → ${after.audits}`,
      );
      check(
        after.events === before.events,
        'and announced nothing that did not happen',
        `${before.events} → ${after.events}`,
      );

      // ── an invoice with no lines is refused before anything is written ──
      const empty = await createInvoice(spare, { number: `${MARKER}-G078-empty`, lines: [] });
      check(
        empty.json?.[0]?.outcome === 'no_lines',
        'an invoice with no lines is refused rather than created empty',
        `outcome: ${empty.json?.[0]?.outcome}`,
      );
    }
  }

} catch (error) {
  bad(`unexpected failure: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  console.log('\n8. Cleanup');
  try {
    await cleanup();
    const left = await select(
      'projects',
      `projects?name=like.${encodeURIComponent(`${MARKER}%`)}&select=id`,
    );
    check((left.json ?? []).length === 0, 'test fixtures removed');
  } catch (error) {
    bad(`cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failures > 0) {
  console.error(`\n\x1b[31m✖ ${failures} check(s) failed\x1b[0m\n`);
  process.exit(1);
}
console.log('\n\x1b[32m✔ All checks passed\x1b[0m\n');
