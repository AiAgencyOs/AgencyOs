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

import { announceTarget, resolveTarget } from './verify-target.mjs';

/** Everything this run creates carries this, so cleanup can find it. */
const MARKER = 'ZZTEST milestone-invoicing';

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

const target = resolveTarget(fail, { cron: false, anon: true });
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

const created = { projectId: null, organizationId: null, clientAccountId: null };
let invoiceSequence = 0;
const invoiceNumber = () => `${MARKER}-${Date.now()}-${(invoiceSequence += 1)}`;

async function cleanup() {
  if (!created.projectId) return;

  const invoices = await select('finance', `invoices?project_id=eq.${created.projectId}&select=id`);
  for (const invoice of invoices.json ?? []) {
    // payments → invoices is ON DELETE RESTRICT, so receipts go first.
    await remove('finance', `payments?invoice_id=eq.${invoice.id}`);
  }
  await remove('finance', `invoices?project_id=eq.${created.projectId}`);
  await remove('core', `outbox_events?subject_type=eq.invoice&payload->>marker=eq.${MARKER}`);
  await remove('projects', `milestones?project_id=eq.${created.projectId}`);
  await remove('projects', `projects?id=eq.${created.projectId}`);
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
      (await select('finance', `invoices?id=eq.${id}&select=id,total_minor,paid_minor,status`)).json?.[0];

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
    check(
      (reconciledRow.paid_minor === reconciledRow.total_minor) ===
        (reconciledRow.status === 'paid'),
      'K. and its status agrees with its own total',
      `status ${reconciledRow.status}, ${reconciledRow.paid_minor} of ${reconciledRow.total_minor}`,
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
