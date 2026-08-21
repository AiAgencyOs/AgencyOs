#!/usr/bin/env node
/**
 * Agent autonomy, verified against a real database.
 *
 * Gap G-041. The runner checks `mayAgentRun` and produces a settled job with a
 * readable reason; this checks the other half — that `ai.agent_runs` refuses a
 * run for an agent that may not act, whatever called it. D16's rule: the
 * database refuses what the application refuses, so a second caller cannot
 * skip the check by not knowing about it.
 *
 *   1. An L1 agent may record a run.
 *   2. An L0 agent may not — it is read-only by definition.
 *   3. An L2 agent is decided by the WORK: ADM-61 §2's four classes alone,
 *      §3's three brought to the internal group. A run that names no class is
 *      refused, because it cannot be checked against either list.
 *   4. A disabled agent may not, whatever its level.
 *   5. Turning an agent down is an UPDATE, not a deploy — the point of the
 *      column, and the thing that was not true until now.
 *
 *   node scripts/verify-agent-autonomy.mjs
 */

import { randomUUID } from 'node:crypto';

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
await announceTarget(target, 'verify-agent-autonomy');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = 'zztest_g041';
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
      apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json',
      'Accept-Profile': schema, 'Content-Profile': schema, Prefer: 'return=representation',
    },
    cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: parse(text), text };
}

const agentKey = `${MARKER}_agent`;

/** A run for the fixture agent. Refused or not is the whole question. */
/**
 * A run now says what kind of work it is (ADM-61 §2/§3), because the level
 * alone was never the rule. `draft` by default: it is §2 work, so it isolates
 * the level being tested from the class being tested.
 */
const startRun = (workClass = 'draft') =>
  rest('POST', 'ai', 'agent_runs', {
    organization_id: ORG,
    agent_key: agentKey,
    trigger: `user:${randomUUID()}`,
    status: 'running',
    work_class: workClass,
  });

/**
 * `disabled_reason` moves with `enabled` because the constraint added in
 * 20260814120002 requires it: `enabled = (disabled_reason is null)`. ADM-83's
 * reasoning is that an agent disabled for an unrecorded reason is one somebody
 * turns back on, and a test that flips the kill switch is exactly a caller that
 * would otherwise leave no reason behind.
 */
const setLevel = (level, enabled = true) =>
  rest('PATCH', 'ai', `agents?key=eq.${agentKey}`, {
    autonomy_level: level,
    enabled,
    disabled_reason: enabled ? null : 'Disabled by verify-agent-autonomy to exercise the kill switch',
  });

console.log('\n\x1b[1mAgencyOS — agent autonomy (G-041)\x1b[0m');

try {
  const created = await rest('POST', 'ai', 'agents', {
    key: agentKey,
    display_name: 'Autonomy fixture',
    autonomy_level: 'L1',
    enabled: true,
    default_model: 'stub-model',
  });
  if (created.status !== 201) throw new Error(`could not create the agent: ${created.text.slice(0, 200)}`);

  console.log('\n1. L1 proposes, and may act');
  {
    const run = await startRun();
    check(run.status === 201, 'an L1 agent records a run', `status ${run.status}, ${run.text.slice(0, 120)}`);
    if (run.status === 201) {
      await rest('DELETE', 'ai', `agent_runs?id=eq.${(run.json?.[0] ?? run.json).id}`);
    }
  }

  console.log('\n2. L0 is read-only');
  {
    await setLevel('L0');
    const run = await startRun();
    check(
      run.status >= 400 && run.text.includes('may not perform work'),
      'an L0 agent is refused by the database, not merely by the runner',
      `status ${run.status}, ${run.text.slice(0, 140)}`,
    );
  }

  console.log('\n3. L2 is decided by the work, not by the level');
  {
    // This section used to assert that L2 is refused, full stop. That was the
    // behaviour, and it was an approximation: ADM-61 §2 lets an L2 agent act
    // alone on four kinds of work and §3 makes it bring three others to the
    // internal group. A level-only guard could not tell them apart, so one
    // path's argument refused seven agents.
    await setLevel('L2');

    for (const work of ['read', 'draft', 'internal_plan', 'breakdown']) {
      const run = await startRun(work);
      check(
        run.status === 201,
        `an L2 agent acts alone on ${work} — ADM-61 §2`,
        `status ${run.status}, ${run.text.slice(0, 120)}`,
      );
      if (run.status === 201) {
        await rest('DELETE', 'ai', `agent_runs?id=eq.${(run.json?.[0] ?? run.json).id}`);
      }
    }

    for (const work of ['client_facing', 'money', 'delivery_approval']) {
      const run = await startRun(work);
      check(
        run.status >= 400 && run.text.includes('internal group'),
        `and brings ${work} to the internal group — ADM-61 §3`,
        `status ${run.status}, ${run.text.slice(0, 140)}`,
      );
    }

    const classless = await rest('POST', 'ai', 'agent_runs', {
      organization_id: ORG,
      agent_key: agentKey,
      trigger: `user:${randomUUID()}`,
      status: 'running',
    });
    check(
      classless.status >= 400 && classless.text.includes('what kind of work'),
      'and a run that does not say what work it is cannot be checked at all',
      `status ${classless.status}, ${classless.text.slice(0, 140)}`,
    );
  }

  console.log('\n4. The kill switch still works, at any level');
  {
    await setLevel('L1', false);
    const run = await startRun();
    check(
      run.status >= 400 && run.text.includes('disabled'),
      'a disabled agent is refused even at L1',
      `status ${run.status}, ${run.text.slice(0, 140)}`,
    );
  }

  console.log('\n5. Turning an agent down is an UPDATE, not a deploy');
  {
    // The whole point of the column, and the thing that was not true until
    // now: the same code path, two different answers, decided by a row.
    await setLevel('L1', true);
    const allowed = await startRun();
    check(allowed.status === 201, 'back at L1, the same call succeeds', `status ${allowed.status}`);
    if (allowed.status === 201) {
      await rest('DELETE', 'ai', `agent_runs?id=eq.${(allowed.json?.[0] ?? allowed.json).id}`);
    }

    await setLevel('L0');
    const refused = await startRun();
    check(
      refused.status >= 400,
      'and one UPDATE later, the identical call is refused',
      `status ${refused.status}`,
    );
  }
} finally {
  await rest('DELETE', 'ai', `agent_runs?agent_key=eq.${agentKey}`);
  await rest('DELETE', 'ai', `agents?key=eq.${agentKey}`);
}

console.log(`\n${checks} checks`);

if (failures === 0) {
  console.log('\x1b[32m✔ An agent does what its row says it may\x1b[0m\n');
  process.exit(0);
}

console.error(`\x1b[31m✖ ${failures} failure(s)\x1b[0m\n`);
process.exit(1);
