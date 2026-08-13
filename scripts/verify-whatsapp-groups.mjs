#!/usr/bin/env node
/**
 * The two WhatsApp groups, verified against a real database — G-015, G-109.
 *
 * The structural half is in tests/whatsapp-groups.test.ts. What only Postgres
 * can show is the half that matters:
 *
 *   • a project group without a project, and a direct thread without a lead,
 *     are refused by a CHECK rather than by a convention
 *   • one live client group per project, and one live approval group per
 *     organization, held by an index a concurrent caller cannot dodge
 *   • one WhatsApp group id across the whole deployment, so two tenants cannot
 *     claim the same group — the D22 shape, one table along
 *   • an abandoned group does not block its successor
 *   • the function tells "already linked" apart from "somebody else has it"
 *
 *   npm run db:verify:groups
 */

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false, jwt: false });
await announceTarget(target, 'verify-whatsapp-groups');

const URL_BASE = target.url;
const KEY = target.serviceKey;

const MARKER = 'zztest-groups';

let failures = 0;
let checks = 0;

const check = (condition, description, detail = '') => {
  checks += 1;
  if (condition) return console.log(`  \x1b[32m✓\x1b[0m ${description}`);
  failures += 1;
  console.error(`  \x1b[31m✗\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
};

const section = (m) => console.log(`\n${m}`);

async function request(method, schema, path, body) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      ...(method === 'GET' ? { 'Accept-Profile': schema } : { 'Content-Profile': schema }),
      Prefer: 'return=representation',
    },
    cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* reported through text */
  }
  return { status: res.status, ok: res.ok, json, text };
}

const rest = (method, schema, path, body) => request(method, schema, path, body);
const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);

const link = (kind, externalRef, extra = {}) =>
  rest('POST', 'crm', 'rpc/link_whatsapp_group', {
    p_organization_id: ORG,
    p_kind: kind,
    p_external_ref: externalRef,
    ...extra,
  });

/** The seeded demo organization — see verify-approvals.mjs on why not a new one. */
const ORG = '00000000-0000-4000-8000-000000000001';

console.log('\n\x1b[1mAgencyOS — the two WhatsApp groups (G-015, G-109)\x1b[0m');

const created = { conversations: [], projects: [], clients: [] };

try {
  // A project to hang a client group on.
  const client = one(
    await rest('POST', 'core', 'client_accounts', {
      organization_id: ORG,
      name: `${MARKER} client`,
    }),
  );
  created.clients.push(client?.id);

  const project = one(
    await rest('POST', 'projects', 'projects', {
      organization_id: ORG,
      client_account_id: client?.id,
      name: `${MARKER} project`,
      status: 'planning',
    }),
  );
  created.projects.push(project?.id);

  if (!project?.id) fail('could not create a project to group');

  // ── 1. the shapes that must be unrepresentable ──────────────────────────
  section('1. A group carries exactly the links its kind allows');
  {
    const noProject = await rest('POST', 'crm', 'conversations', {
      organization_id: ORG,
      kind: 'project_group',
      channel: 'whatsapp',
      external_ref: `${MARKER}-shape-1`,
    });
    check(
      !noProject.ok,
      'a project group with no project is refused',
      `status ${noProject.status}`,
    );

    const groupWithLead = await rest('POST', 'crm', 'conversations', {
      organization_id: ORG,
      kind: 'internal_group',
      channel: 'whatsapp',
      project_id: project.id,
      external_ref: `${MARKER}-shape-2`,
    });
    check(
      !groupWithLead.ok,
      'an internal group naming a project is refused',
      `status ${groupWithLead.status}`,
    );

    const directNoLead = await rest('POST', 'crm', 'conversations', {
      organization_id: ORG,
      kind: 'direct',
      channel: 'manual',
    });
    check(
      !directNoLead.ok,
      'a direct thread without its lead is still refused — relaxing NOT NULL did not relax this',
      `status ${directNoLead.status}`,
    );
  }

  // ── 2. one group of each kind ───────────────────────────────────────────
  section('2. One live group of each kind');
  {
    const first = one(await link('project_group', `${MARKER}-proj-a`, { p_project_id: project.id }));
    check(first?.outcome === 'linked', 'a project group links', `outcome: ${first?.outcome}`);
    created.conversations.push(first?.conversation_id);

    const second = one(
      await link('project_group', `${MARKER}-proj-b`, { p_project_id: project.id }),
    );
    check(
      second?.outcome === 'already_linked',
      'a second group for the same project is answered, not created',
      `outcome: ${second?.outcome}`,
    );
    check(
      second?.conversation_id === first?.conversation_id,
      'and it answers with the group that already exists',
    );

    const internal = one(await link('internal_group', `${MARKER}-int-a`));
    check(internal?.outcome === 'linked', 'an internal group links', `outcome: ${internal?.outcome}`);
    created.conversations.push(internal?.conversation_id);

    const secondInternal = one(await link('internal_group', `${MARKER}-int-b`));
    check(
      secondInternal?.outcome === 'already_linked',
      'a second approval group for the organization is answered, not created',
      `outcome: ${secondInternal?.outcome}`,
    );
  }

  // ── 3. a group id belongs to one conversation ───────────────────────────
  section('3. One WhatsApp group id, one conversation');
  {
    // The project already has a group, so this must be refused for being a
    // taken *group id* rather than for the project — which is exactly the
    // distinction the constraint name decides.
    const otherProject = one(
      await rest('POST', 'projects', 'projects', {
        organization_id: ORG,
        client_account_id: created.clients[0],
        name: `${MARKER} project two`,
        status: 'planning',
      }),
    );
    created.projects.push(otherProject?.id);

    const taken = one(
      await link('project_group', `${MARKER}-proj-a`, { p_project_id: otherProject?.id }),
    );
    check(
      taken?.outcome === 'group_taken',
      'a group id already linked elsewhere is refused as taken, not as already-linked',
      `outcome: ${taken?.outcome}`,
    );
    check(
      taken?.conversation_id === null,
      'and it names no conversation, because the caller owns none',
    );
  }

  // ── 4. an abandoned group does not block its successor ──────────────────
  section('4. A group the agency left');
  {
    const first = created.conversations[0];
    await rest('PATCH', 'crm', `conversations?id=eq.${first}`, { status: 'abandoned' });

    const replacement = one(
      await link('project_group', `${MARKER}-proj-c`, { p_project_id: created.projects[0] }),
    );
    check(
      replacement?.outcome === 'linked',
      'a replacement links once the old group is abandoned',
      `outcome: ${replacement?.outcome}`,
    );
    created.conversations.push(replacement?.conversation_id);

    const live = await rest(
      'GET',
      'crm',
      `conversations?project_id=eq.${created.projects[0]}&kind=eq.project_group&status=neq.abandoned&select=id`,
    );
    check(
      (live.json ?? []).length === 1,
      'and the project still has exactly one live group',
      `found ${(live.json ?? []).length}`,
    );
  }

  // ── 5. a bad kind is answered, not raised ───────────────────────────────
  section('5. A kind that is not a group');
  {
    const bad = one(await link('direct', `${MARKER}-nope`));
    check(bad?.outcome === 'bad_kind', 'linking a direct thread as a group is refused', `outcome: ${bad?.outcome}`);
  }

  // ── 6. G-026 — a project starts when it is actually ready ──────────────
  //
  // ADM-13's three conditions, against a real database. The group linked above
  // is one of them, which is why this lives here rather than in a script of its
  // own: the readiness answer is only interesting once something is true.
  section('6. G-026 — the conditions for officially starting');
  {
    const start = (id, reason) =>
      rest('POST', 'projects', 'rpc/start_project', {
        p_project_id: id,
        ...(reason ? { p_override_reason: reason } : {}),
      });

    const readiness = async (id) =>
      one(await rest('POST', 'projects', 'rpc/start_readiness', { p_project_id: id }));

    // The project from section 2 has a live group and nothing else.
    const target = created.projects[0];
    await rest('PATCH', 'projects', `projects?id=eq.${target}`, { status: 'onboarding' });

    const ready = await readiness(target);
    check(
      ready?.group_linked === true,
      'the group linked earlier is seen as linked',
      JSON.stringify(ready ?? null),
    );
    check(
      ready?.advance_verified === false && ready?.requirement_approved === false,
      'and the other two conditions are honestly unmet',
      JSON.stringify(ready ?? null),
    );

    const refusedRes = await start(target);
    const refused = one(refusedRes);
    check(
      refused?.outcome === 'not_ready',
      'starting it is refused',
      // The response body, not just the parsed outcome: an RPC that errors
      // gives `undefined` here, and "outcome: undefined" says nothing about why.
      `outcome: ${refused?.outcome} — ${refusedRes.status} ${refusedRes.text.slice(0, 200)}`,
    );
    check(
      Array.isArray(refused?.unmet) &&
        refused.unmet.includes('advance_not_verified') &&
        refused.unmet.includes('no_approved_requirement') &&
        !refused.unmet.includes('no_whatsapp_group'),
      'and it names exactly what is missing, not that something is',
      JSON.stringify(refused?.unmet ?? null),
    );

    const stillOnboarding = one(
      await rest('GET', 'projects', `projects?id=eq.${target}&select=status,started_at`),
    );
    check(
      stillOnboarding?.status === 'onboarding' && stillOnboarding?.started_at === null,
      'a refused start changes nothing at all',
      JSON.stringify(stillOnboarding ?? null),
    );

    // ── the override ───────────────────────────────────────────────────────
    const overridden = one(await start(target, 'ZZTEST advance agreed on a call'));
    check(overridden?.outcome === 'started', 'the owner may start it anyway', `outcome: ${overridden?.outcome}`);
    check(overridden?.overridden === true, 'and the result says it was an override');

    const started = one(
      await rest(
        'GET',
        'projects',
        `projects?id=eq.${target}&select=status,started_at,start_override_reason`,
      ),
    );
    check(started?.status === 'active', 'the project is active', `status: ${started?.status}`);
    check(started?.started_at !== null, 'and records when it started');
    check(
      started?.start_override_reason === 'ZZTEST advance agreed on a call',
      'and why it was allowed to',
      `reason: ${started?.start_override_reason}`,
    );

    // G-093: nobody wrote this audit row by hand.
    const history = await rest(
      'GET',
      'audit',
      `audit_log?subject_id=eq.${target}&action=eq.project.status_changed&select=before,after&order=id.desc&limit=1`,
    );
    // order=id.desc&limit=1 rather than taking the last element: PostgREST
    // returns rows in no particular order without it, so "the last one" was
    // whichever the planner handed back — and it handed back planning →
    // onboarding once the table grew a column. A latent flake from the run
    // that added this check.
    const entry = (history.json ?? [])[0];
    check(
      entry?.after?.status === 'active' && entry?.before?.status === 'onboarding',
      'the trigger recorded the transition without anybody asking it to',
      JSON.stringify({ before: entry?.before?.status, after: entry?.after?.status }),
    );
    check(
      entry?.after?.start_override_reason === 'ZZTEST advance agreed on a call',
      'and the override reason is in the trail because it is a column, not a note',
    );

    const again = one(await start(target));
    check(again?.outcome === 'already_active', 'starting it twice is answered', `outcome: ${again?.outcome}`);
  }

} catch (error) {
  check(false, `unexpected failure: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  section('6. Cleanup');
  for (const id of created.conversations.filter(Boolean)) {
    await rest('DELETE', 'crm', `conversations?id=eq.${id}`);
  }
  await rest('DELETE', 'crm', `conversations?external_ref=like.${MARKER}%25`);
  for (const id of created.projects.filter(Boolean)) {
    await rest('DELETE', 'projects', `projects?id=eq.${id}`);
  }
  for (const id of created.clients.filter(Boolean)) {
    await rest('DELETE', 'core', `client_accounts?id=eq.${id}`);
  }
  const left = await rest('GET', 'projects', `projects?name=like.${MARKER}%25&select=id`);
  check((left.json ?? []).length === 0, 'test fixtures removed');
}

console.log(`\n${checks} checks`);

if (failures > 0) {
  console.error(`\n\x1b[31m✖ ${failures} check(s) failed\x1b[0m\n`);
  process.exit(1);
}
console.log('\n\x1b[32m✔ Both groups behave as the database promises\x1b[0m\n');
