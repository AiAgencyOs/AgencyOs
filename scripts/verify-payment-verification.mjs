// ═══════════════════════════════════════════════════════════════════════════
// A payment is claimed, then verified. They are not the same act.
//
// Doc 15 §23: "Never mark a milestone paid from a client message alone."
// Doc 15 §12: "Agents must not fabricate verification evidence."
// Doc 15 §36: "Do not allow agent self-approval for high-risk financial
//              actions." / "Require exact references for payment matching."
//
// The central control is an ABSENCE — there is no `verified_by_agent` column —
// and an absence cannot be asserted by reading the migration, only by trying
// to use it. So this drives real Postgres and tries.
// ═══════════════════════════════════════════════════════════════════════════

import { Buffer } from 'node:buffer';
import { createHmac, randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false, jwt: true });
announceTarget(target, 'a claim is not a payment until a person says so');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = 'zztest-pay';
const ORG = '00000000-0000-4000-8000-000000000001';

let failures = 0;
function check(condition, description, detail = '') {
  console.log(`  ${condition ? '✓' : '✗'} ${description}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures += 1;
}

const parse = (t) => {
  try {
    return t ? JSON.parse(t) : null;
  } catch {
    return t;
  }
};

async function rest(method, schema, path, body) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      'Content-Profile': schema,
      'Accept-Profile': schema,
      Prefer: 'return=representation',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { ok: res.ok, status: res.status, json: parse(await res.text()) };
}

const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);

/**
 * A token carrying the claims the RLS helpers actually read.
 * `core.current_organization_id()` and `core.current_user_role()` read
 * `app_metadata`, so a token without it belongs to no tenant.
 */
function mint(userId, organizationId, role) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({
    sub: userId, aud: 'authenticated', role: 'authenticated',
    app_metadata: { organization_id: organizationId, role },
    iat: now, exp: now + 900,
  });
  const sig = createHmac('sha256', target.jwtSecret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

/** A PostgREST call as a signed-in person, rather than as the service role. */
async function as(token, method, schema, path, body) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: token,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Profile': schema,
      'Accept-Profile': schema,
      Prefer: 'return=representation',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { ok: res.ok, status: res.status, json: parse(await res.text()) };
}
// core.users.id carries a foreign key to auth.users, so the identity has to
// exist in auth first and `on_auth_user_created` mirrors it across — writing
// core.users directly races that trigger and loses. Same order the milestone
// and refund fixtures use.
const owner = async () => {
  const auth = await fetch(`${URL_BASE}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({
      email: `zztest-pay-${randomUUID().slice(0, 8)}@example.invalid`,
      password: randomUUID(),
      email_confirm: true,
    }),
  }).then((r) => r.json());
  if (!auth?.id) return null;
  const mirrored = await rest('GET', 'core', `users?id=eq.${auth.id}&select=id`);
  return Array.isArray(mirrored.json) && mirrored.json.length === 1 ? auth.id : null;
};

const created = { submissions: [], accounts: [], invoices: [], projects: [], clients: [] };

try {
  const verifier = await owner();
  check(Boolean(verifier), 'a person exists to be the verifier');

  const client = one(
    await rest('POST', 'core', 'client_accounts', { organization_id: ORG, name: `${MARKER} client` }),
  );
  created.clients.push(client.id);

  const project = one(
    await rest('POST', 'projects', 'projects', {
      organization_id: ORG, client_account_id: client.id,
      name: `${MARKER} ${randomUUID().slice(0, 8)}`, status: 'planning',
    }),
  );
  created.projects.push(project.id);

  const invoice = one(
    await rest('POST', 'finance', 'invoices', {
      organization_id: ORG, project_id: project.id, client_account_id: client.id,
      number: `${MARKER}-${randomUUID().slice(0, 8)}`,
      status: 'issued', currency: 'INR', total_minor: 5000000,
      issued_at: '2026-08-21T00:00:00Z', due_at: '2026-09-04T00:00:00Z',
    }),
  );
  check(Boolean(invoice?.id), 'an invoice exists to be paid', invoice?.id ? '' : JSON.stringify(invoice).slice(0, 140));
  if (invoice?.id) created.invoices.push(invoice.id);

  // ── A ──────────────────────────────────────────────────────────────────
  console.log('\n  A. the agency records where money should go');

  const account = one(
    await rest('POST', 'finance', 'payment_accounts', {
      organization_id: ORG, kind: 'upi', label: `${MARKER} UPI`,
      instructions: { vpa: 'agency@upi' },
    }),
  );
  check(Boolean(account?.id), 'an account is configured');
  if (account?.id) created.accounts.push(account.id);

  const editable = await rest('PATCH', 'finance', `payment_accounts?id=eq.${account.id}`, {
    instructions: { vpa: 'agency-new@upi' },
  });
  check(editable.ok, 'and while nothing has used it, it can still be corrected', editable.ok ? '' : `${editable.status}`);

  // ── B ──────────────────────────────────────────────────────────────────
  console.log('\n  B. a client message becomes a CLAIM, not a payment');

  const claimRes = await rest('POST', 'finance', 'payment_submissions', {
      organization_id: ORG, invoice_id: invoice.id, account_id: account.id,
      amount_minor: 2500000, method: 'upi', reference: 'UTR402318',
      payer_name: 'Brightleaf Retail', paid_at: '2026-08-21T09:00:00Z',
      submitted_by_agent: 'sales',
  });
  const claim = one(claimRes);
  check(Boolean(claim?.id), 'an agent may record what the client said', claim?.id ? '' : JSON.stringify(claimRes.json).slice(0, 200));
  if (claim?.id) created.submissions.push(claim.id);
  check(claim?.status === 'pending_verification', 'and it lands as a claim awaiting a person', claim?.status);
  check(claim?.payment_id === null, 'with no ledger row behind it — Doc 15 §23', String(claim?.payment_id));

  const ledger = await rest('GET', 'finance', `payments?invoice_id=eq.${invoice.id}&select=id`);
  check(
    Array.isArray(ledger.json) && ledger.json.length === 0,
    'the ledger is untouched: a message is not money',
    `${ledger.json?.length} payment rows`,
  );

  // ── C ──────────────────────────────────────────────────────────────────
  console.log('\n  C. THE CONTROL — an agent cannot verify, because there is no way to say so');

  const asAgent = await rest('POST', 'finance', 'payment_submissions', {
    organization_id: ORG, invoice_id: invoice.id, amount_minor: 100,
    method: 'upi', reference: 'UTR-AGENT-1',
    submitted_by_agent: 'finance', verified_by_agent: 'finance',
  });
  check(
    !asAgent.ok,
    'the column does not exist, so the write cannot even be expressed',
    asAgent.ok ? 'IT WAS ACCEPTED' : `${asAgent.status}`,
  );

  const forged = await rest('PATCH', 'finance', `payment_submissions?id=eq.${claim.id}`, {
    status: 'verified', verification_evidence: 'looks right to me',
  });
  check(
    !forged.ok && /verified_is_evidenced/.test(JSON.stringify(forged.json)),
    'and a status of verified with no verifier is unrepresentable — §12 wants verifier AND evidence',
    forged.ok ? 'IT WAS ACCEPTED' : `${forged.status}`,
  );

  const evidenceless = one(
    await rest('POST', 'finance', 'rpc/verify_payment_submission', {
      p_submission_id: claim.id, p_verified_by: verifier, p_evidence: '   ',
    }),
  );
  check(evidenceless?.outcome === 'no_evidence', 'verifying with blank evidence is refused', evidenceless?.outcome);

  const anonymous = one(
    await rest('POST', 'finance', 'rpc/verify_payment_submission', {
      p_submission_id: claim.id, p_verified_by: null, p_evidence: 'bank statement line 44',
    }),
  );
  check(anonymous?.outcome === 'no_verifier', 'and verifying with no verifier is refused', anonymous?.outcome);

  // ── D ──────────────────────────────────────────────────────────────────
  console.log('\n  D. a person checks it, and that is recorded');

  const verified = one(
    await rest('POST', 'finance', 'rpc/verify_payment_submission', {
      p_submission_id: claim.id, p_verified_by: verifier,
      p_evidence: 'HDFC statement 2026-08-21, credit 25,000.00, UTR402318',
    }),
  );
  check(verified?.outcome === 'verified', 'the claim is verified', verified?.outcome);

  const settled = one(
    await rest('POST', 'finance', 'rpc/verify_payment_submission', {
      p_submission_id: claim.id, p_verified_by: verifier, p_evidence: 'again',
    }),
  );
  check(settled?.outcome === 'settled', 'and cannot be verified twice', settled?.outcome);

  const still = one(await rest('GET', 'finance', `payment_submissions?id=eq.${claim.id}&select=payment_id,verified_by`));
  check(still?.payment_id === null, 'verifying still did not move money — that is a separate act', String(still?.payment_id));
  check(still?.verified_by === verifier, 'and the verifier is on the row', still?.verified_by ? 'recorded' : 'missing');

  // ── E ──────────────────────────────────────────────────────────────────
  console.log('\n  E. money enters only through the path that owns the ceiling');

  const recorded = one(
    await rest('POST', 'finance', 'rpc/record_manual_payment', {
      p_invoice_id: invoice.id, p_provider_payment_id: 'UTR402318',
      p_amount_minor: 2500000, p_captured_at: '2026-08-21T09:00:00Z',
      p_method: 'upi',
    }),
  );
  check(recorded?.outcome === 'recorded', 'the verified claim is put through record_manual_payment', recorded?.outcome ?? JSON.stringify(recorded).slice(0,160));

  const over = one(
    await rest('POST', 'finance', 'rpc/record_manual_payment', {
      p_invoice_id: invoice.id, p_provider_payment_id: 'UTR-OVER',
      p_amount_minor: 9000000, p_captured_at: '2026-08-21T10:00:00Z',
      p_method: 'upi',
    }),
  );
  check(
    over?.outcome === 'overpayment',
    'and the overpayment refusal is still the one that was already there',
    over?.outcome,
  );

  // ── F ──────────────────────────────────────────────────────────────────
  console.log('\n  F. an exact reference, exactly once');

  const dupe = await rest('POST', 'finance', 'payment_submissions', {
    organization_id: ORG, invoice_id: invoice.id, amount_minor: 2500000,
    method: 'upi', reference: 'utr402318', submitted_by: verifier,
  });
  check(
    !dupe.ok && /reference_key|duplicate/i.test(JSON.stringify(dupe.json)),
    'the same UTR in a different case is the same UTR — §36',
    dupe.ok ? 'IT WAS ACCEPTED' : `${dupe.status}`,
  );

  const authorless = await rest('POST', 'finance', 'payment_submissions', {
    organization_id: ORG, invoice_id: invoice.id, amount_minor: 100, method: 'cash',
  });
  check(
    !authorless.ok && /has_one_author/.test(JSON.stringify(authorless.json)),
    'and a claim with no author is refused — "who said this" always has one answer',
    authorless.ok ? 'IT WAS ACCEPTED' : `${authorless.status}`,
  );

  // ── G ──────────────────────────────────────────────────────────────────
  console.log('\n  G. an account that money has been sent to stops moving');

  const moved = await rest('PATCH', 'finance', `payment_accounts?id=eq.${account.id}`, {
    instructions: { vpa: 'somewhere-else@upi' },
  });
  check(
    !moved.ok && /has been used/.test(JSON.stringify(moved.json)),
    'where money goes cannot be edited once a claim has named it — Doc 15 §9',
    moved.ok ? 'IT WAS ACCEPTED' : `${moved.status}`,
  );

  const deactivated = await rest('PATCH', 'finance', `payment_accounts?id=eq.${account.id}`, {
    status: 'inactive',
  });
  check(deactivated.ok, 'but deactivating it stays available, which §9 asks for by name', deactivated.ok ? '' : `${deactivated.status}`);

  // ── H ── the row rules, as a signed-in person ─────────────────────────
  //
  // The service role has no `auth.uid()`, so every check above ran past the
  // one rule that only binds a real session. An UPDATE policy wide enough for
  // `verify_payment_submission` is wide enough for a hand-written PATCH, and
  // these are what stop that being a forgery surface.
  console.log('\n  H. and as a signed-in person, the row itself holds the line');

  const token = mint(verifier, ORG, 'ops_admin');

  const impersonated = await as(token, 'PATCH', 'finance', `payment_submissions?id=eq.${claim.id}`, {
    verified_by: '00000000-0000-4000-8000-0000000000ff',
  });
  check(
    !impersonated.ok && /names the person who did it/.test(JSON.stringify(impersonated.json)),
    'an ops_admin cannot record somebody ELSE as the verifier — §12',
    impersonated.ok ? 'IT WAS ACCEPTED' : `${impersonated.status}`,
  );

  const amended = await as(token, 'PATCH', 'finance', `payment_submissions?id=eq.${claim.id}`, {
    amount_minor: 1,
  });
  check(
    !amended.ok && /what was claimed/.test(JSON.stringify(amended.json)),
    'nor edit what the client actually claimed',
    amended.ok ? 'IT WAS ACCEPTED' : `${amended.status}`,
  );

  const resettled = await as(token, 'PATCH', 'finance', `payment_submissions?id=eq.${claim.id}`, {
    status: 'rejected', rejected_reason: 'changed my mind',
  });
  check(
    !resettled.ok && /already verified/.test(JSON.stringify(resettled.json)),
    'and a settled claim stays settled at the ROW, not only inside the function',
    resettled.ok ? 'IT WAS ACCEPTED' : `${resettled.status}`,
  );

  // ── I ──────────────────────────────────────────────────────────────────
  console.log('\n  I. a rejection says why');

  const second = one(
    await rest('POST', 'finance', 'payment_submissions', {
      organization_id: ORG, invoice_id: invoice.id, amount_minor: 1000,
      method: 'bank_transfer', reference: 'UTR-WRONG', submitted_by: verifier,
    }),
  );
  if (second?.id) created.submissions.push(second.id);

  const silent = one(
    await rest('POST', 'finance', 'rpc/verify_payment_submission', {
      p_submission_id: second.id, p_verified_by: verifier, p_evidence: null,
      p_approve: false, p_reason: null,
    }),
  );
  check(silent?.outcome === 'no_reason', 'a rejection with no reason is refused', silent?.outcome);

  // Straight at the row, around the function. Red-proving found this: with
  // only the RPC exercised, dropping `payment_submissions_rejection_says_why`
  // changed nothing, because `verify_payment_submission` answers `no_reason`
  // before the constraint is ever reached. The function was covered and the
  // constraint was not — which is the same half-a-check this repository has
  // now caught five times, once in each layer somebody assumed was the only
  // one. A rule that only holds through one caller is a rule the next caller
  // does not have.
  const rawRejection = await rest('PATCH', 'finance', `payment_submissions?id=eq.${second.id}`, {
    status: 'rejected',
  });
  check(
    !rawRejection.ok && /rejection_says_why/.test(JSON.stringify(rawRejection.json)),
    'and the row itself refuses a silent rejection, not just the function',
    rawRejection.ok ? 'IT WAS ACCEPTED' : `${rawRejection.status}`,
  );

  const rejected = one(
    await rest('POST', 'finance', 'rpc/verify_payment_submission', {
      p_submission_id: second.id, p_verified_by: verifier, p_evidence: null,
      p_approve: false, p_reason: 'No credit found against this UTR on any agency account.',
    }),
  );
  check(rejected?.outcome === 'rejected', 'with one, it is rejected and the reason is kept', rejected?.outcome);
} finally {
  // Recording a payment emits `invoice.paid` into core.outbox_events, and
  // `db:verify:unlock` asserts that table is GLOBALLY empty at the end of its
  // own run — so a fixture that leaves events behind fails a script it never
  // touches, four scripts later. Same lesson as the approval-policy fixture in
  // verify-ui-coverage: a fixture that survives its own run breaks somebody
  // else's. Scoped to this run's invoices, so nothing anybody else queued is
  // swept up with it.
  for (const id of created.invoices) {
    await rest('DELETE', 'core', `outbox_events?subject_type=eq.invoice&subject_id=eq.${id}`);
  }
  for (const id of created.submissions) await rest('DELETE', 'finance', `payment_submissions?id=eq.${id}`);
  for (const id of created.invoices) await rest('DELETE', 'finance', `payments?invoice_id=eq.${id}`);
  for (const id of created.invoices) await rest('DELETE', 'finance', `invoices?id=eq.${id}`);
  for (const id of created.accounts) await rest('DELETE', 'finance', `payment_accounts?id=eq.${id}`);
  for (const id of created.projects) await rest('DELETE', 'projects', `projects?id=eq.${id}`);
  for (const id of created.clients) await rest('DELETE', 'core', `client_accounts?id=eq.${id}`);
}

if (failures > 0) {
  console.error(`\n  ${failures} check(s) failed\n`);
  process.exit(1);
}
console.log('\n  All checks passed.\n');
