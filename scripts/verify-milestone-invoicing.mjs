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
