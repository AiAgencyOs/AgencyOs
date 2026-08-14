#!/usr/bin/env node
/**
 * What a client can see, verified against a real database.
 *
 * Gap G-057. The portal renders whatever RLS returns, so the portal is only as
 * correct as these policies are — and the interesting cases are all negative.
 * Every one of them was probed before the pages were written rather than
 * assumed afterwards.
 *
 * What it proves:
 *
 *   1. A project marked `visibility = 'internal'` is invisible to the client,
 *      and so is everything under it. The child policies check the account but
 *      not the visibility flag; they inherit it through the `exists` subquery
 *      against projects, which is subtle enough to be worth a test rather than
 *      an argument.
 *   2. A draft deliverable is invisible. A client sees versions that were
 *      actually shown to them, never one being prepared.
 *   3. Another client account's work is invisible, which is the same tenancy
 *      rule one level in.
 *   4. A delivered handover is visible; one still being prepared is not.
 *   5. A client cannot write anything at all.
 *
 *   node scripts/verify-client-portal.mjs
 */

import { Buffer } from 'node:buffer';
import { createHmac, randomUUID } from 'node:crypto';

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

// This script needs a service key and the JWT secret: it drives the database directly and
// never calls the job runner, so CRON_SECRET is not required of it.
const target = await resolveTarget(fail, { cron: false, anon: false, jwt: true });
await announceTarget(target, 'verify-client-portal');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = 'zztest-g057';
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

async function call(token, method, schema, path, body) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: token,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept-Profile': schema,
      'Content-Profile': schema,
      Prefer: 'return=representation',
    },
    cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: parse(text), text };
}

const rest = (m, s, p, b) => call(KEY, m, s, p, b);
const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);

/**
 * A portal session. `client_admin` rather than anything else: core.is_client()
 * admits client_admin and client_member, and a token naming any other role is
 * simply not a client — the first version of this check used one and saw
 * nothing at all, which looked like a policy bug and was a claim bug.
 */
function mintClient(userId, clientAccountId) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({
    sub: userId,
    aud: 'authenticated',
    role: 'authenticated',
    app_metadata: {
      organization_id: ORG,
      role: 'client_admin',
      client_account_id: clientAccountId,
    },
    iat: now,
    exp: now + 900,
  });
  return `${header}.${body}.${createHmac('sha256', target.jwtSecret).update(`${header}.${body}`).digest('base64url')}`;
}

const created = { projects: [], accounts: [], users: [], invoices: [], payments: [] };

console.log('\n\x1b[1mAgencyOS — what a client can see (G-057)\x1b[0m');

try {
  const account = one(await rest('POST', 'core', 'client_accounts', { organization_id: ORG, name: `${MARKER} theirs` }));
  const other = one(await rest('POST', 'core', 'client_accounts', { organization_id: ORG, name: `${MARKER} somebody else` }));
  created.accounts.push(account.id, other.id);

  const project = async (accountId, visibility, name) => {
    const p = one(await rest('POST', 'projects', 'projects', {
      organization_id: ORG, client_account_id: accountId, name: `${MARKER} ${name}`,
      status: 'active', visibility,
    }));
    created.projects.push(p.id);
    await rest('POST', 'projects', 'modules', { organization_id: ORG, project_id: p.id, name: 'Backend' });
    const d = one(await rest('POST', 'projects', 'rpc/add_deliverable', {
      p_project_id: p.id, p_kind: 'design', p_title: 'Home screen',
    }));
    await rest('POST', 'projects', 'handovers', { organization_id: ORG, project_id: p.id });
    return { id: p.id, deliverable: d.deliverable_id };
  };

  const shared = await project(account.id, 'client', 'shared');
  const internal = await project(account.id, 'internal', 'internal');
  const someoneElse = await project(other.id, 'client', 'not yours');

  const authUser = await fetch(`${URL_BASE}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({
      email: `${MARKER}-${randomUUID().slice(0, 8)}@example.invalid`,
      password: randomUUID(), email_confirm: true,
    }),
  }).then((r) => r.json());
  created.users.push(authUser.id);
  const client = mintClient(authUser.id, account.id);

  const sees = async (schema, path) => {
    const r = await call(client, 'GET', schema, path);
    return Array.isArray(r.json) ? r.json : [];
  };

  console.log('\n1. Only what was shared, and only theirs');
  {
    const projects = await sees('projects', 'projects?select=id,name,visibility');
    check(projects.length === 1, 'exactly one project is visible', `${projects.length}`);
    check(projects[0]?.id === shared.id, 'and it is the one marked client-visible', `${projects[0]?.name}`);
    check(
      !projects.some((p) => p.id === internal.id),
      'a project marked internal is invisible, whatever its client account',
    );
    check(
      !projects.some((p) => p.id === someoneElse.id),
      'and another client account’s project is invisible too',
    );
  }

  console.log('\n2. And everything underneath inherits that');
  {
    const modules = await sees('projects', 'modules?select=project_id');
    check(
      modules.length === 1 && modules[0]?.project_id === shared.id,
      'modules of the internal project are hidden by the same rule',
      `${modules.length} module(s)`,
    );

    const handovers = await sees('projects', 'handovers?select=project_id,status');
    check(handovers.length === 0, 'a handover still being prepared is not shown', `${handovers.length}`);

    await rest('PATCH', 'projects', `handovers?project_id=eq.${shared.id}`, { status: 'delivered' });
    const delivered = await sees('projects', 'handovers?select=project_id,status');
    check(
      delivered.length === 1 && delivered[0]?.project_id === shared.id,
      'and one that was delivered is',
      `${delivered.length}`,
    );
  }

  console.log('\n3. Drafts are internal until they are shown');
  {
    const drafts = await sees('projects', 'deliverables?select=id,status');
    check(drafts.length === 0, 'a draft version is invisible', `${drafts.length} visible`);

    await rest('PATCH', 'projects', `deliverables?id=eq.${shared.deliverable}`, { status: 'in_review' });
    const shown = await sees('projects', 'deliverables?select=id,status');
    check(
      shown.length === 1 && shown[0]?.id === shared.deliverable,
      'one put in front of them is visible',
      `${shown.length} visible`,
    );
  }

  console.log('\n4. A client reads, and writes nothing');
  {
    const write = await call(client, 'POST', 'projects', 'modules', {
      organization_id: ORG, project_id: shared.id, name: 'Injected',
    });
    check(write.status >= 400, 'a client cannot create a module', `status ${write.status}`);

    const patch = await call(client, 'PATCH', 'projects', `deliverables?id=eq.${shared.deliverable}`, {
      status: 'approved',
    });
    check(
      patch.status >= 400 || (Array.isArray(patch.json) && patch.json.length === 0),
      'and cannot approve their own deliverable — ADM-08d puts that in a staff member’s hands',
      `status ${patch.status}, ${patch.text.slice(0, 80)}`,
    );

    const defects = await sees('qa', 'defects?select=id');
    check(defects.length === 0, 'a client is told what was fixed, not what is broken', `${defects.length}`);
  }

  // ── 5. the money surface ─────────────────────────────────────────────────
  //
  // Added after the pre-production security audit noticed an asymmetry: a
  // client can reach `finance.invoices` and `finance.payments` through RLS,
  // and while the *project* surface had been probed negatively since G-057,
  // the *money* surface never had. The policy read correctly, but reading a
  // policy is how you convince yourself, not how you find out.
  //
  // This is the highest-sensitivity thing a client can see, and two of the
  // three negatives here are conditions the policy states explicitly rather
  // than inherits — so a rewrite that dropped one would be silent.
  console.log('\n5. Money: their own, issued, and nothing else');
  {
    const invoice = async (accountId, status, name, extra = {}) =>
      one(await rest('POST', 'finance', 'invoices', {
        organization_id: ORG,
        client_account_id: accountId,
        number: `${MARKER}-${name}`,
        status,
        total_minor: 100000,
        ...(status === 'draft' || status === 'pending_approval' || status === 'void'
          ? {}
          : { issued_at: new Date().toISOString() }),
        ...extra,
      }));

    const issued = await invoice(account.id, 'issued', 'issued');
    const draft = await invoice(account.id, 'draft', 'draft');
    const pending = await invoice(account.id, 'pending_approval', 'pending');
    const theirs = await invoice(other.id, 'issued', 'someone-else');
    created.invoices.push(issued.id, draft.id, pending.id, theirs.id);

    const visible = await sees('finance', 'invoices?select=id,number,status');
    const ids = new Set(visible.map((i) => i.id));

    check(ids.has(issued.id), 'a client sees their own issued invoice', `${visible.length} visible`);
    check(
      !ids.has(draft.id),
      'a draft invoice is invisible — a figure being prepared is not a figure they owe',
    );
    check(
      !ids.has(pending.id),
      'and one still pending approval is invisible, which the policy states separately from draft',
    );
    check(
      !ids.has(theirs.id),
      'another client account’s invoice is invisible — the tenancy rule, on the money',
    );
    check(visible.length === 1, 'and nothing else came back', `${visible.length} visible`);

    // Payments reach the client through an EXISTS against the invoice rather
    // than a column of their own, so isolation here is inherited. Inherited
    // isolation is exactly the kind that survives a rewrite of the wrong half.
    const pay = async (invoiceId, name) =>
      one(await rest('POST', 'finance', 'payments', {
        organization_id: ORG, invoice_id: invoiceId, amount_minor: 5000,
        provider: 'manual', provider_payment_id: `${MARKER}-${name}`, status: 'captured',
      }));

    const minePaid = await pay(issued.id, 'mine');
    const theirsPaid = await pay(theirs.id, 'theirs');
    created.payments.push(minePaid.id, theirsPaid.id);

    const payments = await sees('finance', 'payments?select=id,invoice_id');
    const payIds = new Set(payments.map((x) => x.id));
    check(payIds.has(minePaid.id), 'a client sees a payment against their own invoice', `${payments.length}`);
    check(
      !payIds.has(theirsPaid.id),
      'and never one against another client’s invoice, which it inherits through the invoice',
    );

    const forge = await call(client, 'POST', 'finance', 'invoices', {
      organization_id: ORG, client_account_id: account.id, number: `${MARKER}-forged`,
      status: 'issued', total_minor: 1, issued_at: new Date().toISOString(),
    });
    check(forge.status >= 400, 'a client cannot write an invoice', `status ${forge.status}`);

    const markPaid = await call(client, 'PATCH', 'finance', `invoices?id=eq.${issued.id}`, {
      status: 'paid', paid_at: new Date().toISOString(),
    });
    check(
      markPaid.status >= 400 || (Array.isArray(markPaid.json) && markPaid.json.length === 0),
      'and cannot mark their own invoice paid',
      `status ${markPaid.status}`,
    );
  }
} finally {
  for (const p of created.projects) {
    await rest('DELETE', 'projects', `handovers?project_id=eq.${p}`);
    await rest('DELETE', 'projects', `deliverables?project_id=eq.${p}`);
    await rest('DELETE', 'projects', `modules?project_id=eq.${p}`);
    await rest('DELETE', 'projects', `projects?id=eq.${p}`);
  }
  for (const x of created.payments) await rest('DELETE', 'finance', `payments?id=eq.${x}`);
  for (const x of created.invoices) await rest('DELETE', 'finance', `invoices?id=eq.${x}`);
  for (const a of created.accounts) await rest('DELETE', 'core', `client_accounts?id=eq.${a}`);
  for (const u of created.users) {
    await fetch(`${URL_BASE}/auth/v1/admin/users/${u}`, {
      method: 'DELETE', headers: { apikey: KEY, Authorization: `Bearer ${KEY}` }, cache: 'no-store',
    });
  }
}

console.log(`\n${checks} checks`);

if (failures === 0) {
  console.log('\x1b[32m✔ A client sees their own shared work, and nothing else\x1b[0m\n');
  process.exit(0);
}

console.error(`\x1b[31m✖ ${failures} failure(s)\x1b[0m\n`);
process.exit(1);
