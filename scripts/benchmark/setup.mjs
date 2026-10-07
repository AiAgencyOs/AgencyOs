#!/usr/bin/env node
/**
 * Benchmark setup (local isolated stack only): mirrors the PRODUCTION routing configuration and records model prices, then opens a run.
 *
 *   node scripts/benchmark/setup.mjs
 *
 * What it does, and what it deliberately does not:
 *   - it makes the local registry look like production: only openrouter `anthropic/claude-sonnet-4.6` and `anthropic/claude-opus-4.6` are
 *     enabled, and the seven category overrides point at them (engineering -> opus, the rest -> sonnet). Nothing is tuned for cost.
 *   - it records those two models' prices from OpenRouter's PUBLIC model list (USD per million tokens x one stated FX rate), so the runtime's
 *     own `cost_minor` is a CALCULATED figure rather than 0 (0 in agent_runs means "no price recorded", not "free").
 *   - it opens a run: a TEST_RUN_ID and a start instant in tmp/benchmark/run.json. Every report query is bounded by that instant.
 * It refuses to run against anything but the isolated `.env.verify.local` database.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolveTarget } from '../verify-target.mjs';

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}
const target = resolveTarget(fail, { cron: true, anon: false });
if (!target.isolated) fail('refusing: the benchmark setup only runs against the isolated verification database (.env.verify.local).');

const ORG = '00000000-0000-4000-8000-000000000001';
const FX = Number(process.env.BENCH_FX_INR_PER_USD ?? 96.3); // frankfurter.dev, 2026-10-05
const MODELS = {
  'anthropic/claude-sonnet-4.6': { inUsdPerM: 3, outUsdPerM: 15 },
  'anthropic/claude-opus-4.6': { inUsdPerM: 5, outUsdPerM: 25 },
};
const OVERRIDES = {
  engineering: 'anthropic/claude-opus-4.6',
  coordination: 'anthropic/claude-sonnet-4.6',
  client_facing: 'anthropic/claude-sonnet-4.6',
  extraction: 'anthropic/claude-sonnet-4.6',
  design: 'anthropic/claude-sonnet-4.6',
  money: 'anthropic/claude-sonnet-4.6',
  certification: 'anthropic/claude-sonnet-4.6',
};

async function rest(method, schema, path, body) {
  const res = await fetch(`${target.url}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: target.serviceKey, Authorization: `Bearer ${target.serviceKey}`, 'Content-Type': 'application/json',
      'Accept-Profile': schema, 'Content-Profile': schema, Prefer: 'return=representation,resolution=merge-duplicates',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) fail(`${method} ${schema}.${path} -> ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

// 1. only the production pair is enabled
await rest('PATCH', 'ai', `models?organization_id=eq.${ORG}&enabled=eq.true`, { enabled: false });
for (const [id, p] of Object.entries(MODELS)) {
  const inMinor = Math.round(p.inUsdPerM * FX * 100);
  const outMinor = Math.round(p.outUsdPerM * FX * 100);
  const rows = await rest('PATCH', 'ai', `models?organization_id=eq.${ORG}&provider=eq.openrouter&model_id=eq.${encodeURIComponent(id)}`, {
    enabled: true, input_cost_minor_per_mtok: inMinor, output_cost_minor_per_mtok: outMinor,
  });
  if (!rows?.length) fail(`model ${id} is not registered on openrouter`);
  console.log(`  model ${id}: enabled, ${inMinor / 100} / ${outMinor / 100} INR per Mtok (in/out) at ${FX} INR/USD`);
}

// 2. production's category overrides
for (const [category, adminOverrideModel] of Object.entries(OVERRIDES)) {
  await rest('POST', 'ai', 'routing_policies?on_conflict=organization_id,category', {
    organization_id: ORG, category, optimise_for: 'quality', preferred_models: [], admin_override_model: adminOverrideModel,
  });
}
console.log('  routing: 7 category overrides set (engineering -> opus-4.6, the rest -> sonnet-4.6)');

// 3. a queue nothing else will drain, and replies ON for the run
await rest('PATCH', 'core', `jobs?status=in.(queued,running)`, { status: 'cancelled' });
const org = (await rest('GET', 'core', `organizations?id=eq.${ORG}&select=settings`))[0];
const PN = 'bench-pn-p1p3';
await rest('PATCH', 'core', `organizations?id=eq.${ORG}`, { settings: { ...(org?.settings ?? {}), whatsapp_phone_number_id: PN }, agent_answers_clients: true });

// 4. open the run
const dir = 'tmp/benchmark';
mkdirSync(dir, { recursive: true });
const runFile = `${dir}/run.json`;
const run = existsSync(runFile) ? JSON.parse(readFileSync(runFile, 'utf8')) : {};
const now = new Date();
const next = {
  testRunId: run.testRunId ?? `PHASE1_3_COST_FORENSIC_${now.toISOString().replace(/[-:T]/g, '').slice(0, 14)}`,
  startedAt: run.startedAt ?? now.toISOString(),
  baselineConfigId: 'AGENCYOS_P1_P3_BASELINE_V1',
  fxInrPerUsd: FX, fxSource: 'api.frankfurter.dev 2026-10-05', phoneNumberId: PN,
  pricing: { source: 'openrouter.ai/api/v1/models (public), 2026-10-05', models: MODELS },
  environment: 'local isolated stack (.env.verify.local), Meta Graph stubbed, real OpenRouter calls',
};
writeFileSync(runFile, JSON.stringify(next, null, 2));
console.log(`  run ${next.testRunId} opened at ${next.startedAt}`);
