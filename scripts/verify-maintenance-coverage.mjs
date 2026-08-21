// ═══════════════════════════════════════════════════════════════════════════
// Maintenance is specified after all.
//
// Doc 18 §35: "Never classify new scope as maintenance to avoid approval."
// Doc 18 §18: "Do not label a bug as a paid feature."
// Doc 18 §7:  "Out-of-scope work becomes a Change Request or commercial
//              opportunity."
//
// The same rule pointing two directions, and both cost somebody money. New
// scope filed as maintenance is work the agency does for free and never
// quotes; a warranty defect filed as paid work is a client charged for a
// promise already made.
//
// Also asserts the three absences, because an absence only shows up when
// somebody tries to use it: no price on a plan (ADM-22), no health grade
// (§12's weights are unconfigured), no VIP flag (§15/§35).
// ═══════════════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false, jwt: false });
announceTarget(target, 'new scope cannot hide inside maintenance');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = 'zztest-maint';
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

const created = { projects: [], clients: [], policies: [] };

try {
  const client = one(
    await rest('POST', 'core', 'client_accounts', { organization_id: ORG, name: `${MARKER} client` }),
  );
  created.clients.push(client.id);

  const project = one(
    await rest('POST', 'projects', 'projects', {
      organization_id: ORG, client_account_id: client.id,
      name: `${MARKER} ${randomUUID().slice(0, 8)}`, status: 'completed',
    }),
  );
  created.projects.push(project.id);

  const ticket = (over = {}) =>
    rest('POST', 'projects', 'maintenance_items', {
      organization_id: ORG, client_account_id: client.id, project_id: project.id,
      title: `${MARKER} ${randomUUID().slice(0, 6)}`, status: 'open',
      ...over,
    });

  // ── A ──────────────────────────────────────────────────────────────────
  console.log('\n  A. a plan needs something to maintain');

  const early = await rest('POST', 'projects', 'maintenance_plans', {
    organization_id: ORG, client_account_id: client.id, project_id: project.id,
    name: `${MARKER} care`, billing_model: 'monthly',
  });
  check(
    !early.ok && /delivered handover/.test(JSON.stringify(early.json)),
    'no handover, nothing to maintain — Doc 18 §5',
    early.ok ? 'IT WAS ACCEPTED' : `${early.status}`,
  );

  // Through the engine. `handovers_guard` refuses a handover written straight
  // into `delivered` and its error names the path: use deliver_handover. A
  // first draft wrote the status directly and section A's own precondition
  // never happened, so ten checks below it failed for a reason that had
  // nothing to do with maintenance.
  const handover = one(
    await rest('POST', 'projects', 'handovers', { organization_id: ORG, project_id: project.id }),
  );
  await rest('POST', 'projects', 'handover_items', {
    organization_id: ORG, handover_id: handover.id, kind: 'repository', label: 'Repo',
  });
  const policy = await rest(
    'GET', 'approvals',
    `approval_policies?organization_id=eq.${ORG}&subject_type=eq.handover&min_amount_minor=eq.0&select=id`,
  );
  if (Array.isArray(policy.json) && policy.json.length === 0) {
    const written = one(
      await rest('POST', 'approvals', 'approval_policies', {
        organization_id: ORG, subject_type: 'handover', min_amount_minor: 0,
        required_role: 'ops_admin', sla_hours: 48, audience: 'client',
      }),
    );
    if (written?.id) created.policies.push(written.id);
  }
  const delivered = one(
    await rest('POST', 'projects', 'rpc/deliver_handover', { p_handover_id: handover.id }),
  );
  check(delivered?.outcome === 'delivered', 'the project is handed over', delivered?.outcome);

  const plan = one(
    await rest('POST', 'projects', 'maintenance_plans', {
      organization_id: ORG, client_account_id: client.id, project_id: project.id,
      name: `${MARKER} care`, billing_model: 'monthly',
      coverage: 'Bug fixes and dependency updates.',
    }),
  );
  check(Boolean(plan?.id), 'and now a plan can exist');

  // ── B ──────────────────────────────────────────────────────────────────
  console.log('\n  B. a plan carries no price — ADM-22 over Doc 18 §3');

  const priced = await rest('POST', 'projects', 'maintenance_plans', {
    organization_id: ORG, client_account_id: client.id, project_id: project.id,
    name: `${MARKER} priced`, billing_model: 'annual', price_minor: 5000000,
  });
  check(
    !priced.ok,
    'there is no column for it: a tiered plan with a price IS a price catalog',
    priced.ok ? 'IT WAS ACCEPTED' : `${priced.status}`,
  );

  const assumed = await rest('PATCH', 'projects', `maintenance_plans?id=eq.${plan.id}`, {
    status: 'active',
  });
  check(
    !assumed.ok && /acceptance_is_evidenced/.test(JSON.stringify(assumed.json)),
    'and it cannot go active without the proposal the client accepted — §10: renewal cannot be silently assumed',
    assumed.ok ? 'IT WAS ACCEPTED' : `${assumed.status}`,
  );

  const unexplained = await rest('PATCH', 'projects', `maintenance_plans?id=eq.${plan.id}`, {
    status: 'cancelled',
  });
  check(
    !unexplained.ok && /ending_says_why/.test(JSON.stringify(unexplained.json)),
    'nor end without a reason — §9 "record lapse/cancellation reason"',
    unexplained.ok ? 'IT WAS ACCEPTED' : `${unexplained.status}`,
  );

  // ── C ──────────────────────────────────────────────────────────────────
  console.log('\n  C. new scope cannot hide inside maintenance — §35');

  const newScope = one(await ticket({ coverage: 'change_request', ticket_type: 'new_feature' }));
  check(Boolean(newScope?.id), 'a request can be OPENED as out of scope — §7 classifies after the request');

  const quietly = await rest('PATCH', 'projects', `maintenance_items?id=eq.${newScope.id}`, {
    status: 'resolved', closed_at: new Date().toISOString(),
  });
  check(
    !quietly.ok && /must become a change request/.test(JSON.stringify(quietly.json)),
    'but it cannot be quietly done: doing it is how new scope escapes approval',
    quietly.ok ? 'IT WAS ACCEPTED' : `${quietly.status}`,
  );

  const declined = one(await ticket({ coverage: 'new_project' }));
  const refused = await rest('PATCH', 'projects', `maintenance_items?id=eq.${declined.id}`, {
    status: 'declined', closed_at: new Date().toISOString(),
  });
  check(
    refused.ok,
    'declining it is the correct outcome, not an evasion, and stays available',
    refused.ok ? '' : `${refused.status}`,
  );

  // ── D ──────────────────────────────────────────────────────────────────
  console.log('\n  D. and a bug cannot be turned into a sale — §18');

  const opened = await rpcOpenScope(project.id);
  const changeRequestId = opened;

  const billedBug = await ticket({
    coverage: 'warranty', ticket_type: 'production_bug',
    change_request_id: changeRequestId,
  });
  check(
    !billedBug.ok && /covered work and cannot be turned into paid work/.test(JSON.stringify(billedBug.json)),
    'a warranty defect may not carry the paperwork of paid work',
    billedBug.ok ? 'IT WAS ACCEPTED' : `${billedBug.status}`,
  );

  const covered = one(await ticket({ coverage: 'warranty', ticket_type: 'production_bug', plan_id: plan.id }));
  const closedFine = await rest('PATCH', 'projects', `maintenance_items?id=eq.${covered.id}`, {
    status: 'resolved', closed_at: new Date().toISOString(),
  });
  check(closedFine.ok, 'a covered defect closes inside maintenance, as it should', closedFine.ok ? '' : `${closedFine.status}`);

  const recoded = await rest('PATCH', 'projects', `maintenance_items?id=eq.${covered.id}`, {
    coverage: 'change_request',
  });
  check(
    !recoded.ok && /is history/.test(JSON.stringify(recoded.json)),
    'and once closed, its classification is history — re-coding it is how the record stops matching what was billed',
    recoded.ok ? 'IT WAS ACCEPTED' : `${recoded.status}`,
  );

  const unclassified = one(await ticket({}));
  const nameless = await rest('PATCH', 'projects', `maintenance_items?id=eq.${unclassified.id}`, {
    status: 'resolved', closed_at: new Date().toISOString(),
  });
  check(
    !nameless.ok && /without saying what it was/.test(JSON.stringify(nameless.json)),
    'and nothing is resolved without saying what it was',
    nameless.ok ? 'IT WAS ACCEPTED' : `${nameless.status}`,
  );

  // ── E ──────────────────────────────────────────────────────────────────
  console.log('\n  E. the health signals are reported and never graded');

  const signals = await rest('POST', 'projects', 'rpc/account_health_signals', {
    p_client_account_id: client.id,
  });
  const rows = Array.isArray(signals.json) ? signals.json : [];
  check(rows.length > 0, 'signals come back', `${rows.length} signals`);
  check(
    rows.every((r) => !/score|status|health_band|grade/i.test(r.signal)),
    'and not one of them is a grade — §12 leaves the weights to Admin policy',
    rows.map((r) => r.signal).join(', '),
  );

  const vip = await rest('PATCH', 'core', `client_accounts?id=eq.${client.id}`, { vip: true });
  check(
    !vip.ok,
    'and there is no VIP flag to set — §35: never claim VIP without configured criteria',
    vip.ok ? 'IT WAS ACCEPTED' : `${vip.status}`,
  );
} finally {
  for (const id of created.projects) await rest('DELETE', 'projects', `projects?id=eq.${id}`);
  for (const id of created.clients) await rest('DELETE', 'core', `client_accounts?id=eq.${id}`);
  // Only the policies THIS run created — one that was already there belongs to
  // whoever put it there, and a fixture that survives its own run breaks
  // somebody else's script four steps later.
  for (const id of created.policies) await rest('DELETE', 'approvals', `approval_policies?id=eq.${id}`);
}

async function rpcOpenScope(projectId) {
  // A real change request, made the sanctioned way, so section D is refusing
  // an actual link rather than a syntactically invalid uuid.
  const opened = one(await rest('POST', 'projects', 'rpc/open_scope_version', { p_project_id: projectId }));
  await rest('POST', 'projects', 'scope_items', {
    organization_id: ORG, scope_version_id: opened.scope_version_id, title: 'Baseline', inclusion: 'included',
  });
  await rest('POST', 'projects', 'rpc/freeze_scope_version', { p_scope_version_id: opened.scope_version_id });
  const cr = one(
    await rest('POST', 'projects', 'rpc/submit_change_request', {
      p_project_id: projectId, p_requested: 'Please add a vendor portal.',
    }),
  );
  return cr?.change_request_id ?? null;
}

if (failures > 0) {
  console.error(`\n  ${failures} check(s) failed\n`);
  process.exit(1);
}
console.log('\n  All checks passed.\n');
