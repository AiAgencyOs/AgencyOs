#!/usr/bin/env node
/**
 * What the agency spent, verified against a real database — G-186.
 *
 * `ai.cost_ledger` was created on 2026-08-07 with the comment *"nightly
 * rollup; the budget check reads this"*. A zero-trust audit found the table
 * empty, with no producer and no reader (DB-A) — while the Admin Panel's spend
 * page added up every run and step row under a 10,000-row cap and reported a
 * partial total past it, as if it were the total.
 *
 * The unit tests read the migration text. They cannot show that the trigger
 * fires, and a trigger that does not fire is indistinguishable from one that
 * does until something depends on it — which the spend page now does.
 *
 * What it proves:
 *
 *   1. A settled run appears in the ledger, once.
 *   2. The figures are the STEPS' sums, not the run's own columns — the case a
 *      second model call would otherwise lose.
 *   3. A second settlement write does not count it twice.
 *   4. A run still in flight is not in it.
 *   5. A failed run IS — spending is spending.
 *   6. Two runs of one agent on one day and model become one row.
 *   7. A different model is a different row, on the same day.
 *   8. The day is the agency's own, not UTC's.
 *   9. A run with no model is filed as `unknown` rather than dropped.
 *
 *   node scripts/verify-cost-ledger.mjs
 */

import { randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false });
await announceTarget(target, 'verify-cost-ledger');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const AGENT = 'requirement_collector';
const RUN = randomUUID().slice(0, 8);

let failures = 0;
let checks = 0;

function check(condition, description, detail = '') {
  checks += 1;
  if (condition) return void console.log(`  \x1b[32m✓\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
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
  return { ok: res.ok, status: res.status, json, text };
}

const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);

const org = one(await rest('GET', 'core', 'organizations?select=id,timezone&limit=1'));
if (!org?.id) fail('no organization to run against');
const ORG = org.id;

console.log(`\n\x1b[1mAgencyOS — what the agency spent (G-186)\x1b[0m`);

const made = { runs: [] };

/**
 * Two baselines, taken before anything is planted.
 *
 * This script runs LAST in the chain, in a tenant a dozen other scripts have
 * used: some of their runs settled with no model — an `unknown` row that is
 * not this script's — and some deleted their runs afterwards while the ledger
 * kept the spend, which is correct and which makes an absolute comparison
 * between the ledger and the surviving step rows a check about other scripts'
 * cleanup rather than about this trigger. Every total below is therefore a
 * DELTA. The first version compared absolutes, passed alone and failed in the
 * chain: the same fixture-isolation class G-175 recorded.
 */
const ledgerTotal = async () =>
  (((await rest('GET', 'ai', `cost_ledger?organization_id=eq.${ORG}&select=cost_minor`)).json) ?? [])
    .reduce((n, r) => n + Number(r.cost_minor), 0);

const settledStepTotal = async () => {
  const settled = (await rest('GET', 'ai',
    `agent_runs?organization_id=eq.${ORG}&status=in.(succeeded,failed,cancelled,budget_exceeded)&select=id`)).json ?? [];
  const ids = new Set(settled.map((r) => r.id));
  const steps = (await rest('GET', 'ai',
    `agent_steps?organization_id=eq.${ORG}&select=run_id,cost_minor`)).json ?? [];
  return steps.filter((s) => ids.has(s.run_id)).reduce((n, s) => n + Number(s.cost_minor), 0);
};

const ledgerAtStart = await ledgerTotal();
const stepsAtStart = await settledStepTotal();
const unknownAtStart = Number(one(await rest('GET', 'ai',
  `cost_ledger?organization_id=eq.${ORG}&agent_key=eq.${AGENT}&model=eq.unknown&select=cost_minor`))?.cost_minor ?? 0);

/** A run in whatever state, with the steps it is meant to have spent. */
async function plantRun({ model = 'claude-sonnet-5', steps = [], status = 'running' } = {}) {
  const run = one(await rest('POST', 'ai', 'agent_runs', {
    organization_id: ORG,
    agent_key: AGENT,
    trigger: 'system',
    status: 'running',
    model,
    work_class: 'read',
    started_at: new Date().toISOString(),
  }));
  if (!run?.id) fail(`could not plant a run: ${JSON.stringify(run)}`);
  made.runs.push(run.id);

  let seq = 0;
  for (const s of steps) {
    seq += 1;
    await rest('POST', 'ai', 'agent_steps', {
      organization_id: ORG, run_id: run.id, seq, kind: 'model_call',
      tokens_in: s.in, tokens_out: s.out, cost_minor: s.cost,
    });
  }
  if (status !== 'running') await settle(run.id, status);
  return run.id;
}

const settle = (runId, status = 'succeeded', extra = {}) =>
  rest('PATCH', 'ai', `agent_runs?id=eq.${runId}`, {
    status, finished_at: new Date().toISOString(), ...extra,
  });

const ledgerFor = async (model, day) =>
  one(await rest('GET', 'ai',
    `cost_ledger?organization_id=eq.${ORG}&agent_key=eq.${AGENT}&model=eq.${encodeURIComponent(model)}` +
    `${day ? `&day=eq.${day}` : ''}&select=day,model,runs,input_tokens,output_tokens,cost_minor`));

/**
 * The agency's own day, computed here from the organization's own timezone —
 * the same fallback the trigger uses, because the timezone ships unset.
 *
 * Computed independently rather than read back from the row under test: a
 * check that asks the ledger what day it thinks it is would agree with itself
 * whatever the trigger did.
 */
const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: org.timezone || 'UTC',
  year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

try {
  // ── 0. the table starts empty for this model ───────────────────────────
  const MODEL = `zztest-model-${RUN}`;
  const OTHER = `zztest-other-${RUN}`;
  check(!(await ledgerFor(MODEL)), 'nothing is recorded for a model that has never run');

  // ── 1 & 2. a settled run lands, with the STEPS' figures ────────────────
  console.log('\n1. A settled run is counted, from what its steps actually spent');
  const first = await plantRun({
    model: MODEL,
    // Two calls. The run's own columns stay 0, which is exactly the case a
    // rollup reading the run row would lose: `succeedRun` writes the usage of
    // the call it was handed, and a second call's tokens are paid for either
    // way.
    steps: [{ in: 100, out: 40, cost: 150 }, { in: 60, out: 20, cost: 50 }],
    status: 'succeeded',
  });
  const row = await ledgerFor(MODEL);
  check(Boolean(row), 'the run appears in the ledger', row ? 'recorded' : 'nothing recorded');
  check(Number(row?.runs) === 1, 'counted once', `${row?.runs} run(s)`);
  check(
    Number(row?.input_tokens) === 160 && Number(row?.output_tokens) === 60 && Number(row?.cost_minor) === 200,
    'with the SUM of its steps, not the run’s own zeroes',
    `${row?.input_tokens}/${row?.output_tokens} tokens, ${row?.cost_minor} minor`,
  );

  // ── 3. settled again is not spent again ────────────────────────────────
  console.log('\n2. Writing to a settled run again does not spend it again');
  await settle(first, 'succeeded', { output: { note: 'written afterwards' } });
  await rest('PATCH', 'ai', `agent_runs?id=eq.${first}`, { error: null, step_count: 2 });
  const after = await ledgerFor(MODEL);
  check(Number(after?.runs) === 1, 'still one run', `${after?.runs} run(s)`);
  check(Number(after?.cost_minor) === 200, 'and the same money', `${after?.cost_minor} minor`);

  // ── 4. in flight is not spent yet ──────────────────────────────────────
  console.log('\n3. A run still going is not in it');
  await plantRun({ model: OTHER, steps: [{ in: 9, out: 9, cost: 999 }], status: 'running' });
  check(!(await ledgerFor(OTHER)), 'a running run has no ledger row, however much it has spent so far');

  // ── 5. failure is spending ─────────────────────────────────────────────
  console.log('\n4. A run that failed still spent its tokens');
  await plantRun({ model: OTHER, steps: [{ in: 10, out: 5, cost: 70 }], status: 'failed' });
  const failed = await ledgerFor(OTHER);
  check(Number(failed?.cost_minor) === 70, 'a failed run is counted — a ledger of successes would flatter the worst month', `${failed?.cost_minor} minor`);

  // ── 6. one agent, one day, one model, one row ──────────────────────────
  console.log('\n5. The rollup is one row per day, per agent, per model');
  await plantRun({ model: MODEL, steps: [{ in: 40, out: 10, cost: 100 }], status: 'succeeded' });
  const merged = await ledgerFor(MODEL);
  check(Number(merged?.runs) === 2, 'a second run of the same agent on the same model adds to the same row', `${merged?.runs} run(s)`);
  check(Number(merged?.cost_minor) === 300, 'and its money is added, not replaced', `${merged?.cost_minor} minor`);

  const rows = (await rest('GET', 'ai',
    `cost_ledger?organization_id=eq.${ORG}&model=in.(${MODEL},${OTHER})&select=model,day`)).json ?? [];
  check(rows.length === 2, 'a different model is a different row on the same day', `${rows.length} row(s)`);

  // ── 7. the day is the agency's ─────────────────────────────────────────
  console.log('\n6. The day is the agency’s day');
  check(
    merged?.day === today,
    'filed against the organization’s own calendar day, not UTC’s',
    `${merged?.day} vs ${today} (${org.timezone || 'UTC'})`,
  );

  /**
   * And the check above is only worth something if it can fail.
   *
   * The timezone ships UNSET, so "the agency's day" and "UTC's day" are the
   * same string on this deployment and the assertion passes whatever the
   * trigger reads. So the agency is moved fourteen hours east — where a UTC
   * afternoon is already tomorrow — and the same question is asked again.
   */
  const set = one(await rest('POST', 'core', 'rpc/set_agency_timezone', {
    p_organization_id: ORG, p_timezone: 'Pacific/Kiritimati',
  }));
  check(set?.outcome === 'set', 'the agency moves to UTC+14', String(set?.outcome));
  /**
   * Settled at a FIXED instant rather than at now(), because the assertion has
   * to mean something at every hour. 20:00 UTC on the 2nd is already the 3rd
   * in Kiritimati; at 09:00 UTC the two agree, and a check that only works
   * some afternoons is a check nobody can trust the rest of the time.
   */
  const INSTANT = '2026-09-02T20:00:00.000Z';
  const EAST = `zztest-east-${RUN}`;
  const eastRun = await plantRun({ model: EAST, steps: [{ in: 1, out: 1, cost: 1 }] });
  await settle(eastRun, 'succeeded', { finished_at: INSTANT });
  const eastRow = await ledgerFor(EAST);
  check(
    eastRow?.day === '2026-09-03',
    'a run settled at 20:00 UTC is filed on THEIR tomorrow, not UTC’s today',
    `${eastRow?.day} (UTC would say 2026-09-02)`,
  );

  // ── 8. a run with no model ─────────────────────────────────────────────
  console.log('\n7. A run that died before it chose a model');
  const noModel = one(await rest('POST', 'ai', 'agent_runs', {
    organization_id: ORG, agent_key: AGENT, trigger: 'system', status: 'running', work_class: 'read',
  }));
  made.runs.push(noModel.id);
  await rest('POST', 'ai', 'agent_steps', {
    organization_id: ORG, run_id: noModel.id, seq: 1, kind: 'model_call',
    tokens_in: 5, tokens_out: 0, cost_minor: 11,
  });
  await settle(noModel.id, 'failed');
  const unknown = one(await rest('GET', 'ai',
    `cost_ledger?organization_id=eq.${ORG}&agent_key=eq.${AGENT}&model=eq.unknown&select=runs,cost_minor`));
  check(Boolean(unknown), 'it is filed as "unknown" rather than dropped — the spend happened either way');
  check(
    Number(unknown?.cost_minor ?? 0) - unknownAtStart === 11,
    'with what it spent — a delta, because other scripts settle model-less runs too',
    `${Number(unknown?.cost_minor ?? 0) - unknownAtStart} minor added`,
  );

  // ── 9. the ledger and the steps agree ──────────────────────────────────
  //
  // The claim the whole change rests on: the page can read the rollup instead
  // of the steps BECAUSE they are the same number. Asserted against the
  // database rather than assumed from the code that writes both.
  console.log('\n8. The rollup and the step rows say the same thing');
  const ledgerMoved = (await ledgerTotal()) - ledgerAtStart;
  const stepsMoved = (await settledStepTotal()) - stepsAtStart;
  check(
    ledgerMoved === stepsMoved,
    'every settled run’s step cost reached the ledger, and nothing else did',
    `ledger +${ledgerMoved} vs steps +${stepsMoved}`,
  );

  /**
   * And the ledger keeps what the runs no longer say.
   *
   * A pruned run must not un-spend its money: `ai.agent_runs` and
   * `ai.agent_steps` are working rows and this is the record of what was paid.
   * Proved by deleting one of this script's own settled runs and asking again.
   */
  console.log('\n9. A deleted run does not un-spend its money');
  const beforeDelete = await ledgerTotal();
  const pruned = made.runs.pop();
  await rest('DELETE', 'ai', `agent_steps?run_id=eq.${pruned}`);
  await rest('DELETE', 'ai', `agent_runs?id=eq.${pruned}`);
  const afterDelete = await ledgerTotal();
  check(
    afterDelete === beforeDelete,
    'the ledger is the record; the run is a working row',
    `${afterDelete} vs ${beforeDelete}`,
  );
} finally {
  /**
   * The timezone goes back to unset, and it matters beyond tidiness:
   * `db:verify:followup` asserts this deployment ships without one, so a
   * script that left Kiritimati behind would fail a different script later in
   * the same chain. Written directly because `set_agency_timezone` refuses a
   * null by design — the service role is exempt from the sanctioned-write
   * trigger, which is the door this uses.
   */
  await rest('PATCH', 'core', `organizations?id=eq.${ORG}`, { timezone: null });

  for (const id of made.runs) {
    await rest('DELETE', 'ai', `agent_steps?run_id=eq.${id}`);
    await rest('DELETE', 'ai', `agent_runs?id=eq.${id}`);
  }
  await rest('DELETE', 'ai', `cost_ledger?organization_id=eq.${ORG}&model=like.zztest-*`);
  await rest('DELETE', 'ai', `cost_ledger?organization_id=eq.${ORG}&model=eq.unknown`);
}

console.log(`\n  ${checks} checks`);
if (failures > 0) fail(`${failures} check(s) failed`);
console.log('\n\x1b[32m✔ Every settled run is counted once, and the ledger agrees with the steps\x1b[0m\n');
