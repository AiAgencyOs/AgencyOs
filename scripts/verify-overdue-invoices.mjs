#!/usr/bin/env node
/**
 * Invoices going overdue, verified against a real database.
 *
 * Gap G-004. `overdue` has been in the status vocabulary and in
 * INVOICE_TRANSITIONS since the schema was written; nothing ever performed the
 * transition, so a due date passed and the invoice went on calling itself
 * issued. This is that rule executed for the first time, and the checks are
 * mostly about what it must NOT touch.
 *
 *   1. An issued invoice past its date goes overdue; a partially paid one too.
 *   2. One not yet due does not move.
 *   3. A draft does not move — an invoice nobody has seen cannot be late.
 *   4. Paid and void do not move; they are terminal.
 *   5. An invoice with no due date does not move.
 *   6. It is idempotent: a second sweep re-marks nothing and audits nothing.
 *   7. Every transition is audited.
 *
 *   node scripts/verify-overdue-invoices.mjs
 */

import { announceTarget, resolveTarget } from './verify-target.mjs';

/**
 * Refuses an environment it cannot run against, with a message rather than a
 * crash. `resolveTarget` takes the caller's own exit function — the first
 * version of this script passed none, so an incomplete .env.verify.local
 * produced "fail is not a function" instead of the sentence explaining what
 * was missing. The error path nobody had executed.
 */
function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

// This script needs a service key: it drives the database directly and
// never calls the job runner, so CRON_SECRET is not required of it.
const target = await resolveTarget(fail, { cron: false, anon: false });
await announceTarget(target, 'verify-overdue-invoices');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = 'zztest-g004';
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
  return { status: res.status, json: parse(text), text };
}

const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);
const sweep = () => rest('POST', 'finance', 'rpc/mark_overdue_invoices', { p_limit: 200 });
const statusOf = async (id) =>
  one(await rest('GET', 'finance', `invoices?id=eq.${id}&select=status`))?.status;

const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

const created = { invoices: [] };

console.log('\n\x1b[1mAgencyOS — invoices going overdue (G-004)\x1b[0m');

try {
  const account = one(await rest('POST', 'core', 'client_accounts', { organization_id: ORG, name: `${MARKER} client` }));
  created.account = account?.id;

  let n = 0;
  const invoice = async (status, dueAt, extra = {}) => {
    n += 1;
    const row = one(await rest('POST', 'finance', 'invoices', {
      organization_id: ORG, client_account_id: created.account,
      number: `${MARKER}-${n}`, status, total_minor: 100000, paid_minor: 0,
      ...(dueAt ? { due_at: dueAt } : {}),
      ...(status === 'draft' || status === 'pending_approval' || status === 'void'
        ? {}
        : { issued_at: yesterday }),
      ...extra,
    }));
    if (!row?.id) throw new Error(`fixture ${status} failed: ${JSON.stringify(row)?.slice(0, 160)}`);
    created.invoices.push(row.id);
    return row.id;
  };

  const late = await invoice('issued', yesterday);
  const partly = await invoice('partially_paid', yesterday, { paid_minor: 40000 });
  const notYet = await invoice('issued', tomorrow);
  const draft = await invoice('draft', yesterday);
  const paid = await invoice('paid', yesterday, { paid_minor: 100000, paid_at: yesterday });
  const voided = await invoice('void', yesterday);
  const noDate = await invoice('issued', null);

  console.log('\n1. What goes overdue');
  {
    const swept = await sweep();
    const ids = (swept.json ?? []).map((r) => r.invoice_id);

    check(ids.includes(late), 'an issued invoice past its date', `${ids.length} marked`);
    check(ids.includes(partly), 'and a partially paid one');
    check(await statusOf(late) === 'overdue', 'the row says overdue', `${await statusOf(late)}`);
  }

  console.log('\n2. What does not');
  {
    check(await statusOf(notYet) === 'issued', 'an invoice not yet due stays issued');
    check(await statusOf(draft) === 'draft', 'a draft stays a draft — nobody has seen it');
    check(await statusOf(paid) === 'paid', 'paid is terminal');
    check(await statusOf(voided) === 'void', 'and so is void');
    check(await statusOf(noDate) === 'issued', 'an invoice with no due date is never late');
  }

  console.log('\n3. Running it twice changes nothing');
  {
    const again = await sweep();
    check((again.json ?? []).length === 0, 'the second sweep marks nothing', `${(again.json ?? []).length}`);

    const audits = await rest('GET', 'audit',
      `audit_log?organization_id=eq.${ORG}&action=eq.invoice.overdue&select=subject_id`);
    const forLate = (audits.json ?? []).filter((a) => a.subject_id === late);
    check(forLate.length === 1, 'and the invoice was audited exactly once', `${forLate.length} rows`);
  }

  console.log('\n4. A payment still wins');
  {
    // The overdue invoice is paid off. Nothing here reverses it, and the
    // payment path owns the move to paid — but the sweep must not fight it.
    await rest('PATCH', 'finance', `invoices?id=eq.${late}`, {
      status: 'paid', paid_minor: 100000, paid_at: new Date().toISOString(),
    });
    await sweep();
    check(await statusOf(late) === 'paid', 'an invoice paid after going overdue stays paid');
  }
} finally {
  await rest('DELETE', 'audit', `audit_log?organization_id=eq.${ORG}&action=eq.invoice.overdue`);
  for (const id of created.invoices) await rest('DELETE', 'finance', `invoices?id=eq.${id}`);
  if (created.account) await rest('DELETE', 'core', `client_accounts?id=eq.${created.account}`);
}

console.log(`\n${checks} checks`);

if (failures === 0) {
  console.log('\x1b[32m✔ A late invoice says so, and nothing else moves\x1b[0m\n');
  process.exit(0);
}

console.error(`\x1b[31m✖ ${failures} failure(s)\x1b[0m\n`);
process.exit(1);
