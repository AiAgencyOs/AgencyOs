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
 *   3. An L2 agent may not either, because what autonomous means on this path
 *      needs a stated policy (G-101) and silently behaving as L1 would tell an
 *      operator something untrue about their own deployment.
 *   4. A disabled agent may not, whatever its level.
 *   5. Turning an agent down is an UPDATE, not a deploy — the point of the
 *      column, and the thing that was not true until now.
 *
 *   node scripts/verify-agent-autonomy.mjs
 */

import { randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

const target = await resolveTarget();
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
const startRun = () =>
  rest('POST', 'ai', 'agent_runs', {
    organization_id: ORG,
    agent_key: agentKey,
    trigger: `user:${randomUUID()}`,
    status: 'running',
  });

const setLevel = (level, enabled = true) =>
  rest('PATCH', 'ai', `agents?key=eq.${agentKey}`, { autonomy_level: level, enabled });

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

  console.log('\n3. L2 has no defined behaviour here, and says so');
  {
    await setLevel('L2');
    const run = await startRun();
    check(
      run.status >= 400 && run.text.includes('L2'),
      'an L2 agent is refused rather than quietly treated as L1',
      `status ${run.status}, ${run.text.slice(0, 140)}`,
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
