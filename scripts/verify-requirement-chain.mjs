#!/usr/bin/env node
/**
 * The chain from a requirement to a task, verified against a real database.
 *
 * Gap G-020, decision ADM-16 — *"break approved requirements into modules,
 * features and tasks; the breakdown is automatic"*.
 *
 * What it proves:
 *
 *   1. The whole chain is written in one call, with the requirement version
 *      recorded on every module, feature and task. That provenance is the
 *      point: without it, "has everything the client asked for been built" has
 *      no answer, and that is the question every scope dispute is made of.
 *   2. A requirement that is **not accepted** is refused. A proposal an agent
 *      extracted and nobody confirmed is not a scope to build against.
 *   3. A requirement from **another engagement** is refused — the check that
 *      stops a plausible-looking breakdown of the wrong client's scope.
 *   4. A project with **no opportunity** is refused rather than waved through:
 *      "we cannot tell" must not resolve to "go ahead".
 *   5. Breaking the same version down twice answers rather than duplicating,
 *      because ADM-16 makes this automatic and a retrying agent is ordinary.
 *   6. An existing module of the same name is adopted, not duplicated.
 *   7. Coverage reports what was planned and what is finished.
 *
 *   node scripts/verify-requirement-chain.mjs
 */

import { randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false, jwt: false });
await announceTarget(target, 'verify-requirement-chain');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = 'zztest-chain';
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
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
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

const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);

const breakDown = (projectId, versionId, plan) =>
  rest('POST', 'projects', 'rpc/break_down_requirement', {
    p_project_id: projectId,
    p_requirement_version_id: versionId,
    p_breakdown: plan,
  });

const created = { projects: [], leads: [], accounts: [], opportunities: [], conversations: [] };

/** A whole engagement: lead → conversation → requirement → deal → project. */
async function engagement(name, { accepted = true, withOpportunity = true } = {}) {
  const lead = one(
    await rest('POST', 'crm', 'leads', {
      organization_id: ORG, source: 'manual', title: `${MARKER} ${name}`, status: 'new',
    }),
  );
  created.leads.push(lead.id);

  const conversation = one(
    await rest('POST', 'crm', 'conversations', {
      organization_id: ORG, lead_id: lead.id, channel: 'whatsapp', kind: 'direct', status: 'active',
    }),
  );
  created.conversations.push(conversation.id);

  const version = one(
    await rest('POST', 'crm', 'requirement_versions', {
      organization_id: ORG, conversation_id: conversation.id, version: 1,
      source: 'human', status: accepted ? 'accepted' : 'proposed', payload: {},
    }),
  );

  const account = one(
    await rest('POST', 'core', 'client_accounts', { organization_id: ORG, name: `${MARKER} ${name}` }),
  );
  created.accounts.push(account.id);

  let opportunityId = null;
  if (withOpportunity) {
    const opportunity = one(
      await rest('POST', 'sales', 'opportunities', {
        organization_id: ORG, lead_id: lead.id, name: `${MARKER} ${name}`,
        stage: 'discovery', value_minor: 0, currency: 'INR',
      }),
    );
    created.opportunities.push(opportunity.id);
    opportunityId = opportunity.id;
  }

  const project = one(
    await rest('POST', 'projects', 'projects', {
      organization_id: ORG, client_account_id: account.id,
      ...(opportunityId ? { opportunity_id: opportunityId } : {}),
      name: `${MARKER} ${name}`, status: 'planning',
    }),
  );
  created.projects.push(project.id);

  return { leadId: lead.id, versionId: version.id, projectId: project.id };
}

const PLAN = [
  {
    name: 'Ordering',
    description: 'Everything between a hungry customer and a paid order',
    features: [
      {
        name: 'Saved basket',
        tasks: [
          { title: 'Cart reducer', estimateHours: 4, priority: 'p1' },
          { title: 'Cart UI' },
        ],
      },
    ],
  },
  { name: 'Payments', features: [{ name: 'UPI', tasks: [{ title: 'Webhook' }] }] },
];

console.log('\n\x1b[1mAgencyOS — the chain from a requirement to a task (G-020)\x1b[0m');

try {
  // ── 2. not accepted ─────────────────────────────────────────────────────
  console.log('\n1. A proposal nobody confirmed is not a scope');
  {
    const e = await engagement('proposed', { accepted: false });
    const refused = one(await breakDown(e.projectId, e.versionId, PLAN));
    check(
      refused?.outcome === 'not_approved',
      'an unaccepted requirement version is refused',
      `outcome ${refused?.outcome}`,
    );

    const modules = (await rest('GET', 'projects', `modules?project_id=eq.${e.projectId}&select=id`)).json ?? [];
    check(modules.length === 0, 'and nothing was written', `${modules.length} modules`);
  }

  // ── 1. the chain, with provenance ───────────────────────────────────────
  console.log('\n2. The chain is written in one call, and every row says why');
  {
    const e = await engagement('main');
    const done = one(await breakDown(e.projectId, e.versionId, PLAN));
    check(
      done?.outcome === 'broken_down' && done?.modules === 2 && done?.features === 2 && done?.tasks === 3,
      'two modules, two features, three tasks',
      `${done?.outcome} ${done?.modules}/${done?.features}/${done?.tasks}`,
    );

    const tasks = (
      await rest('GET', 'projects', `tasks?project_id=eq.${e.projectId}&select=title,priority,estimate_hours,module_id,feature_id,requirement_version_id&order=title.asc`)
    ).json ?? [];

    check(
      tasks.length === 3 && tasks.every((t) => t.requirement_version_id === e.versionId),
      'every task names the requirement version it came from',
      `${tasks.filter((t) => t.requirement_version_id === e.versionId).length}/${tasks.length}`,
    );
    check(
      tasks.every((t) => t.module_id && t.feature_id),
      'and sits under both a module and a feature',
    );

    const reducer = tasks.find((t) => t.title === 'Cart reducer');
    check(
      reducer?.priority === 'p1' && Number(reducer?.estimate_hours) === 4,
      'a task carries the priority and estimate the plan gave it',
      `${reducer?.priority}/${reducer?.estimate_hours}`,
    );
    const ui = tasks.find((t) => t.title === 'Cart UI');
    check(
      ui?.priority === 'p2',
      'and one that gave none falls back rather than failing the plan',
      `${ui?.priority}`,
    );

    const features = (
      await rest('GET', 'projects', `features?project_id=eq.${e.projectId}&select=name,requirement_version_id,module_id`)
    ).json ?? [];
    check(
      features.length === 2 && features.every((f) => f.requirement_version_id === e.versionId),
      'features carry the provenance too',
      `${features.length}`,
    );

    // ── 5. twice ──────────────────────────────────────────────────────────
    const again = one(await breakDown(e.projectId, e.versionId, PLAN));
    check(
      again?.outcome === 'already_broken_down',
      'breaking the same version down twice answers rather than duplicating',
      `outcome ${again?.outcome}`,
    );
    const afterTasks = (await rest('GET', 'projects', `tasks?project_id=eq.${e.projectId}&select=id`)).json ?? [];
    check(afterTasks.length === 3, 'and the plan is still three tasks', `${afterTasks.length}`);

    // ── 7. coverage ───────────────────────────────────────────────────────
    await rest('PATCH', 'projects', `tasks?project_id=eq.${e.projectId}&title=eq.Webhook`, {
      status: 'done',
      completed_at: new Date().toISOString(),
    });

    const coverage = one(
      await rest('POST', 'projects', 'rpc/requirement_coverage', { p_project_id: e.projectId }),
    );
    check(
      coverage?.tasks === 3 && coverage?.tasks_done === 1,
      'coverage reports what was planned and what is finished',
      `${coverage?.tasks_done}/${coverage?.tasks}`,
    );
    check(
      coverage?.modules === 2 && coverage?.features === 2,
      'across every level of the chain',
      `${coverage?.modules}/${coverage?.features}`,
    );

    created.main = e;
  }

  // ── 3. another engagement's requirement ─────────────────────────────────
  console.log('\n3. A requirement from another engagement is refused');
  {
    const other = await engagement('other');
    const crossed = one(await breakDown(created.main.projectId, other.versionId, PLAN));
    check(
      crossed?.outcome === 'wrong_project',
      'the wrong client’s scope cannot be planned into this project',
      `outcome ${crossed?.outcome}`,
    );

    const leaked = (
      await rest('GET', 'projects', `modules?project_id=eq.${created.main.projectId}&requirement_version_id=eq.${other.versionId}&select=id`)
    ).json ?? [];
    check(leaked.length === 0, 'and nothing of theirs was written here', `${leaked.length} rows`);
  }

  // ── 4. a project with nothing to check against ──────────────────────────
  console.log('\n4. "We cannot tell" does not resolve to "go ahead"');
  {
    const unlinked = await engagement('unlinked', { withOpportunity: false });
    const refused = one(await breakDown(unlinked.projectId, unlinked.versionId, PLAN));
    check(
      refused?.outcome === 'unlinked_project',
      'a project with no opportunity has no engagement to verify against, and is refused',
      `outcome ${refused?.outcome}`,
    );
  }

  // ── 6. an existing module is adopted ────────────────────────────────────
  console.log('\n5. A module somebody already made is adopted, not duplicated');
  {
    const e = await engagement('adopt');
    await rest('POST', 'projects', 'modules', {
      organization_id: ORG, project_id: e.projectId, name: 'Ordering', position: 0,
    });

    const done = one(await breakDown(e.projectId, e.versionId, PLAN));
    check(done?.outcome === 'broken_down', 'the breakdown still runs', `outcome ${done?.outcome}`);

    const modules = (
      await rest('GET', 'projects', `modules?project_id=eq.${e.projectId}&name=eq.Ordering&select=id`)
    ).json ?? [];
    check(modules.length === 1, 'and there is one "Ordering", not two', `${modules.length}`);

    const features = (
      await rest('GET', 'projects', `features?module_id=eq.${modules[0]?.id}&select=name`)
    ).json ?? [];
    check(
      features.length === 1 && features[0]?.name === 'Saved basket',
      'whose features were written into the module that already existed',
      `${features.length}`,
    );
  }

  // ── the plan is data, and bad data does not half-write ──────────────────
  console.log('\n6. A malformed plan writes nothing at all');
  {
    const e = await engagement('malformed');
    const empty = one(await breakDown(e.projectId, e.versionId, []));
    check(empty?.outcome === 'empty', 'an empty plan is refused', `outcome ${empty?.outcome}`);

    const nameless = one(await breakDown(e.projectId, e.versionId, [{ description: 'no name' }]));
    check(
      nameless?.outcome === 'empty',
      'and so is one whose modules have no names',
      `outcome ${nameless?.outcome}`,
    );

    const modules = (await rest('GET', 'projects', `modules?project_id=eq.${e.projectId}&select=id`)).json ?? [];
    check(modules.length === 0, 'nothing was written by either', `${modules.length} modules`);
  }
} finally {
  for (const id of created.projects) {
    await rest('DELETE', 'projects', `tasks?project_id=eq.${id}`);
    await rest('DELETE', 'projects', `features?project_id=eq.${id}`);
    await rest('DELETE', 'projects', `modules?project_id=eq.${id}`);
    await rest('DELETE', 'projects', `projects?id=eq.${id}`);
  }
  for (const id of created.opportunities) await rest('DELETE', 'sales', `opportunities?id=eq.${id}`);
  for (const id of created.conversations) {
    await rest('DELETE', 'crm', `requirement_versions?conversation_id=eq.${id}`);
    await rest('DELETE', 'crm', `conversations?id=eq.${id}`);
  }
  for (const id of created.leads) await rest('DELETE', 'crm', `leads?id=eq.${id}`);
  for (const id of created.accounts) await rest('DELETE', 'core', `client_accounts?id=eq.${id}`);
  void randomUUID;
}

console.log(`\n${checks} checks`);

if (failures === 0) {
  console.log('\x1b[32m✔ Every task says which requirement asked for it\x1b[0m\n');
  process.exit(0);
}

console.error(`\x1b[31m✖ ${failures} failure(s)\x1b[0m\n`);
process.exit(1);
