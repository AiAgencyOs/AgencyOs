#!/usr/bin/env node
/**
 * A won deal becoming a workspace, verified against a real database.
 *
 * Gap G-017, decision ADM-06, against Document 10 §1, §2, §5–§7.
 *
 * What it proves:
 *
 *   1. The checklist is Document 10 §6's seventeen items, in its order — not
 *      a list somebody made up, because a checklist nobody recognises is a
 *      checklist nobody works through.
 *   2. Seeding is idempotent, and idempotent by the *count*: an item somebody
 *      deleted is not silently reinstated by a repeated conversion.
 *   3. An item is ticked, un-ticked and excused, and un-ticking clears who
 *      answered — a cleared item still naming an answerer is a record of a
 *      decision that no longer holds.
 *   4. A half-answer is refused in DDL, on every path including PostgREST.
 *   5. **It blocks nothing.** A project with every item pending starts
 *      exactly as readily as one with every item done — ADM-06's whole
 *      answer, and the one thing about this feature that could rot quietly.
 *   6. The client cannot see it: the checklist names what the agency still has
 *      to chase out of them and who inside the agency owes what.
 *
 *   node scripts/verify-onboarding.mjs
 */

import { Buffer } from 'node:buffer';
import { createHmac, randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false, jwt: true });
await announceTarget(target, 'verify-onboarding');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = 'zztest-onboard';
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

function mint(userId, role, extra = {}) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({
    sub: userId,
    aud: 'authenticated',
    role: 'authenticated',
    app_metadata: { organization_id: ORG, role, ...extra },
    iat: now,
    exp: now + 900,
  });
  return `${header}.${body}.${createHmac('sha256', target.jwtSecret).update(`${header}.${body}`).digest('base64url')}`;
}

/** Document 10 §6, in its order. Written out so a reordering is a failure. */
const EXPECTED = [
  'client_identity_confirmed',
  'accepted_quotation_confirmed',
  'commercial_terms_confirmed',
  'payment_verified',
  'project_name_confirmed',
  'requirements_imported',
  'scope_version_created',
  'timeline_assumptions_recorded',
  'stakeholders_identified',
  'assets_requested',
  'design_references_requested',
  'technical_access_identified',
  'whatsapp_group_mapped',
  'project_manager_assigned',
  'specialist_agents_assigned',
  'kickoff_sent',
  'project_activated',
];

const created = { users: [], projects: [], accounts: [] };

async function newProject(name) {
  const account = one(
    await rest('POST', 'core', 'client_accounts', {
      organization_id: ORG,
      name: `${MARKER} ${name}`,
    }),
  );
  created.accounts.push(account.id);

  const project = one(
    await rest('POST', 'projects', 'projects', {
      organization_id: ORG,
      client_account_id: account.id,
      name: `${MARKER} ${name}`,
      status: 'planning',
    }),
  );
  created.projects.push(project.id);
  return project.id;
}

console.log('\n\x1b[1mAgencyOS — a won deal becomes a workspace (G-017)\x1b[0m');

try {
  // ── 1 & 2. the list, and seeding it ─────────────────────────────────────
  console.log('\n1. The checklist is Document 10 §6’s, in its order');
  {
    const project = await newProject('checklist');
    const seeded = one(await rest('POST', 'projects', 'rpc/seed_onboarding', { p_project_id: project }));
    check(seeded?.outcome === 'seeded' && seeded?.items === 17, 'seventeen items are created', `${seeded?.items}`);

    const items = (
      await rest('GET', 'projects', `onboarding_items?project_id=eq.${project}&select=position,key,status&order=position.asc`)
    ).json;
    const keys = (items ?? []).map((i) => i.key);
    check(
      JSON.stringify(keys) === JSON.stringify(EXPECTED),
      'every item is the document’s, in the document’s order',
      keys.slice(0, 3).join(', '),
    );
    check(
      (items ?? []).every((i) => i.status === 'pending'),
      'and all of them start pending — nothing is ticked on the agency’s behalf',
    );

    const again = one(await rest('POST', 'projects', 'rpc/seed_onboarding', { p_project_id: project }));
    check(
      again?.outcome === 'already_seeded' && again?.items === 17,
      'seeding twice does not duplicate the list',
      `outcome ${again?.outcome}, ${again?.items} items`,
    );

    // Idempotent by the count, not only by the unique key: this is the case
    // `on conflict do nothing` alone would get wrong.
    await rest('DELETE', 'projects', `onboarding_items?project_id=eq.${project}&key=eq.kickoff_sent`);
    const afterDelete = one(await rest('POST', 'projects', 'rpc/seed_onboarding', { p_project_id: project }));
    const count = (
      await rest('GET', 'projects', `onboarding_items?project_id=eq.${project}&select=key`)
    ).json;
    check(
      afterDelete?.outcome === 'already_seeded' && (count ?? []).length === 16,
      'an item somebody deleted is not silently reinstated',
      `${count?.length} items`,
    );

    created.checklistProject = project;
  }

  // ── 3 & 4. working through it ───────────────────────────────────────────
  console.log('\n2. Ticking, excusing, and taking it back');
  {
    const project = created.checklistProject;
    const item = one(
      await rest('GET', 'projects', `onboarding_items?project_id=eq.${project}&key=eq.client_identity_confirmed&select=id`),
    );

    const authUser = await fetch(`${URL_BASE}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({
        email: `${MARKER}-lead-${randomUUID().slice(0, 8)}@example.invalid`,
        password: randomUUID(),
        email_confirm: true,
      }),
    }).then((r) => r.json());
    const actorId = authUser?.id;
    if (!actorId) throw new Error('could not create the actor');
    await rest('POST', 'core', 'users', { id: actorId, email: authUser.email });
    await rest('POST', 'core', 'memberships', {
      organization_id: ORG, user_id: actorId, role: 'delivery_lead', status: 'active',
    });
    created.users.push(actorId);

    const ticked = one(
      await rest('POST', 'projects', 'rpc/set_onboarding_item', {
        p_item_id: item.id, p_status: 'done', p_note: 'GST number checked.', p_actor: actorId,
      }),
    );
    check(ticked?.outcome === 'set' && ticked?.done === 1, 'an item is ticked, and progress is reported', `${ticked?.done}/${ticked?.total}`);

    const row = one(
      await rest('GET', 'projects', `onboarding_items?id=eq.${item.id}&select=status,completed_at,completed_by,note`),
    );
    check(
      row?.completed_at !== null && row?.completed_by === actorId,
      'recording who answered and when',
    );

    const untick = one(
      await rest('POST', 'projects', 'rpc/set_onboarding_item', { p_item_id: item.id, p_status: 'pending' }),
    );
    check(untick?.done === 0, 'it can be taken back', `${untick?.done} done`);

    const cleared = one(
      await rest('GET', 'projects', `onboarding_items?id=eq.${item.id}&select=completed_at,completed_by`),
    );
    check(
      cleared?.completed_at === null && cleared?.completed_by === null,
      'and taking it back clears who answered — not a record of a decision that no longer holds',
      `${cleared?.completed_at}`,
    );

    const excused = one(
      await rest('POST', 'projects', 'rpc/set_onboarding_item', {
        p_item_id: item.id, p_status: 'not_applicable', p_actor: actorId,
      }),
    );
    check(excused?.outcome === 'set', 'an item that does not apply can say so', `outcome ${excused?.outcome}`);

    const nonsense = one(
      await rest('POST', 'projects', 'rpc/set_onboarding_item', { p_item_id: item.id, p_status: 'maybe' }),
    );
    check(nonsense?.outcome === 'invalid_status', 'and nothing else is a status', `outcome ${nonsense?.outcome}`);

    // The half-answer, straight through PostgREST.
    const half = await rest('PATCH', 'projects', `onboarding_items?project_id=eq.${project}&key=eq.assets_requested`, {
      status: 'done',
    });
    check(
      half.status >= 400 && half.text.includes('onboarding_items_completion_shape'),
      'a done item with no timestamp is refused in DDL, on every path',
      `status ${half.status}`,
    );
  }

  // ── 5. it blocks nothing — the whole of ADM-06 ──────────────────────────
  console.log('\n3. It blocks nothing (ADM-06)');
  {
    // Two projects, identical apart from the checklist: one untouched, one
    // fully worked through. Both are asked the same question.
    const bare = await newProject('bare');
    await rest('POST', 'projects', 'rpc/seed_onboarding', { p_project_id: bare });

    const done = await newProject('done');
    await rest('POST', 'projects', 'rpc/seed_onboarding', { p_project_id: done });
    const items = (await rest('GET', 'projects', `onboarding_items?project_id=eq.${done}&select=id`)).json ?? [];
    for (const i of items) {
      await rest('POST', 'projects', 'rpc/set_onboarding_item', { p_item_id: i.id, p_status: 'done' });
    }

    const readiness = async (id) =>
      one(await rest('POST', 'projects', 'rpc/start_readiness', { p_project_id: id }));

    const [a, b] = [await readiness(bare), await readiness(done)];
    check(
      JSON.stringify(a) === JSON.stringify(b),
      'a project with nothing ticked is exactly as ready to start as one with everything ticked',
      `${JSON.stringify(a)} vs ${JSON.stringify(b)}`,
    );

    const startBare = one(await rest('POST', 'projects', 'rpc/start_project', { p_project_id: bare }));
    const startDone = one(await rest('POST', 'projects', 'rpc/start_project', { p_project_id: done }));
    check(
      startBare?.outcome === startDone?.outcome,
      'and starting them answers identically — the checklist is not a gate',
      `${startBare?.outcome} vs ${startDone?.outcome}`,
    );
    check(
      Array.isArray(startBare?.unmet) &&
        !startBare.unmet.some((u) => String(u).includes('onboarding') || String(u).includes('checklist')),
      'no unmet condition mentions the checklist',
      JSON.stringify(startBare?.unmet),
    );
  }

  // ── 6. the client cannot see it ─────────────────────────────────────────
  console.log('\n4. The checklist is internal');
  {
    const project = created.checklistProject;
    const account = one(
      await rest('GET', 'projects', `projects?id=eq.${project}&select=client_account_id`),
    );

    const clientAuth = await fetch(`${URL_BASE}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({
        email: `${MARKER}-client-${randomUUID().slice(0, 8)}@example.invalid`,
        password: randomUUID(),
        email_confirm: true,
      }),
    }).then((r) => r.json());
    created.users.push(clientAuth.id);
    await rest('POST', 'core', 'users', { id: clientAuth.id, email: clientAuth.email });

    const client = mint(clientAuth.id, 'client_admin', {
      client_account_id: account.client_account_id,
      audience: 'client',
    });

    const seen = await call(client, 'GET', 'projects', `onboarding_items?project_id=eq.${project}&select=key`);
    check(
      (seen.json ?? []).length === 0,
      'a client on this very project sees none of it',
      `${(seen.json ?? []).length} rows, status ${seen.status}`,
    );

    const written = await call(client, 'POST', 'projects', 'onboarding_items', {
      organization_id: ORG, project_id: project, position: 99, key: 'client_wrote_this', label: 'Nope',
    });
    check(written.status >= 400, 'and cannot write one', `status ${written.status}`);
  }

  // ── the accepted quotation the project carries ──────────────────────────
  console.log('\n5. The project keeps the numbers the client agreed to');
  {
    const project = created.checklistProject;
    const column = await rest('GET', 'projects', `projects?id=eq.${project}&select=proposal_id`);
    check(
      column.status < 300 && 'proposal_id' in (one(column) ?? {}),
      'a project has somewhere to record its accepted quotation (§7)',
      `status ${column.status}`,
    );
    check(
      one(column)?.proposal_id === null,
      'and a project raised without one is not refused — ADM-13 does not make it a condition (ADM-72)',
    );
  }

  // ── the baseline is the Admin's, and editing it does not rewrite history ──
  //
  // G-113, ADM-80. The seventeen used to be `values` rows inside
  // `seed_onboarding`, changeable only by migration.
  console.log('\nB. The baseline is configuration, not code');
  {
    const baseline = await rest('GET', 'projects',
      `onboarding_baseline?organization_id=eq.${ORG}&select=key,position,is_active&order=position`);
    const rows = Array.isArray(baseline.json) ? baseline.json : [];
    check(rows.length === 17, 'the organization owns a copy of the seventeen', `${rows.length}`);
    check(
      rows.some((r) => r.key === 'client_identity_confirmed') && rows.some((r) => r.key === 'project_activated'),
      'and they are the same seventeen, not a new list',
    );

    const before = created.checklistProject;
    const beforeItems = await rest('GET', 'projects',
      `onboarding_items?project_id=eq.${before}&select=key`);
    const beforeKeys = (Array.isArray(beforeItems.json) ? beforeItems.json : []).map((r) => r.key);

    // Admin edits: retire one, add one.
    await rest('PATCH', 'projects',
      `onboarding_baseline?organization_id=eq.${ORG}&key=eq.kickoff_sent`, { is_active: false });
    const added = one(await rest('POST', 'projects', 'onboarding_baseline', {
      organization_id: ORG, position: 90, key: 'zztest_probe_item', label: 'Probe item',
    }));
    created.baselineProbe = added?.id;

    const account = created.accounts[0];
    const fresh = one(await rest('POST', 'projects', 'projects', {
      organization_id: ORG, client_account_id: account, name: 'zztest after baseline edit', status: 'planning',
    }));
    created.projects.push(fresh.id);
    await rest('POST', 'projects', 'rpc/seed_onboarding', { p_project_id: fresh.id });

    const afterItems = await rest('GET', 'projects', `onboarding_items?project_id=eq.${fresh.id}&select=key`);
    const afterKeys = (Array.isArray(afterItems.json) ? afterItems.json : []).map((r) => r.key);

    check(afterKeys.includes('zztest_probe_item'), 'a new project starts from the edited baseline');
    check(!afterKeys.includes('kickoff_sent'), 'and a retired item is not seeded onto it');

    // The conservative sub-choice, proved rather than asserted.
    const stillThere = await rest('GET', 'projects', `onboarding_items?project_id=eq.${before}&select=key`);
    const stillKeys = (Array.isArray(stillThere.json) ? stillThere.json : []).map((r) => r.key);
    // Compared as a set rather than by naming a key: an earlier section of
    // this script deletes an item, so asserting a specific one is present
    // depends on work happening elsewhere. What matters is that the list is
    // *identical* — the edit changed nothing about it, whatever it contained.
    const same =
      stillKeys.length === beforeKeys.length &&
      [...beforeKeys].sort().join('|') === [...stillKeys].sort().join('|');
    check(
      same,
      'the project that already had a checklist is untouched — a baseline edit never rewrites history',
      `${beforeKeys.length} before, ${stillKeys.length} after`,
    );
    check(
      !stillKeys.includes('zztest_probe_item'),
      'and it does not gain the new item either',
    );

    const log = await rest('GET', 'audit',
      'audit_log?subject_type=eq.onboarding_baseline&select=action&order=created_at.desc&limit=20');
    const actions = (Array.isArray(log.json) ? log.json : []).map((r) => r.action);
    check(actions.includes('onboarding_baseline.retired'), 'retiring an item is audited', actions.slice(0, 4).join(', '));
    check(actions.includes('onboarding_baseline.added'), 'and so is adding one');
  }

  // ── B2. the seed is internal infrastructure, not a cross-tenant RPC ──────
  //
  // install_default_onboarding_baseline is SECURITY DEFINER and writes the org
  // it is handed; its only legitimate caller is the org-creation trigger. It was
  // granted to PUBLIC, so an authenticated user could re-seed ANOTHER org's
  // baseline — re-adding the default items a victim admin had just removed. It is
  // now revoked from end-users (20260815350000); the DEFINER trigger still seeds
  // a new org, which every other check in this file relies on.
  console.log('\nB2. The baseline seed is internal, not a public RPC');
  {
    const owner = mint(randomUUID(), 'owner');
    const forced = await call(owner, 'POST', 'projects', 'rpc/install_default_onboarding_baseline', { p_organization_id: ORG });
    check(
      forced.status >= 400,
      'an authenticated user cannot call the baseline seed directly to re-seed any organization',
      `status ${forced.status}, ${String(forced.text ?? '').slice(0, 100)}`,
    );
  }
} finally {
  if (created.baselineProbe) {
    await rest('DELETE', 'projects', `onboarding_baseline?id=eq.${created.baselineProbe}`);
  }
  await rest('PATCH', 'projects',
    `onboarding_baseline?organization_id=eq.${ORG}&key=eq.kickoff_sent`, { is_active: true });
  // G-110 made raising an internal-audience approval emit `approval.requested`.
  // Before that, raising one emitted nothing, so this script had nothing to
  // clear — and verify-milestone-unlock asserts the deployment holds **zero**
  // outbox events and zero jobs. Without this it fails on rows this script
  // left, which is exactly what CI caught.
  await rest('DELETE', 'core', 'outbox_events?subject_type=eq.approval_request');
  for (const id of created.projects) {
    await rest('DELETE', 'projects', `onboarding_items?project_id=eq.${id}`);
    await rest('DELETE', 'projects', `projects?id=eq.${id}`);
  }
  for (const id of created.accounts) await rest('DELETE', 'core', `client_accounts?id=eq.${id}`);
  for (const id of created.users) {
    await rest('DELETE', 'core', `memberships?user_id=eq.${id}`);
    await rest('DELETE', 'core', `users?id=eq.${id}`);
    await fetch(`${URL_BASE}/auth/v1/admin/users/${id}`, {
      method: 'DELETE',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
      cache: 'no-store',
    });
  }
}

console.log(`\n${checks} checks`);

if (failures === 0) {
  console.log('\x1b[32m✔ The workspace is built, and the checklist blocks nothing\x1b[0m\n');
  process.exit(0);
}

console.error(`\x1b[31m✖ ${failures} failure(s)\x1b[0m\n`);
process.exit(1);
