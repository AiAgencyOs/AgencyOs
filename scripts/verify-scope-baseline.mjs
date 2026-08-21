// ═══════════════════════════════════════════════════════════════════════════
// The system knows what it is supposed to build.
//
// Doc 11 §1: "The approved scope is the contract-like operational boundary for
// project delivery. AI agents may interpret and execute the scope, but they
// must not silently expand, reduce or rewrite it."
//
// Walks one project through the whole lifecycle — open, freeze, request,
// classify, decide, apply — and asserts the refusals at every seam. Against
// real Postgres, because every rule here is a trigger, a partial unique index
// or a row lock, and none of those can be checked by reading TypeScript.
// ═══════════════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false, jwt: false });
announceTarget(target, 'a scope baseline moves only by transition');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = 'zztest-scope';
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

const created = { projects: [], accounts: [] };

try {
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
  console.log('\n  A. a baseline is opened, filled, and frozen');
  const opened = await rpc('open_scope_version', { p_project_id: project.id });
  check(opened?.outcome === 'opened' && opened.version === 1, 'the first version opens', `v${opened?.version}`);

  const second = await rpc('open_scope_version', { p_project_id: project.id });
  check(second?.outcome === 'draft_exists', 'a second concurrent draft is refused', second?.outcome);

  const empty = await rpc('freeze_scope_version', { p_scope_version_id: opened.scope_version_id });
  check(empty?.outcome === 'empty', 'an empty draft cannot be frozen', empty?.outcome);

  for (const [i, item] of [
    ['Customer app', 'included'],
    ['Admin panel', 'included'],
    ['Vendor portal', 'excluded'],
    ['Push notifications', 'optional'],
  ].entries()) {
    await rest('POST', 'projects', 'scope_items', {
      organization_id: ORG,
      scope_version_id: opened.scope_version_id,
      title: item[0],
      inclusion: item[1],
      position: i,
    });
  }

  const frozen = await rpc('freeze_scope_version', { p_scope_version_id: opened.scope_version_id });
  check(frozen?.outcome === 'frozen' && frozen.items === 4, 'the draft freezes with its items', `${frozen?.items} items`);

  // ── B ──────────────────────────────────────────────────────────────────
  console.log('\n  B. a frozen baseline is history');
  const edit = await rest('PATCH', 'projects', `scope_versions?id=eq.${opened.scope_version_id}`, {
    version: 99,
  });
  check(!edit.ok && /immutable/.test(JSON.stringify(edit.json)), 'it cannot be edited', `${edit.status}`);

  const del = await rest('DELETE', 'projects', `scope_versions?id=eq.${opened.scope_version_id}`);
  check(!del.ok && /cannot be deleted/.test(JSON.stringify(del.json)), 'it cannot be deleted', `${del.status}`);

  const addItem = await rest('POST', 'projects', 'scope_items', {
    organization_id: ORG,
    scope_version_id: opened.scope_version_id,
    title: 'Snuck in later',
  });
  check(
    !addItem.ok && /frozen/.test(JSON.stringify(addItem.json)),
    'and its items cannot be added to — a baseline whose lines move is not frozen',
    `${addItem.status}`,
  );

  // ── C ──────────────────────────────────────────────────────────────────
  console.log('\n  C. a change request argues with a specific version');
  const cr = await rpc('submit_change_request', {
    p_project_id: project.id,
    p_requested: 'Can we also add a vendor portal after all?',
  });
  check(cr?.outcome === 'submitted', 'a request is recorded against the active baseline', cr?.outcome);

  const undecided = await rpc('decide_change_request', {
    p_change_request_id: cr.change_request_id,
    p_approve: true,
  });
  check(undecided?.outcome === 'not_decidable', 'an unclassified request cannot be decided', undecided?.outcome);

  const paid = await rpc('classify_change_request', {
    p_change_request_id: cr.change_request_id,
    p_classification: 'paid_change',
    p_impact_notes: 'A vendor portal is a new surface',
    p_timeline_days: 14,
  });
  check(paid?.outcome === 'classified', 'it is classified', paid?.outcome);

  // ── D ── the ADM-22 boundary, as a refusal ─────────────────────────────
  console.log('\n  D. a paid change cannot be approved without a price somebody quoted');
  const unpriced = await rpc('decide_change_request', {
    p_change_request_id: cr.change_request_id,
    p_approve: true,
  });
  check(
    unpriced?.outcome === 'paid_change_needs_a_proposal',
    'ADM-22: there is nowhere else for that number to live',
    unpriced?.outcome,
  );

  const opp = one(
    await rest('POST', 'sales', 'opportunities', {
      organization_id: ORG,
      name: `${MARKER} change`,
      stage: 'discovery',
      value_minor: 0,
      currency: 'INR',
    }),
  );
  // Through `draft_proposal`, not a raw insert: `proposals_guard` refuses any
  // proposal written around the sanctioned path, and its error says so by
  // naming the function. That refusal is the reason a price has one home.
  const drafted = one(
    await rest('POST', 'sales', 'rpc/draft_proposal', {
      p_opportunity_id: opp.id,
      p_title: `${MARKER} revised quotation`,
    }),
  );
  check(drafted?.outcome === 'created', 'a revised quotation is drafted the sanctioned way', drafted?.outcome);

  const priced = await rpc('decide_change_request', {
    p_change_request_id: cr.change_request_id,
    p_approve: true,
    p_proposal_id: drafted?.proposal_id,
  });
  check(priced?.outcome === 'approved', 'with a proposal it may be approved', priced?.outcome);

  // ── E ──────────────────────────────────────────────────────────────────
  console.log('\n  E. applying it copies rather than edits');
  const applied = await rpc('apply_change_request', { p_change_request_id: cr.change_request_id });
  check(applied?.outcome === 'opened' && applied.version === 2, 'the next baseline opens as v2', `v${applied?.version}`);

  const copied = await rest(
    'GET',
    'projects',
    `scope_items?scope_version_id=eq.${applied.scope_version_id}&select=title,inclusion&order=position`,
  );
  check(
    Array.isArray(copied.json) && copied.json.length === 4,
    'carrying the whole of the previous baseline',
    `${copied.json?.length} items`,
  );

  const old = one(
    await rest('GET', 'projects', `scope_versions?id=eq.${opened.scope_version_id}&select=status`),
  );
  check(old?.status === 'active', 'and the old one is still active until the new one freezes', old?.status);

  await rest('PATCH', 'projects', `scope_items?scope_version_id=eq.${applied.scope_version_id}&title=eq.Vendor portal`, {
    inclusion: 'included',
  });
  const refrozen = await rpc('freeze_scope_version', { p_scope_version_id: applied.scope_version_id });
  check(refrozen?.outcome === 'frozen' && refrozen.superseded === opened.scope_version_id,
    'freezing v2 supersedes v1', refrozen?.outcome);

  const actives = await rest(
    'GET',
    'projects',
    `scope_versions?project_id=eq.${project.id}&status=eq.active&select=version`,
  );
  check(actives.json?.length === 1 && actives.json[0].version === 2, 'exactly one active baseline remains', `v${actives.json?.[0]?.version}`);

  const history = one(
    await rest('GET', 'projects', `scope_versions?id=eq.${opened.scope_version_id}&select=status,frozen_at`),
  );
  check(history?.status === 'superseded' && history.frozen_at !== null, 'v1 is superseded history, not deleted', history?.status);

  // ── F ──────────────────────────────────────────────────────────────────
  console.log('\n  F. no baseline, no change request');
  const bare = one(
    await rest('POST', 'projects', 'projects', {
      organization_id: ORG,
      client_account_id: account.id,
      name: `${MARKER} bare`,
      status: 'planning',
    }),
  );
  created.projects.push(bare.id);
  const orphan = await rpc('submit_change_request', {
    p_project_id: bare.id,
    p_requested: 'change something',
  });
  check(orphan?.outcome === 'no_baseline', 'a project with no agreed scope cannot accrue changes', orphan?.outcome);
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
}

if (failures > 0) {
  console.error(`\n  ${failures} check(s) failed\n`);
  process.exit(1);
}
console.log('\n  All checks passed.\n');
