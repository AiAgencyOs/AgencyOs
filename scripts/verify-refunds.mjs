#!/usr/bin/env node
/**
 * Refunds, verified against a real database.
 *
 * Gap G-005. `refund.issue` has been owner-only in the capability matrix since
 * the first day and nothing ever used it, so money going back left no trace.
 *
 * Three rules are checked, and none was invented for this feature:
 *
 *   A refund needs an approval (directive §28 RED, §29 the Admin's decision),
 *   and the engine's money floor already refuses any refund policy naming
 *   anybody below owner.
 *
 *   It cannot exceed what came in — D1's rule in the other direction,
 *   computed under the invoice's lock and refused rather than clamped.
 *
 *   The invoice does not move. finance/schema.ts has said since the first day
 *   that paid is terminal and money returned is a refund, not a status flip.
 *
 *   node scripts/verify-refunds.mjs
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
await announceTarget(target, 'verify-refunds');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = 'zztest-g005';
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
      apikey: token, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      'Accept-Profile': schema, 'Content-Profile': schema, Prefer: 'return=representation',
    },
    cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: parse(text), text };
}

const rest = (m, s, p, b) => call(KEY, m, s, p, b);
const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);

function mint(userId, role) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const b = b64({
    sub: userId, aud: 'authenticated', role: 'authenticated',
    app_metadata: { organization_id: ORG, role }, iat: now, exp: now + 900,
  });
  return `${h}.${b}.${createHmac('sha256', target.jwtSecret).update(`${h}.${b}`).digest('base64url')}`;
}

const request = (invoiceId, amount, reason = 'client cancelled') =>
  rest('POST', 'finance', 'rpc/request_refund', {
    p_invoice_id: invoiceId, p_amount_minor: amount, p_reason: reason,
  });

const created = { users: [] };

console.log('\n\x1b[1mAgencyOS — refunds (G-005)\x1b[0m');

try {
  const account = one(await rest('POST', 'core', 'client_accounts', { organization_id: ORG, name: `${MARKER} client` }));
  created.account = account?.id;

  const invoice = one(await rest('POST', 'finance', 'invoices', {
    organization_id: ORG, client_account_id: created.account, number: `${MARKER}-1`,
    status: 'paid', total_minor: 100000, paid_minor: 100000,
    issued_at: new Date().toISOString(), paid_at: new Date().toISOString(),
  }));
  created.invoice = invoice?.id;
  if (!created.invoice) throw new Error('could not create the invoice fixture');

  await rest('POST', 'finance', 'payments', {
    organization_id: ORG, invoice_id: created.invoice, provider: 'manual',
    provider_payment_id: `${MARKER}-pay`, amount_minor: 100000, status: 'captured',
    captured_at: new Date().toISOString(),
  });

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
  await rest('POST', 'core', 'users', { id: authUser.id, email: authUser.email });
  await rest('POST', 'core', 'memberships', {
    organization_id: ORG, user_id: authUser.id, role: 'owner', status: 'active',
  });
  const owner = mint(authUser.id, 'owner');

  console.log('\n1. The money floor is not negotiable');
  {
    const low = await call(owner, 'POST', 'approvals', 'approval_policies', {
      organization_id: ORG, subject_type: 'refund', min_amount_minor: 0,
      required_role: 'ops_admin', sla_hours: 24,
    });
    check(
      low.status >= 400 && low.text.includes('money_floor'),
      'a refund policy below owner is refused, even to an owner',
      `status ${low.status}, ${low.text.slice(0, 90)}`,
    );

    const noPolicy = one(await request(created.invoice, 10000));
    check(
      noPolicy?.outcome === 'no_policy',
      'and with no policy at all, a refund cannot even be asked for',
      `outcome ${noPolicy?.outcome}`,
    );

    await call(owner, 'POST', 'approvals', 'approval_policies', {
      organization_id: ORG, subject_type: 'refund', min_amount_minor: 0,
      required_role: 'owner', sla_hours: 24,
    });
  }

  console.log('\n2. It cannot exceed what came in');
  {
    const net = await rest('POST', 'finance', 'rpc/net_received_minor', { p_invoice_id: created.invoice });
    check(Number(net.json) === 100000, 'net received is what was captured', `${net.json}`);

    const tooMuch = one(await request(created.invoice, 150000));
    check(
      tooMuch?.outcome === 'exceeds_received',
      'more than came in is refused, not clamped',
      `outcome ${tooMuch?.outcome}`,
    );

    const zero = one(await request(created.invoice, 0));
    check(zero?.outcome === 'non_positive', 'and nothing is refunded by refunding nothing', `${zero?.outcome}`);
  }

  console.log('\n3. Asking raises an owner-level approval');
  {
    const asked = one(await request(created.invoice, 60000));
    check(asked?.outcome === 'requested', 'the request is recorded', `outcome ${asked?.outcome}`);
    created.refund = asked.refund_id;
    created.request = asked.request_id;

    const approval = one(await rest('GET', 'approvals',
      `approval_requests?id=eq.${created.request}&select=subject_type,required_role,amount_minor`));
    check(
      approval?.subject_type === 'refund' && approval?.required_role === 'owner',
      'against the owner, as the floor requires',
      `${approval?.subject_type}/${approval?.required_role}`,
    );

    // A second request while the first waits must count against the ceiling,
    // or two owners approve the same money.
    const second = one(await request(created.invoice, 60000));
    check(
      second?.outcome === 'exceeds_received',
      'a second request counts the first, even though nothing has left yet',
      `outcome ${second?.outcome} · net ${second?.net_received}`,
    );
  }

  console.log('\n4. Nothing leaves without the approval');
  {
    const early = one(await rest('POST', 'finance', 'rpc/record_refund', {
      p_refund_id: created.refund, p_provider_refund_id: `${MARKER}-ref-1`,
    }));
    check(early?.outcome === 'not_approved', 'recording before approval is refused', `outcome ${early?.outcome}`);

    await call(owner, 'POST', 'approvals', 'rpc/decide_approval', {
      p_request_id: created.request, p_decision: 'approved', p_note: 'agreed with the client',
    });

    const recorded = one(await rest('POST', 'finance', 'rpc/record_refund', {
      p_refund_id: created.refund, p_provider_refund_id: `${MARKER}-ref-1`,
    }));
    check(recorded?.outcome === 'recorded', 'and permitted once it is approved', `outcome ${recorded?.outcome}`);
    check(
      Number(recorded?.net_received) === 40000,
      'net received falls by the refund',
      `${recorded?.net_received}`,
    );

    const twice = one(await rest('POST', 'finance', 'rpc/record_refund', {
      p_refund_id: created.refund, p_provider_refund_id: `${MARKER}-ref-1`,
    }));
    check(twice?.outcome === 'already_recorded', 'recording it again changes nothing', `${twice?.outcome}`);
  }

  console.log('\n5. The invoice does not move');
  {
    const row = one(await rest('GET', 'finance', `invoices?id=eq.${created.invoice}&select=status,paid_minor`));
    check(
      row?.status === 'paid' && Number(row?.paid_minor) === 100000,
      'paid is terminal — the refund is its own row, not a status flip',
      `${row?.status}, paid ${row?.paid_minor}`,
    );

    const audits = await rest('GET', 'audit',
      `audit_log?organization_id=eq.${ORG}&subject_type=eq.refund&select=action`);
    const actions = (audits.json ?? []).map((a) => a.action);
    check(
      actions.includes('refund.requested') && actions.includes('refund.recorded'),
      'and both the asking and the leaving are audited',
      actions.join(', '),
    );
  }

  // ── 6. the refund engine works for the app, not just the service role ────
  //
  // request_refund and record_refund are SECURITY INVOKER and the app calls them
  // with the USER's session (requestRefund / recordRefund → createClient → rpc).
  // Before 20260815310000, finance.refunds had only a SELECT policy — no INSERT
  // and no UPDATE policy — so request_refund's insert was refused outright and
  // record_refund's update matched zero rows: the whole refund flow was dead in
  // the app, while every check above (service role, RLS-bypassing) passed. This
  // drives the real authenticated path with an owner token.
  console.log('\n6. A refund is requested and recorded through the app’s own path');
  {
    const asked = one(await call(owner, 'POST', 'finance', 'rpc/request_refund', {
      p_invoice_id: created.invoice, p_amount_minor: 10000, p_reason: 'authenticated path',
    }));
    check(asked?.outcome === 'requested' && Boolean(asked?.refund_id),
      'an authenticated owner (not the service role) can request a refund — request_refund is not RLS-blocked',
      JSON.stringify(asked ?? null));

    await call(owner, 'POST', 'approvals', 'rpc/decide_approval', {
      p_request_id: asked.request_id, p_decision: 'approved', p_note: 'ok',
    });

    const recorded = one(await call(owner, 'POST', 'finance', 'rpc/record_refund', {
      p_refund_id: asked.refund_id, p_provider_refund_id: `${MARKER}-authpath`, p_recorded_by: created.users[0],
    }));
    check(recorded?.outcome === 'recorded',
      'and record it — record_refund’s update is not RLS-blocked either',
      JSON.stringify(recorded ?? null));

    // A direct authenticated write to a refund is refused (no forging past the
    // approval gate, no tampering with a recorded one).
    const forge = await call(owner, 'POST', 'finance', 'refunds', {
      organization_id: ORG, invoice_id: created.invoice, amount_minor: 1, status: 'recorded', reason: 'forged',
    });
    check(forge.status >= 400,
      'but a direct Data-API write to finance.refunds is refused',
      `status ${forge.status}`);
  }
} finally {
  if (created.invoice) {
    await rest('DELETE', 'finance', `refunds?invoice_id=eq.${created.invoice}`);
    await rest('DELETE', 'finance', `payments?invoice_id=eq.${created.invoice}`);
    await rest('DELETE', 'finance', `invoices?id=eq.${created.invoice}`);
  }
  const pending = await rest('GET', 'approvals', 'approval_requests?state=eq.pending&select=id');
  for (const row of pending.json ?? []) {
    await rest('PATCH', 'approvals', `approval_requests?id=eq.${row.id}`, {
      state: 'cancelled', decided_at: new Date().toISOString(),
    });
  }
  await rest('DELETE', 'approvals', `approval_policies?organization_id=eq.${ORG}`);
  if (created.account) await rest('DELETE', 'core', `client_accounts?id=eq.${created.account}`);
  for (const id of created.users) {
    await rest('DELETE', 'core', `memberships?user_id=eq.${id}`);
    await rest('DELETE', 'core', `users?id=eq.${id}`);
    await fetch(`${URL_BASE}/auth/v1/admin/users/${id}`, {
      method: 'DELETE', headers: { apikey: KEY, Authorization: `Bearer ${KEY}` }, cache: 'no-store',
    });
  }
}

console.log(`\n${checks} checks`);

if (failures === 0) {
  console.log('\x1b[32m✔ Money goes back only when somebody said so, and never more than came in\x1b[0m\n');
  process.exit(0);
}

console.error(`\x1b[31m✖ ${failures} failure(s)\x1b[0m\n`);
process.exit(1);
