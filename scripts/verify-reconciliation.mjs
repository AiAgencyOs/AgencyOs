/**
 * Reconciliation says what it found — Document 15 §15 and §29.
 *
 * The rule this exists to hold is one sentence of §15: *"Reconciliation must
 * not silently alter historical transactions."* Everything below is either
 * that rule, or the workflow §29 puts around it.
 *
 * What is proved:
 *   1. A period is a period, and one account has one open period at a time.
 *   2. The statement line is preserved, verbatim and unchangeable.
 *   3. Every finding that is not a clean match says why.
 *   4. Auto-matching is arithmetic, and it PROPOSES rather than applies.
 *   5. A period cannot close over an exception nobody explained.
 *   6. And nothing here can alter a payment, because nothing here has a way to.
 *
 *   node scripts/verify-reconciliation.mjs
 */

import { randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false });
await announceTarget(target, 'verify-reconciliation');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = 'zztest-recon';
const ORG = '00000000-0000-4000-8000-000000000001';

let failures = 0;
let checks = 0;

function check(condition, description, detail = '') {
  checks += 1;
  if (condition) return void console.log(`  \x1b[32m✓\x1b[0m ${description}`);
  failures += 1;
  console.error(`  \x1b[31m✗\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
}

function parse(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function rest(method, schema, path, body) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json',
      'Accept-Profile': schema, 'Content-Profile': schema, Prefer: 'return=representation',
    },
    cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, json: parse(text), text };
}

const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);

console.log('\n\x1b[1mAgencyOS — reconciliation (Doc 15 §15, §29)\x1b[0m');

const created = { recons: [], invoices: [], projects: [], clients: [], users: [] };

try {
  // ── the fixture: a client, a project, an invoice, a verified payment ────
  const client = one(await rest('POST', 'core', 'client_accounts', {
    organization_id: ORG, name: `${MARKER} client`,
  }));
  created.clients.push(client.id);

  const project = one(await rest('POST', 'projects', 'projects', {
    organization_id: ORG, client_account_id: client.id,
    name: `${MARKER} ${randomUUID().slice(0, 8)}`, status: 'active',
  }));
  created.projects.push(project.id);

  const invoice = one(await rest('POST', 'finance', 'invoices', {
    organization_id: ORG, project_id: project.id, client_account_id: client.id,
    number: `${MARKER}-${randomUUID().slice(0, 8)}`, status: 'issued',
    currency: 'INR', subtotal_minor: 4500000, total_minor: 4500000,
    issued_at: '2026-08-01T00:00:00Z', due_at: '2026-08-15T00:00:00Z',
  }));
  created.invoices.push(invoice.id);

  // `payments_verified_together`: a verified payment names who verified it.
  // Its own user rather than whichever row happens to be in `core.users` —
  // on a fresh database there is none, and this fixture read `undefined` and
  // failed six checks for a reason that had nothing to do with reconciling.
  const authUser = await fetch(`${URL_BASE}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({
      email: `${MARKER}-${randomUUID().slice(0, 8)}@example.invalid`,
      password: randomUUID(),
      email_confirm: true,
    }),
  }).then((r) => r.json());
  created.users.push(authUser.id);
  await rest('POST', 'core', 'users', { id: authUser.id, email: authUser.email });
  const owner = { id: authUser.id };
  check(Boolean(owner.id), 'a person exists to have verified the payment', owner.id ? '' : JSON.stringify(authUser).slice(0, 160));

  const payment = one(await rest('POST', 'finance', 'payments', {
    organization_id: ORG, invoice_id: invoice.id, provider: 'manual',
    provider_payment_id: `${MARKER}-${randomUUID().slice(0, 8)}`,
    amount_minor: 4500000, currency: 'INR', status: 'captured',
    captured_at: '2026-08-10T09:00:00Z',
    verified_at: '2026-08-10T10:00:00Z', verified_by: owner?.id ?? null,
  }));
  check(Boolean(invoice?.id), 'an issued invoice exists', invoice?.id ? '' : JSON.stringify(invoice).slice(0, 200));
  check(Boolean(payment?.id), 'and a verified payment to reconcile against', payment?.id ? '' : JSON.stringify(payment).slice(0, 200));

  // ── 1. a period is a period ─────────────────────────────────────────────
  console.log('\n1. A period, an account and one open reconciliation');

  const backwards = await rest('POST', 'finance', 'reconciliations', {
    organization_id: ORG, period_start: '2026-08-31', period_end: '2026-08-01',
    source: `${MARKER} HDFC current account statement`,
  });
  check(!backwards.ok, 'a period that ends before it starts is not a period', backwards.ok ? 'IT WAS ACCEPTED' : `${backwards.status}`);

  const recon = one(await rest('POST', 'finance', 'reconciliations', {
    organization_id: ORG, period_start: '2026-08-01', period_end: '2026-09-01',
    source: `${MARKER} HDFC current account statement`,
  }));
  check(Boolean(recon?.id), 'a period opens with its source recorded — §15', recon?.id ? '' : JSON.stringify(recon).slice(0, 160));
  if (recon?.id) created.recons.push(recon.id);

  const second = await rest('POST', 'finance', 'reconciliations', {
    organization_id: ORG, period_start: '2026-09-01', period_end: '2026-10-01',
    source: `${MARKER} HDFC current account statement`,
  });
  check(!second.ok, 'and one account has one open period at a time', second.ok ? 'IT WAS ACCEPTED' : `${second.status}`);

  const halfClosed = await rest('PATCH', 'finance', `reconciliations?id=eq.${recon.id}`, {
    status: 'closed',
  });
  check(!halfClosed.ok, 'a period cannot close without saying who closed it — §15', halfClosed.ok ? 'IT WAS ACCEPTED' : `${halfClosed.status}`);

  // ── 2. the evidence is preserved ────────────────────────────────────────
  console.log('\n2. The statement line is what the bank said');

  const matched = one(await rest('POST', 'finance', 'reconciliation_items', {
    organization_id: ORG, reconciliation_id: recon.id,
    statement_line: '10/08/2026  NEFT CR  ACME RETAIL PVT LTD  45,000.00',
    statement_date: '2026-08-10', amount_minor: 4500000, reference: 'NEFT-8891',
    finding: 'matched', payment_id: payment.id,
  }));
  check(Boolean(matched?.id), 'a matched line names the payment it matched', matched?.id ? '' : JSON.stringify(matched).slice(0, 160));

  const rewritten = await rest('PATCH', 'finance', `reconciliation_items?id=eq.${matched.id}`, {
    statement_line: '10/08/2026  NEFT CR  ACME  45000',
  });
  check(
    !rewritten.ok && /preserves it/.test(JSON.stringify(rewritten.json)),
    'and it cannot be tidied afterwards — §29 preserves the evidence',
    rewritten.ok ? 'IT WAS ACCEPTED' : `${rewritten.status}`,
  );

  const unbacked = await rest('POST', 'finance', 'reconciliation_items', {
    organization_id: ORG, reconciliation_id: recon.id,
    statement_line: '11/08/2026  NEFT CR  SOMEBODY  10,000.00',
    statement_date: '2026-08-11', amount_minor: 1000000, finding: 'matched',
  });
  check(!unbacked.ok, 'a match with no payment behind it is not a match', unbacked.ok ? 'IT WAS ACCEPTED' : `${unbacked.status}`);

  // ── 3. an exception says why ────────────────────────────────────────────
  console.log('\n3. Every finding that is not a clean match says why — §15');

  // Enterable before anybody knows why, which is §29's exception QUEUE: you
  // enter the statement, see what did not match, and then work through it.
  // Requiring the reason here would mean knowing the answer at the moment the
  // line is typed — and would make the close rule unfireable, which is what
  // the first version of this did.
  const explained = one(await rest('POST', 'finance', 'reconciliation_items', {
    organization_id: ORG, reconciliation_id: recon.id,
    statement_line: '12/08/2026  UPI CR  UNKNOWN  7,500.00',
    statement_date: '2026-08-12', amount_minor: 750000, finding: 'unmatched',
  }));
  check(Boolean(explained?.id), 'an exception can be queued before anybody knows why — §29', explained?.id ? '' : JSON.stringify(explained).slice(0, 200));

  const whitespace = await rest('PATCH', 'finance', `reconciliation_items?id=eq.${explained.id}`, {
    reason: '   ',
  });
  check(!whitespace.ok, 'and a reason is a sentence, not whitespace', whitespace.ok ? 'IT WAS ACCEPTED' : `${whitespace.status}`);

  const madeUp = await rest('POST', 'finance', 'reconciliation_items', {
    organization_id: ORG, reconciliation_id: recon.id,
    statement_line: '13/08/2026  ODD  1,000.00', statement_date: '2026-08-13',
    amount_minor: 100000, finding: 'looks_fine', reason: 'seems ok',
  });
  check(!madeUp.ok, 'a sixth finding is not one of §15\'s five', madeUp.ok ? 'IT WAS ACCEPTED' : `${madeUp.status}`);

  // ── 4. auto-match proposes, and does not apply ──────────────────────────
  console.log('\n4. Auto-matching is arithmetic, and it proposes — §29');

  const candidate = one(await rest('POST', 'finance', 'reconciliation_items', {
    organization_id: ORG, reconciliation_id: recon.id,
    statement_line: '14/08/2026  NEFT CR  ANOTHER  45,000.00',
    statement_date: '2026-08-14', amount_minor: 4500000, finding: 'unmatched',
    reason: 'Same amount as an earlier credit; checking whether it is a duplicate.',
  }));

  check(Boolean(candidate?.id), 'a second line with the same amount is entered', candidate?.id ? '' : JSON.stringify(candidate).slice(0, 200));

  const proposal = one(await rest('POST', 'finance', 'rpc/propose_match', { p_item_id: candidate?.id ?? null }));
  check(
    proposal?.outcome === 'no_candidate',
    'a payment another line already claims is not offered twice',
    proposal?.outcome ?? 'no outcome',
  );

  const stillUnmatched = one(
    await rest('GET', 'finance', `reconciliation_items?id=eq.${candidate.id}&select=finding,payment_id`),
  );
  check(
    stillUnmatched?.finding === 'unmatched' && stillUnmatched?.payment_id === null,
    'and proposing changed nothing — §15, reconciliation alters nothing',
    `${stillUnmatched?.finding}, payment ${stillUnmatched?.payment_id}`,
  );

  // And the half that says the function works at all. Proving only that it
  // declines is proving nothing: a function that always answered
  // `no_candidate` would pass every check above.
  const secondPayment = one(await rest('POST', 'finance', 'payments', {
    organization_id: ORG, invoice_id: invoice.id, provider: 'manual',
    provider_payment_id: `${MARKER}-${randomUUID().slice(0, 8)}`,
    amount_minor: 1250000, currency: 'INR', status: 'captured',
    captured_at: '2026-08-18T09:00:00Z',
    verified_at: '2026-08-18T10:00:00Z', verified_by: owner?.id ?? null,
  }));
  const findable = one(await rest('POST', 'finance', 'reconciliation_items', {
    organization_id: ORG, reconciliation_id: recon.id,
    statement_line: '18/08/2026  NEFT CR  ACME RETAIL PVT LTD  12,500.00',
    statement_date: '2026-08-18', amount_minor: 1250000, finding: 'unmatched',
  }));
  const found = one(await rest('POST', 'finance', 'rpc/propose_match', { p_item_id: findable.id }));
  check(
    found?.outcome === 'matched' && found?.payment_id === secondPayment.id,
    'exactly one unclaimed payment in the period IS offered — §29',
    `${found?.outcome}`,
  );

  const untouched = one(
    await rest('GET', 'finance', `reconciliation_items?id=eq.${findable.id}&select=finding,payment_id`),
  );
  check(
    untouched?.finding === 'unmatched' && untouched?.payment_id === null,
    'and offering it still wrote nothing',
    `${untouched?.finding}`,
  );

  await rest('PATCH', 'finance', `reconciliation_items?id=eq.${findable.id}`, {
    finding: 'matched', payment_id: secondPayment.id,
  });

  // ── 5. a period closes when nothing is unexplained ──────────────────────
  console.log('\n5. A queue nobody worked does not get to say closed — §29');

  await rest('PATCH', 'finance', `reconciliation_items?id=eq.${explained.id}`, { reason: null });
  const overOpen = await rest('PATCH', 'finance', `reconciliations?id=eq.${recon.id}`, {
    status: 'closed', closed_by: owner?.id ?? null, closed_at: new Date().toISOString(),
  });
  check(
    !overOpen.ok && /nobody has explained/.test(JSON.stringify(overOpen.json)),
    'a period with an unexplained item cannot close',
    overOpen.ok ? 'IT WAS ACCEPTED' : `${overOpen.status}`,
  );

  await rest('PATCH', 'finance', `reconciliation_items?id=eq.${explained.id}`, {
    reason: 'Identified as a client prepayment; invoice raised on 2026-08-20.',
  });
  const closed = await rest('PATCH', 'finance', `reconciliations?id=eq.${recon.id}`, {
    status: 'closed', closed_by: owner?.id ?? null, closed_at: new Date().toISOString(),
  });
  check(closed.ok, 'and closes once every exception has been answered', closed.ok ? '' : `${closed.status}`);

  // ── 6. and the money is untouched ───────────────────────────────────────
  console.log('\n6. Nothing here altered a payment — §15');

  const after = one(
    await rest('GET', 'finance', `payments?id=eq.${payment.id}&select=amount_minor,status,verified_at`),
  );
  check(
    after?.amount_minor === 4500000 && after?.status === 'captured' && after?.verified_at !== null,
    'the payment is exactly as it was before any of this',
    `${after?.amount_minor}, ${after?.status}`,
  );

  const invoiceAfter = one(
    await rest('GET', 'finance', `invoices?id=eq.${invoice.id}&select=status,total_minor`),
  );
  check(
    invoiceAfter?.status === 'issued' && invoiceAfter?.total_minor === 4500000,
    'and so is the invoice — a reconciliation is a reading, not a correction',
    `${invoiceAfter?.status}`,
  );
} finally {
  // By marker as well as by id: a run that fails before it records an id
  // still leaves the row, and the open-period index makes the NEXT run fail
  // for a reason that has nothing to do with what it is testing.
  await rest('DELETE', 'finance', `reconciliations?source=like.*${MARKER}*`);
  for (const id of created.recons) await rest('DELETE', 'finance', `reconciliations?id=eq.${id}`);
  for (const id of created.invoices) {
    await rest('DELETE', 'finance', `payments?invoice_id=eq.${id}`);
    await rest('DELETE', 'finance', `invoices?id=eq.${id}`);
  }
  for (const id of created.projects) await rest('DELETE', 'projects', `projects?id=eq.${id}`);
  for (const id of created.clients) await rest('DELETE', 'core', `client_accounts?id=eq.${id}`);
  for (const id of created.users) {
    await rest('DELETE', 'core', `users?id=eq.${id}`);
    await fetch(`${URL_BASE}/auth/v1/admin/users/${id}`, {
      method: 'DELETE',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
      cache: 'no-store',
    }).catch(() => {});
  }
}

console.log(`\n  ${checks} checks`);
if (failures === 0) {
  console.log('\n\x1b[32m✔ Reconciliation says what it found, and alters nothing\x1b[0m\n');
  process.exit(0);
}
console.error(`\n\x1b[31m✖ ${failures} failure(s)\x1b[0m\n`);
process.exit(1);
