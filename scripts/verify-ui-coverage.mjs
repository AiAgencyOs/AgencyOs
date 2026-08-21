// ═══════════════════════════════════════════════════════════════════════════
// Attractive, but incomplete.
//
// Doc 12 §9, of the screen coverage matrix: *"This matrix is one of the main
// controls preventing an AI designer from producing attractive but incomplete
// work."*
//
// Walks one project through the seam that did not exist — an agreed scope, an
// inventory of screens, the mapping between them — and asserts the three
// refusals Doc 12 §20 states exactly, against real Postgres, because each one
// is a trigger or a query and none of them can be checked by reading
// TypeScript.
// ═══════════════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false, jwt: false });
announceTarget(target, 'a design must cover what was agreed');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = 'zztest-ui';
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
const rpc = async (fn, args) => one(await rest('POST', 'projects', `rpc/${fn}`, args));

const screen = (projectId, key, over = {}) =>
  rest('POST', 'projects', 'screens', {
    organization_id: ORG,
    project_id: projectId,
    screen_key: key,
    name: key.replace(/_/g, ' '),
    user_role: 'client',
    has_empty_state: true,
    has_loading_state: true,
    has_error_state: true,
    has_success_state: true,
    ...over,
  });

const map = (screenId, scopeItemId) =>
  rest('POST', 'projects', 'screen_scope_items', {
    organization_id: ORG,
    screen_id: screenId,
    scope_item_id: scopeItemId,
  });

const created = { projects: [], accounts: [], policies: [] };

try {
  // `submit_deliverable` raises an approval request, and with no policy for
  // the subject type it answers `no_policy` and never touches the row — so
  // the gate under test would never be reached. A first draft skipped this
  // and read four `no_policy` outcomes as failures of the trigger.
  // Only if one is not already there. `approval_policies` is UNIQUE per
  // (org, subject_type, threshold), so writing one unconditionally leaves a
  // row behind that fails `db:verify:approvals` on its own first check — which
  // is what the first version of this script did, nine checks deep in a script
  // it never touched. A fixture that survives its own run is a fixture that
  // breaks somebody else's.
  const existing = await rest(
    'GET',
    'approvals',
    `approval_policies?organization_id=eq.${ORG}&subject_type=eq.deliverable&min_amount_minor=eq.0&select=id`,
  );
  if (Array.isArray(existing.json) && existing.json.length === 0) {
    const written = one(
      await rest('POST', 'approvals', 'approval_policies', {
        organization_id: ORG,
        subject_type: 'deliverable',
        min_amount_minor: 0,
        required_role: 'ops_admin',
        sla_hours: 48,
        audience: 'client',
      }),
    );
    if (written?.id) created.policies.push(written.id);
  }

  const account = one(
    await rest('POST', 'core', 'client_accounts', { organization_id: ORG, name: `${MARKER} client` }),
  );
  created.accounts.push(account.id);

  const project = one(
    await rest('POST', 'projects', 'projects', {
      organization_id: ORG,
      client_account_id: account.id,
      name: `${MARKER} ${randomUUID().slice(0, 8)}`,
      status: 'planning',
    }),
  );
  created.projects.push(project.id);

  // ── A ──────────────────────────────────────────────────────────────────
  console.log('\n  A. a design filed before there is any agreed scope is not blocked');

  const early = one(
    await rest('POST', 'projects', 'rpc/add_deliverable', {
      p_project_id: project.id,
      p_kind: 'design',
      p_title: `${MARKER} early concepts`,
    }),
  );
  // Through `submit_deliverable`, not a raw PATCH: `deliverables_guard`
  // refuses any status written around the sanctioned path. A first draft of
  // this script PATCHed the row directly and every refusal came back 400 —
  // including the ones that were supposed to be refused, which would have
  // been three greens earned by the wrong guard.
  const earlyReview = await rpc('submit_deliverable', { p_deliverable_id: early.deliverable_id });
  check(
    earlyReview?.outcome === 'submitted',
    'there is nothing to cover, so there is nothing to refuse',
    earlyReview?.outcome,
  );

  // ── B ──────────────────────────────────────────────────────────────────
  console.log('\n  B. a baseline is agreed, and now the design must answer to it');

  const opened = await rpc('open_scope_version', { p_project_id: project.id });
  const items = {};
  for (const [i, [title, inclusion]] of [
    ['Customer app', 'included'],
    ['Admin panel', 'included'],
    ['Vendor portal', 'excluded'],
    ['Push notifications', 'optional'],
  ].entries()) {
    items[title] = one(
      await rest('POST', 'projects', 'scope_items', {
        organization_id: ORG,
        scope_version_id: opened.scope_version_id,
        title,
        inclusion,
        position: i,
      }),
    );
  }
  const frozen = await rpc('freeze_scope_version', { p_scope_version_id: opened.scope_version_id });
  check(frozen?.outcome === 'frozen', 'the baseline is frozen', frozen?.outcome);

  const design = one(
    await rest('POST', 'projects', 'rpc/add_deliverable', {
      p_project_id: project.id,
      p_kind: 'design',
      p_title: `${MARKER} screens v2`,
    }),
  );

  const uncovered = await rest('POST', 'projects', 'rpc/submit_deliverable', {
    p_deliverable_id: design.deliverable_id,
  });
  check(
    !uncovered.ok && /does not cover the agreed scope/.test(JSON.stringify(uncovered.json)),
    'with no screens at all it cannot be reviewed',
    uncovered.ok ? 'IT WAS ACCEPTED' : `${uncovered.status}`,
  );

  // ── C ──────────────────────────────────────────────────────────────────
  console.log('\n  C. an exclusion is not a design brief');

  const vendorScreen = one(await screen(project.id, 'vendor_portal_home'));
  const excluded = await map(vendorScreen.id, items['Vendor portal'].id);
  check(
    !excluded.ok && /excluded/.test(JSON.stringify(excluded.json)),
    'a screen cannot be mapped to an excluded scope item',
    excluded.ok ? 'IT WAS ACCEPTED' : `${excluded.status}`,
  );

  // ── D ──────────────────────────────────────────────────────────────────
  console.log('\n  D. the matrix says exactly what is missing');

  const customerScreen = one(await screen(project.id, 'customer_home'));
  const mapped = await map(customerScreen.id, items['Customer app'].id);
  check(mapped.ok, 'an included item gains a screen', mapped.ok ? '' : `${mapped.status}`);

  const matrix = await rest('POST', 'projects', 'rpc/ui_coverage', { p_project_id: project.id });
  const rows = Array.isArray(matrix.json) ? matrix.json : [];
  const flags = rows.filter((r) => r.blocking).map((r) => `${r.flag}:${r.subject}`);
  check(
    flags.includes('included_scope_item_has_no_screen:Admin panel'),
    'the uncovered included item is named',
    flags.join(' | ') || 'none',
  );
  check(
    flags.includes('screen_has_no_scope_mapping:vendor portal home'),
    'and so is the screen that maps to nothing',
    '',
  );
  check(
    rows.some((r) => r.flag === 'optional_scope_item_has_no_screen' && r.blocking === false),
    'an optional item with no screen is reported and does not block — it was agreed as optional',
  );

  // ── E ──────────────────────────────────────────────────────────────────
  console.log('\n  E. a judgement nobody configured is flagged, never enforced');

  const bare = one(
    await screen(project.id, 'admin_panel_home', {
      has_empty_state: false,
      has_error_state: false,
    }),
  );
  await map(bare.id, items['Admin panel'].id);

  const withStates = await rest('POST', 'projects', 'rpc/ui_coverage', { p_project_id: project.id });
  const stateFlag = (Array.isArray(withStates.json) ? withStates.json : []).find(
    (r) => r.flag === 'screen_missing_states',
  );
  check(Boolean(stateFlag), 'a screen missing states is reported', stateFlag?.subject ?? 'not reported');
  check(stateFlag?.blocking === false, 'and does not block — Doc 12 §9 says flag, and nobody has configured which states each screen needs');

  // ── F ──────────────────────────────────────────────────────────────────
  console.log('\n  F. once it covers the scope, it may be reviewed');

  // The unmapped screen is the last blocking gap. Removing it is the honest
  // fix for a screen nobody agreed to pay for.
  await rest('DELETE', 'projects', `screens?id=eq.${vendorScreen.id}`);

  const remaining = await rest('POST', 'projects', 'rpc/ui_coverage', { p_project_id: project.id });
  const blocking = (Array.isArray(remaining.json) ? remaining.json : []).filter((r) => r.blocking);
  check(blocking.length === 0, 'no blocking gaps remain', blocking.map((r) => r.subject).join(', ') || '');

  const reviewed = await rpc('submit_deliverable', { p_deliverable_id: design.deliverable_id });
  check(reviewed?.outcome === 'submitted', 'the design enters review', reviewed?.outcome);

  // ── G ──────────────────────────────────────────────────────────────────
  console.log('\n  G. and the rule binds the row, not one caller');

  const build = one(
    await rest('POST', 'projects', 'rpc/add_deliverable', {
      p_project_id: project.id,
      p_kind: 'build',
      p_title: `${MARKER} build`,
    }),
  );
  const buildReview = await rpc('submit_deliverable', { p_deliverable_id: build.deliverable_id });
  check(
    buildReview?.outcome === 'submitted',
    'a build is not a design and is not gated on screens',
    buildReview?.outcome,
  );

  const dupe = await screen(project.id, 'customer_home');
  check(
    !dupe.ok && /duplicate|unique/i.test(JSON.stringify(dupe.json)),
    'two screens cannot claim one id — Doc 12 §9 flags duplicates, and a duplicate id is not a judgement',
    dupe.ok ? 'IT WAS ACCEPTED' : `${dupe.status}`,
  );
} finally {
  // These events did not exist when this script was written. Six Doc 23 §7
  // events are now emitted where their state changes, so a script that
  // creates a scope baseline, a change request, a payment claim or a test run
  // leaves durable rows behind — and `db:verify:unlock` sweeps the outbox for
  // the organization it shares with this one. A fixture that survives its own
  // run breaks somebody else's script, which is the third time that lesson
  // has cost a chain replay.
  for (const id of created.projects) {
    await rest('DELETE', 'core', `outbox_events?payload->>project_id=eq.${id}`);
  }
  for (const id of created.projects) await rest('DELETE', 'projects', `projects?id=eq.${id}`);
  for (const id of created.accounts) await rest('DELETE', 'core', `client_accounts?id=eq.${id}`);
  // Only the policies THIS run created. One that was already there belongs to
  // whoever put it there.
  for (const id of created.policies) await rest('DELETE', 'approvals', `approval_policies?id=eq.${id}`);
}

if (failures > 0) {
  console.error(`\n  ${failures} check(s) failed\n`);
  process.exit(1);
}
console.log('\n  All checks passed.\n');
