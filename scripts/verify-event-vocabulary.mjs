// ═══════════════════════════════════════════════════════════════════════════
// The events the documents name.
//
// Doc 23 §7 lists twenty-six canonical business events. AgencyOS emitted nine
// types and not one of them was one of the twenty-six — §7 names business
// milestones, the repository named row states, and six of §7's events describe
// transitions AgencyOS now performs and records **silently**.
//
// Asserts two different things, and the difference is the point:
//   · the emitted set is CLOSED, so a typo cannot become a durable row that no
//     subscriber will ever match and no check will ever notice;
//   · the six are actually emitted, by the state change rather than by a
//     caller who might not be the only one.
// ═══════════════════════════════════════════════════════════════════════════

import { Buffer } from 'node:buffer';
import { createHmac, randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

// `jwt: true`: open_scope_version, freeze_scope_version and
// submit_change_request all now require core.can_manage_delivery()
// (20260921190000, a real fix for a client-portal role that could call them
// directly with no authority check at all), which reads the caller's JWT
// role — absent on the service-role key this script otherwise uses.
const target = await resolveTarget(fail, { cron: false, anon: false, jwt: true });
announceTarget(target, 'an event nobody declared cannot be emitted');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = 'zztest-events';
const ORG = '00000000-0000-4000-8000-000000000001';

function mint(userId, role) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({
    sub: userId, aud: 'authenticated', role: 'authenticated',
    app_metadata: { organization_id: ORG, role }, iat: now, exp: now + 900,
  });
  return `${header}.${body}.${createHmac('sha256', target.jwtSecret).update(`${header}.${body}`).digest('base64url')}`;
}

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

async function rest(method, schema, path, body, token) {
  const key = token ?? KEY;
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
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
const eventsFor = async (subjectId) =>
  (await rest('GET', 'core', `outbox_events?subject_id=eq.${subjectId}&select=type,subject_type`)).json ?? [];

const created = { projects: [], clients: [], invoices: [], users: [] };

try {
  const authUser = await fetch(`${URL_BASE}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `${MARKER}-owner-${randomUUID().slice(0, 8)}@example.invalid`,
      password: randomUUID(),
      email_confirm: true,
    }),
  }).then((r) => r.json());
  created.users.push(authUser.id);
  await rest('POST', 'core', 'users', { id: authUser.id, email: authUser.email });
  await rest('POST', 'core', 'memberships', {
    organization_id: ORG, user_id: authUser.id, role: 'owner', status: 'active',
  });
  const owner = mint(authUser.id, 'owner');

  // ── A ──────────────────────────────────────────────────────────────────
  console.log('\n  A. the emitted set is closed');

  const typo = await rest('POST', 'core', 'rpc/emit_event', {
    p_organization_id: ORG, p_type: 'invoce.paid',
    p_subject_type: 'invoice', p_subject_id: randomUUID(),
  });
  check(
    !typo.ok && /not declared in core\.event_types/.test(JSON.stringify(typo.json)),
    'a typo is refused rather than becoming a row nothing will ever match',
    typo.ok ? 'IT WAS ACCEPTED' : `${typo.status}`,
  );

  const declared = await rest('GET', 'core', 'event_types?select=type,canonical&order=type');
  const rows = Array.isArray(declared.json) ? declared.json : [];
  check(rows.length >= 15, 'the catalogue is readable', `${rows.length} types`);

  // ── B ──────────────────────────────────────────────────────────────────
  console.log('\n  B. Doc 23 §7 is recorded in full, including what is missing');

  const coverage = await rest('POST', 'core', 'rpc/event_coverage', {});
  const canon = Array.isArray(coverage.json) ? coverage.json : [];
  check(canon.length === 26, 'all twenty-six canonical events are listed', `${canon.length}`);

  const emitted = canon.filter((c) => c.state === 'emitted');
  check(
    emitted.length === 8,
    'eight of them are emitted, and the other eighteen say so rather than being absent',
    emitted.map((c) => c.canonical).join(', '),
  );
  check(
    canon.filter((c) => c.state === 'not_emitted').every((c) => c.emitted_as === null),
    'and an unmapped one carries null, not a guess',
  );

  // ── C ──────────────────────────────────────────────────────────────────
  console.log('\n  C. and the six are emitted by the state change itself');

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

  const opened = one(await rest('POST', 'projects', 'rpc/open_scope_version', { p_project_id: project.id }, owner));
  await rest('POST', 'projects', 'scope_items', {
    organization_id: ORG, scope_version_id: opened.scope_version_id,
    title: 'Customer app', inclusion: 'included',
  });
  await rest('POST', 'projects', 'rpc/freeze_scope_version', { p_scope_version_id: opened.scope_version_id }, owner);
  const frozen = await eventsFor(opened.scope_version_id);
  check(
    frozen.some((e) => e.type === 'scope.frozen'),
    'ScopeFrozen — a baseline becoming the agreed one is now audible',
    frozen.map((e) => e.type).join(', ') || 'nothing',
  );

  const cr = one(
    await rest('POST', 'projects', 'rpc/submit_change_request', {
      p_project_id: project.id, p_requested: 'Please add a vendor portal.',
    }, owner),
  );
  const submitted = await eventsFor(cr.change_request_id);
  check(
    submitted.some((e) => e.type === 'change_request.submitted'),
    'ChangeRequestSubmitted',
    submitted.map((e) => e.type).join(', ') || 'nothing',
  );

  const invoice = one(
    await rest('POST', 'finance', 'invoices', {
      organization_id: ORG, project_id: project.id, client_account_id: client.id,
      number: `${MARKER}-${randomUUID().slice(0, 8)}`, status: 'issued',
      currency: 'INR', total_minor: 100000, issued_at: '2026-08-21T00:00:00Z',
    }),
  );
  created.invoices.push(invoice.id);

  const claim = one(
    await rest('POST', 'finance', 'payment_submissions', {
      organization_id: ORG, invoice_id: invoice.id, amount_minor: 100000,
      method: 'upi', reference: `${MARKER}-${randomUUID().slice(0, 6)}`,
      submitted_by_agent: 'sales',
    }),
  );
  const claimed = await eventsFor(claim.id);
  check(
    claimed.some((e) => e.type === 'payment.submitted'),
    'PaymentSubmitted',
    claimed.map((e) => e.type).join(', ') || 'nothing',
  );

  const build = one(
    await rest('POST', 'projects', 'rpc/add_deliverable', {
      p_project_id: project.id, p_kind: 'build', p_title: `${MARKER} build`,
    }),
  );
  const run = one(
    await rest('POST', 'qa', 'test_runs', {
      organization_id: ORG, project_id: project.id, deliverable_id: build.deliverable_id,
      suite: 'functional', total: 10, passed: 10, failed: 0, skipped: 0,
    }),
  );
  const tested = await eventsFor(run.id);
  check(
    tested.some((e) => e.type === 'test_run.completed'),
    'TestRunCompleted',
    tested.map((e) => e.type).join(', ') || 'nothing',
  );

  // ── D ──────────────────────────────────────────────────────────────────
  console.log('\n  D. an event names the row it describes');

  check(
    frozen.every((e) => e.subject_type === 'scope_version'),
    'so a subscriber can find the thing that changed without guessing',
    frozen.map((e) => e.subject_type).join(', '),
  );
} finally {
  // These events are this run's own. Left behind, they fail the sweeps of
  // scripts that never touched them — the mistake this migration's own
  // change to verify-milestone-unlock exists to stop making in both
  // directions.
  for (const id of created.projects) {
    await rest('DELETE', 'core', `outbox_events?payload->>project_id=eq.${id}`);
    await rest('DELETE', 'projects', `projects?id=eq.${id}`);
  }
  for (const id of created.invoices) {
    await rest('DELETE', 'core', `outbox_events?payload->>invoice_id=eq.${id}`);
    await rest('DELETE', 'core', `outbox_events?subject_type=eq.invoice&subject_id=eq.${id}`);
    await rest('DELETE', 'finance', `payment_submissions?invoice_id=eq.${id}`);
    await rest('DELETE', 'finance', `invoices?id=eq.${id}`);
  }
  for (const id of created.clients) await rest('DELETE', 'core', `client_accounts?id=eq.${id}`);
  for (const id of created.users) {
    await rest('DELETE', 'core', `memberships?user_id=eq.${id}`);
    await rest('DELETE', 'core', `users?id=eq.${id}`);
    await fetch(`${URL_BASE}/auth/v1/admin/users/${id}`, {
      method: 'DELETE',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
    });
  }
}

if (failures > 0) {
  console.error(`\n  ${failures} check(s) failed\n`);
  process.exit(1);
}
console.log('\n  All checks passed.\n');
