#!/usr/bin/env node
/**
 * Modules and test access, verified against a real database.
 *
 * Phase 12, gaps G-024 and G-025. Two kinds of rule are checked here and they
 * fail differently:
 *
 *   Cross-wiring. `module_id` and `project_id` are separate references, so
 *   nothing in a foreign key stops a task naming a module from another
 *   project — where it would then appear in that project's progress. This is
 *   the shape D22 was, and it is refused by a trigger.
 *
 *   Test access without the credentials. Directive §17 asks for test access
 *   with a build and §22 forbids secrets in ordinary storage; the column
 *   records how a client gets in, and refuses the three shapes somebody
 *   actually pastes when they mean well and are in a hurry.
 *
 *   node scripts/verify-modules.mjs
 */

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

// This script needs a service key: it drives the database directly and
// never calls the job runner, so CRON_SECRET is not required of it.
const target = await resolveTarget(fail, { cron: false, anon: false });
await announceTarget(target, 'verify-modules');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = 'zztest-g024';
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
const created = {};

console.log('\n\x1b[1mAgencyOS — modules and test access (G-024, G-025)\x1b[0m');

try {
  const account = one(await rest('POST', 'core', 'client_accounts', { organization_id: ORG, name: `${MARKER} client` }));
  created.account = account?.id;

  const mk = async (name) =>
    one(await rest('POST', 'projects', 'projects', {
      organization_id: ORG, client_account_id: created.account, name, status: 'active',
    }))?.id;

  created.projectA = await mk(`${MARKER} A`);
  created.projectB = await mk(`${MARKER} B`);
  if (!created.projectA || !created.projectB) throw new Error('could not create the project fixtures');

  const backend = one(await rest('POST', 'projects', 'modules', {
    organization_id: ORG, project_id: created.projectA, name: 'Backend', position: 0,
  }));
  // A second module with no work at all, so §4 can check that a module with
  // nothing in it still reports itself rather than vanishing from progress.
  await rest('POST', 'projects', 'modules', {
    organization_id: ORG, project_id: created.projectA, name: 'Vendor panel', position: 1,
  });
  const otherModule = one(await rest('POST', 'projects', 'modules', {
    organization_id: ORG, project_id: created.projectB, name: 'Backend', position: 0,
  }));

  console.log('\n1. A module belongs to one project, and so does its work');
  {
    check(!!backend?.id && !!otherModule?.id, 'two projects may each have a module of the same name', `${backend?.id}`);

    const duplicate = await rest('POST', 'projects', 'modules', {
      organization_id: ORG, project_id: created.projectA, name: 'Backend',
    });
    check(duplicate.status === 409, 'but one project cannot have it twice', `status ${duplicate.status}`);

    const crossed = await rest('POST', 'projects', 'tasks', {
      organization_id: ORG, project_id: created.projectA, module_id: otherModule.id,
      title: `${MARKER} crossed task`,
    });
    check(
      crossed.status >= 400 && crossed.text.includes('another project'),
      'a task cannot name a module from another project',
      `status ${crossed.status}, ${crossed.text.slice(0, 100)}`,
    );

    const crossedDeliverable = one(await rest('POST', 'projects', 'rpc/add_deliverable', {
      p_project_id: created.projectA, p_kind: 'build', p_title: 'Crossed build',
      p_module_id: otherModule.id,
    }));
    check(
      crossedDeliverable?.outcome === 'wrong_module',
      'and neither can a build',
      `outcome ${crossedDeliverable?.outcome}`,
    );
  }

  console.log('\n2. Test access says how to get in, never what the key is');
  {
    for (const [label, value] of [
      ['a pasted password', 'login with demo@x.test password: hunter2'],
      ['a pasted PIN', 'use the demo account, pin: 4821'],
      ['a pasted key', 'x-api-key: sk_live_abcdefghijklmnop'],
    ]) {
      const refused = await rest('POST', 'projects', 'rpc/add_deliverable', {
        p_project_id: created.projectA, p_kind: 'build', p_title: `Build with ${label}`,
        p_test_access_method: value,
      });
      // Named, not merely "something went wrong": this is the third refusal
      // check in this repository that would have passed while proving nothing
      // if it only asked whether an error came back.
      check(
        refused.status >= 400 && refused.text.includes('deliverables_test_access_shape'),
        `${label} is refused by the constraint that exists for it`,
        `status ${refused.status}, ${refused.text.slice(0, 90)}`,
      );
    }

    const fine = one(await rest('POST', 'projects', 'rpc/add_deliverable', {
      p_project_id: created.projectA, p_kind: 'build', p_title: 'Customer APK',
      p_test_access_method: 'Demo account shared in 1Password; no signup needed',
      p_module_id: backend.id,
    }));
    check(fine?.outcome === 'created', 'a description of how to get in is recorded', `outcome ${fine?.outcome}`);
    created.build = fine?.deliverable_id;
  }

  console.log('\n3. What was shown to the client does not change afterwards');
  {
    const rewritten = await rest('PATCH', 'projects', `deliverables?id=eq.${created.build}`, {
      test_access_method: 'quietly different instructions',
    });
    check(
      rewritten.status >= 400,
      'the test access on a recorded build is immutable, like everything else on it',
      `status ${rewritten.status}, ${rewritten.text.slice(0, 90)}`,
    );
  }

  console.log('\n4. Where the project actually is');
  {
    for (const [status, count] of [['done', 2], ['in_progress', 1]]) {
      for (let i = 0; i < count; i += 1) {
        await rest('POST', 'projects', 'tasks', {
          organization_id: ORG, project_id: created.projectA, module_id: backend.id,
          title: `${MARKER} ${status} ${i}`, status,
        });
      }
    }
    await rest('POST', 'qa', 'defects', {
      organization_id: ORG, project_id: created.projectA, deliverable_id: created.build,
      severity: 'minor', title: `${MARKER} defect`, reproduction: 'Tap the thing twice.',
    });

    const progress = await rest('POST', 'projects', 'rpc/module_progress', { p_project_id: created.projectA });
    const row = (progress.json ?? []).find((m) => m.name === 'Backend');

    check(Number(row?.tasks_total) === 3, 'a module counts its own tasks', `${row?.tasks_total}`);
    check(Number(row?.tasks_done) === 2, 'and how many are done', `${row?.tasks_done}`);
    check(Number(row?.open_defects) === 1, 'and the open defects against builds of it', `${row?.open_defects}`);

    const empty = (progress.json ?? []).find((m) => m.name === 'Vendor panel');
    check(Number(empty?.tasks_total) === 0, 'a module with no work says so rather than being absent', `${empty?.tasks_total}`);
    check(
      (progress.json ?? [])[0]?.name === 'Backend',
      'and the order is the plan’s, not the alphabet’s',
      `${(progress.json ?? [])[0]?.name}`,
    );
  }
} finally {
  for (const p of [created.projectA, created.projectB].filter(Boolean)) {
    await rest('DELETE', 'qa', `defects?project_id=eq.${p}`);
    await rest('DELETE', 'projects', `tasks?project_id=eq.${p}`);
    await rest('DELETE', 'projects', `deliverables?project_id=eq.${p}`);
    await rest('DELETE', 'projects', `modules?project_id=eq.${p}`);
    await rest('DELETE', 'projects', `projects?id=eq.${p}`);
  }
  if (created.account) await rest('DELETE', 'core', `client_accounts?id=eq.${created.account}`);
}

console.log(`\n${checks} checks`);

if (failures === 0) {
  console.log('\x1b[32m✔ Every piece knows its project, and no key was written down\x1b[0m\n');
  process.exit(0);
}

console.error(`\x1b[31m✖ ${failures} failure(s)\x1b[0m\n`);
process.exit(1);
