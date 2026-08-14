#!/usr/bin/env node
/**
 * The ceilings, verified against a real database.
 *
 * Gaps G-133 and G-134. Both controls existed as schema and neither was
 * connected to anything: `ai.agents.max_steps` and `max_cost_minor` had no
 * consumer, `ai.handoffs.depth` had no producer, and
 * `ai.agent_runs.budget_exceeded` — a terminal status named for exactly this —
 * had never been set by any code.
 *
 * The unit tests pin the application half and read the migration text. Neither
 * can show that the triggers actually fire, and a trigger that does not fire
 * is indistinguishable from one that does until something depends on it.
 *
 * What it proves:
 *
 *   1. A chain of handoffs stops at depth 8 **even though every caller passes
 *      depth = 0**, which is what the defect looked like.
 *   2. The stored depth is derived, not echoed.
 *   3. A run at its ceiling is left alone.
 *   4. A run past its step ceiling is forced `budget_exceeded` — including one
 *      that claims `succeeded`.
 *   5. The same for cost.
 *   6. The true usage is still recorded, rather than the write being refused.
 *
 *   node scripts/verify-agent-ceilings.mjs
 */

import { randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false });
await announceTarget(target, 'verify-agent-ceilings');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const AGENT = 'requirement_collector';

let failures = 0;
let checks = 0;

function check(condition, description, detail = '') {
  checks += 1;
  if (condition) return void console.log(`  \x1b[32m✓\x1b[0m ${description}`);
  failures += 1;
  console.error(`  \x1b[31m✗\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
}

async function rest(method, schema, path, body) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Prefer: 'return=representation',
      'Accept-Profile': schema,
      'Content-Profile': schema,
    },
    cache: 'no-store',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);

const org = one(await rest('GET', 'core', 'organizations?select=id&limit=1'))?.id;
if (!org) fail('no organization to run against');

const agent = one(await rest('GET', 'ai', `agents?key=eq.${AGENT}&select=max_steps,max_cost_minor`));
if (!agent) fail(`agent ${AGENT} is not seeded`);

const { max_steps: MAX_STEPS, max_cost_minor: MAX_COST } = agent;
console.log(`\n\x1b[1mAgencyOS — the ceilings hold (G-133, G-134)\x1b[0m`);
console.log(`  ${AGENT}: max_steps ${MAX_STEPS}, max_cost_minor ${MAX_COST}\n`);

const created = { handoffs: [], runs: [] };

try {
  // ── 1 & 2. depth is derived, and the chain stops ────────────────────────
  console.log('1. A chain stops, even when every caller says depth 0');
  {
    const correlation = randomUUID();
    const stored = [];
    let refusedAt = null;

    for (let i = 0; i < 12; i += 1) {
      const r = await rest('POST', 'ai', 'handoffs', {
        organization_id: org,
        correlation_id: correlation,
        from_agent: AGENT,
        to_agent: 'quality_assurance',
        objective: `probe ${i}`,
        // The defect, reproduced deliberately: the caller always says 0.
        depth: 0,
      });
      if (r.status >= 400) {
        refusedAt = i;
        check(
          /depth|loop, not progress/i.test(r.text),
          'and the refusal says why, rather than surfacing a bare constraint name',
          r.text.slice(0, 120),
        );
        break;
      }
      const row = one(r);
      created.handoffs.push(row.id);
      stored.push(row.depth);
    }

    check(refusedAt === 9, 'the tenth handoff in a correlation is refused', `refused at index ${refusedAt}`);
    check(
      JSON.stringify(stored) === JSON.stringify([0, 1, 2, 3, 4, 5, 6, 7, 8]),
      'and the stored depths were derived 0..8, not the 0 each caller passed',
      stored.join(','),
    );
  }

  // ── 3–6. the run ceilings ───────────────────────────────────────────────
  console.log('\n2. A run is left alone until it passes its ceiling');
  {
    const run = one(await rest('POST', 'ai', 'agent_runs', {
      organization_id: org, agent_key: AGENT, trigger: 'manual',
      status: 'running', step_count: 1, cost_minor: 10,
    }));
    created.runs.push(run.id);
    check(run.status === 'running', 'a run inside its ceiling keeps its status', run.status);

    const at = one(await rest('PATCH', 'ai', `agent_runs?id=eq.${run.id}`, {
      step_count: MAX_STEPS, status: 'succeeded',
    }));
    check(at.status === 'succeeded', `exactly ${MAX_STEPS} of ${MAX_STEPS} is within the ceiling`, at.status);

    console.log('\n3. And forced terminal once it does');
    const over = one(await rest('PATCH', 'ai', `agent_runs?id=eq.${run.id}`, {
      step_count: MAX_STEPS + 1, status: 'succeeded',
    }));
    check(
      over.status === 'budget_exceeded',
      'a run over its step ceiling is budget_exceeded, even claiming success',
      over.status,
    );
    check(
      over.step_count === MAX_STEPS + 1,
      'and the true step count is still recorded rather than the write refused',
      `${over.step_count}`,
    );
    check(Boolean(over.error), 'with a reason recorded', over.error ?? '(none)');
    check(Boolean(over.finished_at), 'and a finish time, because it is terminal');

    const cost = one(await rest('PATCH', 'ai', `agent_runs?id=eq.${run.id}`, {
      step_count: 2, cost_minor: MAX_COST + 1, status: 'succeeded', error: null,
    }));
    check(
      cost.status === 'budget_exceeded',
      'and the cost ceiling does the same on its own',
      cost.status,
    );
    check(
      cost.cost_minor === MAX_COST + 1,
      'with the true spend recorded — unrecorded spend is the worse failure',
      `${cost.cost_minor}`,
    );
  }
} finally {
  for (const id of created.handoffs) await rest('DELETE', 'ai', `handoffs?id=eq.${id}`);
  for (const id of created.runs) await rest('DELETE', 'ai', `agent_runs?id=eq.${id}`);
}

console.log(`\n  ${checks} checks`);
if (failures === 0) {
  console.log('\n\x1b[32m✔ The ceilings hold\x1b[0m\n');
  process.exit(0);
}
console.error(`\n\x1b[31m✖ ${failures} failure(s)\x1b[0m\n`);
process.exit(1);
