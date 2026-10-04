#!/usr/bin/env node
/**
 * AI routing, run for real: Admin configuration -> the job runner -> a provider that is not Anthropic -> what was recorded.
 *
 *   node scripts/verify-ai-routing.mjs
 *
 * Needs the running app (the job runner) and the database. A stub OpenAI-compatible provider is started on :54395 and added as two
 * CUSTOM providers through the same doors the Admin screen uses; an inbound client message makes the real runner call it as the
 * `sales` agent. Nothing here is mocked in the app.
 *
 *   1. MANUAL: the sales agent runs on exactly the assigned provider and model; the run says what ACTUALLY ran; the decision is recorded
 *   2. several keys: a rejected key is parked, the next key serves the same request, and the rejected key is never asked again
 *   3. MANUAL, provider disabled, no fallback: the run is BLOCKED and the Admin is told - nothing else is substituted, no call is made
 *   4. MANUAL with an explicit fallback: the fallback serves when the primary is rate limited on every key, and the decision says so
 *   5. AUTO: a disabled provider is never considered; a disabled model is skipped; the Admin's preference order is followed
 *   6. switching modes keeps the manual assignments; usage and cost are recorded only where a price was set
 *   7. no secret appears in a decision, a run, an audit row or a step
 */

import { Buffer } from 'node:buffer';
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

import { fixturesFor } from './verify-fixtures.mjs';
import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: true, anon: false, jwt: true });
await announceTarget(target, 'AI routing, end to end');

const ORG = '00000000-0000-4000-8000-000000000001';
const APP = target.appUrl ?? 'http://localhost:3000';
const STUB_PORT = 54395;
const MARKER = `zzr${randomUUID().slice(0, 6)}`;
const fx = fixturesFor(target, ORG);
const { rest, one } = fx;

let failures = 0;
let checks = 0;
function check(condition, description, detail = '') {
  checks += 1;
  if (condition) return void console.log(`  \x1b[32m✓\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
  failures += 1;
  console.error(`  \x1b[31m✗\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
}
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => delay(ms);

function envValue(name) {
  if (process.env[name]) return process.env[name];
  try {
    const m = readFileSync('.env.verify.local', 'utf8').match(new RegExp(`^${name}=(.*)$`, 'm'));
    return m ? m[1].trim() : '';
  } catch { return ''; }
}
const VAULT_KEY = envValue('VAULT_ENCRYPTION_KEY');
if (!VAULT_KEY) fail('VAULT_ENCRYPTION_KEY is not set in .env.verify.local - the app could not decrypt a stored key');
function seal(secret) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', createHash('sha256').update(VAULT_KEY).digest(), iv);
  const ct = Buffer.concat([c.update(secret, 'utf8'), c.final()]);
  return { p_ciphertext: ct.toString('base64'), p_iv: iv.toString('base64'), p_auth_tag: c.getAuthTag().toString('base64') };
}

// ── the stub provider (OpenAI-compatible) ───────────────────────────────────────

const SECRETS = { v1: `sk-${MARKER}-v-key-one-0001`, v2: `sk-${MARKER}-v-key-two-0002`, w1: `sk-${MARKER}-w-key-one-0003` };
const behaviour = { [SECRETS.v1]: 'ok', [SECRETS.v2]: 'ok', [SECRETS.w1]: 'ok' };
const calls = []; // { path, key, model, status }

/** A value that satisfies the JSON schema the runner sent (required fields only) - enough for the call to count as answered. */
function instantiate(schema) {
  if (!schema || typeof schema !== 'object') return null;
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  const variant = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(variant)) return instantiate(variant.find((v) => v.type !== 'null') ?? variant[0]);
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
  switch (type) {
    case 'object': {
      const out = {};
      for (const key of schema.required ?? []) out[key] = instantiate(schema.properties?.[key]);
      return out;
    }
    case 'array': return (schema.minItems ?? 0) > 0 ? Array.from({ length: schema.minItems }, () => instantiate(schema.items)) : [];
    case 'string': return 'x'.repeat(Math.max(1, schema.minLength ?? 1));
    case 'integer': case 'number': return schema.minimum ?? 0;
    case 'boolean': return false;
    default: return null;
  }
}

const stub = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const key = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const parsed = body ? JSON.parse(body) : {};
    const path = req.url ?? '';
    const send = (status, payload) => { calls.push({ path, key, model: parsed.model ?? null, status }); res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
    if (req.method === 'GET' && path.endsWith('/models')) return send(200, { data: [{ id: 'acme-m1' }, { id: 'acme-m2' }] });
    if (req.method === 'POST' && path.endsWith('/chat/completions')) {
      const mode = behaviour[key] ?? 'unknown';
      if (mode === '401') return send(401, { error: { message: 'bad key' } });
      if (mode === '429') return send(429, { error: { message: 'slow down' } });
      if (mode !== 'ok') return send(401, { error: { message: 'unknown key' } });
      const schema = parsed.response_format?.json_schema?.schema ?? { type: 'object' };
      return send(200, { model: parsed.model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(instantiate(schema)) } }], usage: { prompt_tokens: 1000, completion_tokens: 500 } });
    }
    return send(404, {});
  });
});
await new Promise((resolve, reject) => { stub.once('error', reject); stub.listen(STUB_PORT, '127.0.0.1', resolve); }).catch((e) => fail(`could not bind the stub provider on ${STUB_PORT}: ${e.message}`));

const dbNow = async () => new Date((await fetch(`${target.url}/rest/v1/`, { headers: { apikey: target.serviceKey } })).headers.get('date') ?? Date.now());
const tick = () => fetch(`${APP}/api/jobs/run`, { method: 'POST', headers: { Authorization: `Bearer ${target.cronSecret}` }, cache: 'no-store' }).then((r) => r.status);

let owner;
const created = { providers: ['acme-v', 'acme-w'].map((p) => `${p}-${MARKER}`), models: [] };
const PV = `acme-v-${MARKER}`;
const PW = `acme-w-${MARKER}`;
const M1 = `${PV}-m1`;
const M2 = `${PV}-m2`;
const W1 = `${PW}-w1`;
const savedMode = one(await rest('GET', 'ai', `routing_settings?organization_id=eq.${ORG}&select=mode`))?.mode ?? 'auto';
const savedAgent = one(await rest('GET', 'ai', 'agents?key=eq.sales&select=default_model,enabled'));

try {
  owner = await fx.bootstrapOwner(MARKER);
  const door = (fn, args) => fx.call(owner.token, 'POST', 'ai', `rpc/${fn}`, args);

  // ── fixture: two custom providers, three keys, models ───────────────────────────
  const provider = (id, path) => ({ p_provider_id: id, p_kind: 'openai_compat', p_display_name: id, p_base_url: `http://127.0.0.1:${STUB_PORT}${path}`, p_auth_scheme: 'bearer', p_match_prefixes: [`${id}-`], p_match_contains: [], p_extra_headers: {}, p_timeout_ms: 20000, p_retry_max: 0, p_models_path: '/models', p_api_version: '', p_priority: 150 });
  check(one(await door('upsert_provider', provider(PV, '/v/v1')))?.outcome === 'created', 'a custom OpenAI-compatible provider is added through the Admin door');
  await door('upsert_provider', provider(PW, '/w/v1'));
  const k1 = one(await door('add_provider_key', { p_provider_id: PV, p_label: 'one', p_environment: 'production', ...seal(SECRETS.v1), p_hint: SECRETS.v1.slice(-4), p_priority: 10 }));
  await door('add_provider_key', { p_provider_id: PV, p_label: 'two', p_environment: 'production', ...seal(SECRETS.v2), p_hint: SECRETS.v2.slice(-4), p_priority: 20 });
  await door('add_provider_key', { p_provider_id: PW, p_label: 'one', p_environment: 'production', ...seal(SECRETS.w1), p_hint: SECRETS.w1.slice(-4), p_priority: 10 });
  for (const [prov, id] of [[PV, M1], [PV, M2], [PW, W1]]) {
    await door('register_manual_model', { p_provider_id: prov, p_model_id: id, p_display_name: id, p_capabilities: ['structured_output'], p_context_tokens: 32000, p_tool_calling: true, p_structured_output: true });
    created.models.push(id);
  }
  // M1 is priced by the Admin, M2 is not: cost is only ever recorded where a price exists.
  await rest('PATCH', 'ai', `models?model_id=eq.${M1}&organization_id=eq.${ORG}`, { input_cost_minor_per_mtok: 20000, output_cost_minor_per_mtok: 60000 });

  // A client message in a lead's thread is what makes the sales agent's jobs run.
  const phone = `+9198${String(Date.now()).slice(-8)}7`;
  const account = one(await rest('POST', 'core', 'client_accounts', { organization_id: ORG, name: `${MARKER} client` }));
  const contact = one(await rest('POST', 'crm', 'contacts', { organization_id: ORG, client_account_id: account.id, full_name: `${MARKER} contact`, phone }));
  await rest('POST', 'crm', 'communication_consent', { organization_id: ORG, contact_id: contact.id, channel: 'whatsapp', status: 'granted' });
  const lead = one(await rest('POST', 'crm', 'leads', { organization_id: ORG, contact_id: contact.id, title: `${MARKER} lead`, source: 'whatsapp', source_ref: `${MARKER}:lead`, status: 'new' }));
  const conv = one(await rest('POST', 'crm', 'conversations', { organization_id: ORG, lead_id: lead.id, contact_id: contact.id, kind: 'direct', channel: 'whatsapp', external_ref: `${MARKER}:conv`, status: 'active' }));
  let seq = 0;
  const say = async (text) => {
    seq += 1;
    await rest('POST', 'crm', 'conversation_messages', { organization_id: ORG, conversation_id: conv.id, seq, author_type: 'client', body: text, external_ref: `${MARKER}:m${seq}`, occurred_at: new Date().toISOString() });
  };
  const decisions = async (since) => (await rest('GET', 'ai', `routing_decisions?organization_id=eq.${ORG}&agent_key=eq.sales&created_at=gte.${since}&select=*&order=created_at.asc`)).json ?? [];
  const run = async (text, wait = 8) => {
    const since = (await dbNow()).toISOString();
    calls.length = 0;
    await say(text);
    for (let i = 0; i < wait; i += 1) { await tick(); await sleep(250); }
    return { since, decisions: await decisions(since), calls: [...calls] };
  };
  await rest('PATCH', 'ai', 'agents?key=eq.sales', { enabled: true });

  // ── 1. MANUAL ────────────────────────────────────────────────────────────────
  section('1. MANUAL: exactly the assigned provider and model, and the run says what actually ran');
  const modeNoReason = one(await door('set_routing_mode', { p_mode: 'manual', p_reason: '  ' }));
  check(modeNoReason?.outcome === 'needs_reason', 'switching the mode needs a reason', String(modeNoReason?.outcome));
  const memberMode = one(await fx.call(fx.mint(owner.id, 'ops_admin'), 'POST', 'ai', 'rpc/set_routing_mode', { p_mode: 'manual', p_reason: 'x' }));
  check(memberMode?.outcome === 'owner_only', 'only the owner switches it', String(memberMode?.outcome));
  const toManual = one(await door('set_routing_mode', { p_mode: 'manual', p_reason: `${MARKER}: pin the agents` }));
  check(toManual?.outcome === 'changed', 'the owner switches to MANUAL', String(toManual?.outcome));
  const notEnabled = one(await door('set_agent_assignment', { p_agent_key: 'sales', p_provider_id: PV, p_model_id: 'no-such-model', p_fallbacks: [], p_note: '' }));
  check(notEnabled?.outcome === 'unknown_model', 'an assignment must name a model in the registry', String(notEnabled?.outcome));
  const mismatch = one(await door('set_agent_assignment', { p_agent_key: 'sales', p_provider_id: PW, p_model_id: M1, p_fallbacks: [], p_note: '' }));
  check(mismatch?.outcome === 'provider_mismatch', 'and the model must belong to that provider', String(mismatch?.outcome));
  const assigned = one(await door('set_agent_assignment', { p_agent_key: 'sales', p_provider_id: PV, p_model_id: M1, p_fallbacks: [], p_note: 'verifier' }));
  check(assigned?.outcome === 'saved', 'the Sales agent is assigned provider A, model 1', String(assigned?.outcome));

  const r1 = await run('hello, I would like a quote for a pharmacy app');
  const d1 = r1.decisions.filter((d) => d.outcome === 'succeeded');
  check(d1.length > 0, 'the runner called the assigned provider through the real job runner', `${d1.length} decision(s), ${r1.calls.filter((c) => c.path.endsWith('chat/completions')).length} call(s)`);
  check(d1.every((d) => d.mode === 'manual' && d.provider_id === PV && d.model_id === M1 && d.selection_source === 'assignment'), 'every decision says MANUAL, that provider, that model, source "assignment"', d1[0] ? `${d1[0].mode}/${d1[0].provider_id}/${d1[0].model_id}` : 'none');
  check(r1.calls.filter((c) => c.path.endsWith('chat/completions')).every((c) => c.model === M1 && c.path.startsWith('/v/')), 'and the provider only ever saw that model, on its own path');
  const run1 = one(await rest('GET', 'ai', `agent_runs?id=in.(${d1.map((d) => d.run_id).join(',')})&status=eq.succeeded&select=provider_id,model,routing_mode,routing_decision_id,cost_minor,input_tokens`));
  check(run1?.provider_id === PV && run1?.model === M1 && run1?.routing_mode === 'manual' && d1.some((d) => d.id === run1?.routing_decision_id), 'the run records what ACTUALLY ran - not the agent\'s default', JSON.stringify(run1));
  check(Number(run1?.cost_minor) > 0 && Number(run1?.input_tokens) === 1000, 'usage is captured, and cost only because the Admin priced this model', `cost ${run1?.cost_minor}, tokens ${run1?.input_tokens}`);
  check(d1[0]?.config_version >= 2 && (d1[0]?.plan?.candidates ?? []).length === 1, 'the decision names the configuration version and the one candidate', `v${d1[0]?.config_version}`);

  // ── 2. several keys ────────────────────────────────────────────────────────────
  section('2. Several keys: a rejected key is parked and never asked again');
  behaviour[SECRETS.v1] = '401';
  const r2 = await run('can you share timelines please');
  const answered = r2.decisions.filter((d) => d.outcome === 'succeeded');
  const sawBad = r2.calls.filter((c) => c.key === SECRETS.v1);
  const sawGood = r2.calls.filter((c) => c.key === SECRETS.v2 && c.status === 200);
  check(answered.length > 0 && sawBad.length >= 1 && sawGood.length >= 1, 'key one is rejected and key two serves the SAME requests', `${sawBad.length} rejected, ${sawGood.length} answered`);
  const status2 = ((await fx.call(owner.token, 'POST', 'ai', 'rpc/provider_key_status', { p_provider_id: PV })).json ?? []);
  check(status2.find((k) => k.label === 'one')?.health_state === 'auth_error', 'key one is recorded as auth_error', String(status2.find((k) => k.label === 'one')?.health_state));
  const r2b = await run('and what about the payment terms');
  check(r2b.calls.filter((c) => c.key === SECRETS.v1).length === 0 && r2b.calls.some((c) => c.key === SECRETS.v2 && c.status === 200), 'the rejected key is never asked again - not until a person rotates or re-enables it', `${r2b.calls.filter((c) => c.key === SECRETS.v1).length} calls with the bad key`);
  const provRow = one(await rest('GET', 'ai', `providers?provider_id=eq.${PV}&select=health_state,last_success_at,recent_calls`));
  check(provRow?.health_state === 'healthy' && Number(provRow?.recent_calls) > 0, 'the provider\'s health and counters follow the calls', JSON.stringify(provRow));

  // ── 3. MANUAL, provider disabled, no fallback ──────────────────────────────────────
  section('3. MANUAL with the provider disabled and no fallback: blocked, told, nothing substituted');
  const off = one(await door('set_provider_enabled', { p_provider_id: PV, p_enabled: false, p_reason: `${MARKER} maintenance` }));
  check(off?.outcome === 'disabled', 'the Admin disables provider A', String(off?.outcome));
  await sleep(21_000); // the registry's cache window: a disabled provider must stop receiving work without a redeploy
  const r3 = await run('are you still there');
  const blocked = r3.decisions.filter((d) => d.outcome === 'blocked');
  check(blocked.length > 0 && blocked.every((d) => /disabled/.test(d.blocked_reason ?? '')), 'the run is BLOCKED with the reason', blocked[0]?.blocked_reason?.slice(0, 80) ?? 'none');
  check(r3.calls.length === 0, 'and no call was made to any provider - nothing was substituted', `${r3.calls.length} calls`);
  const alerts3 = (await rest('GET', 'core', `alerts?fingerprint=eq.router-manual:sales&select=summary`)).json ?? [];
  check(alerts3.length === 1 && /could not run on its manual assignment/.test(alerts3[0].summary), 'the Admin is told (an alert), not left to find a job error', String(alerts3[0]?.summary).slice(0, 60));

  // ── 4. MANUAL with an explicit fallback ────────────────────────────────────────────
  section('4. MANUAL with an explicit fallback: used only when the primary cannot serve');
  await door('set_provider_enabled', { p_provider_id: PV, p_enabled: true, p_reason: '' });
  // A rejected key stays parked until a person turns it off and on again (or rotates it): that is the Admin's "try it again".
  await door('set_provider_key_state', { p_key_id: k1.key_id, p_enabled: false });
  await door('set_provider_key_state', { p_key_id: k1.key_id, p_enabled: true });
  await door('set_agent_assignment', { p_agent_key: 'sales', p_provider_id: PV, p_model_id: M1, p_fallbacks: [{ providerId: PW, modelId: W1 }], p_note: 'with fallback' });
  behaviour[SECRETS.v1] = '429';
  behaviour[SECRETS.v2] = '429';
  await sleep(21_000);
  const r4 = await run('one more question about hosting');
  const fb = r4.decisions.filter((d) => d.outcome === 'succeeded' && d.fallback_used);
  check(fb.length > 0 && fb.every((d) => d.provider_id === PW && d.model_id === W1 && d.selection_source === 'assignment_fallback'), 'both keys of the primary are rate limited: the explicit fallback serves', fb[0] ? `${fb[0].provider_id}/${fb[0].model_id}` : 'none');
  check(r4.calls.some((c) => c.key === SECRETS.v1 && c.status === 429) && r4.calls.some((c) => c.key === SECRETS.w1 && c.status === 200), 'the primary was tried first, on its keys, then the fallback');
  check((fb[0]?.attempts ?? []).length >= 2 && fb[0].attempts[0].ok === false, 'every attempt is in the decision', `${(fb[0]?.attempts ?? []).length} attempts`);

  // ── 5. AUTO ────────────────────────────────────────────────────────────────────────
  section('5. AUTO: only what the Admin allowed - a disabled provider and a disabled model are never chosen');
  behaviour[SECRETS.v1] = 'ok';
  behaviour[SECRETS.v2] = 'ok';
  await door('set_provider_key_state', { p_key_id: k1.key_id, p_enabled: false });
  await door('set_provider_key_state', { p_key_id: k1.key_id, p_enabled: true });
  const toAuto = one(await door('set_routing_mode', { p_mode: 'auto', p_reason: `${MARKER}: let the orchestrator choose` }));
  check(toAuto?.outcome === 'changed', 'the owner switches to AUTO', String(toAuto?.outcome));
  const kept = (await rest('GET', 'ai', `agent_model_assignments?organization_id=eq.${ORG}&agent_key=eq.sales&select=provider_id,model_id,fallbacks`)).json ?? [];
  check(kept.length === 1 && kept[0].model_id === M1 && kept[0].fallbacks.length === 1, 'the manual assignment is KEPT while AUTO is on', JSON.stringify(kept[0] ?? {}).slice(0, 80));
  // The Admin's own preference (the AUTO policy): this provider's two models first. Provider W is disabled below.
  await door('set_agent_routing_override', { p_agent_key: 'sales', p_category: 'client_facing', p_preferred_models: [M2, M1], p_note: MARKER });
  await door('set_provider_enabled', { p_provider_id: PW, p_enabled: false, p_reason: `${MARKER}: W off` });
  await sleep(21_000);
  const r5 = await run('please send the proposal');
  const a5 = r5.decisions.filter((d) => d.outcome === 'succeeded');
  check(a5.length > 0 && a5.every((d) => d.mode === 'auto' && d.provider_id === PV && d.model_id === M2 && d.selection_source === 'agent_override'), 'AUTO follows the Admin\'s preference order: provider A, model 2', a5[0] ? `${a5[0].provider_id}/${a5[0].model_id}/${a5[0].selection_source}` : 'none');
  check(r5.calls.every((c) => !c.path.startsWith('/w/')), 'the disabled provider received nothing');
  const considered5 = a5[0]?.plan?.considered ?? [];
  check(considered5.some((c) => c.model === W1 && /disabled/.test(c.excluded ?? '')), 'and the decision explains why its model was left out', considered5.find((c) => c.model === W1)?.excluded ?? 'not listed');
  const run5 = one(await rest('GET', 'ai', `agent_runs?id=in.(${a5.map((d) => d.run_id).join(',')})&status=eq.succeeded&select=cost_minor,provider_id,model`));
  check(Number(run5?.cost_minor) === 0 && run5?.model === M2, 'model 2 has no price, so its cost is 0 - never an invented number', JSON.stringify(run5));

  await door('set_model_enabled', { p_model_id: M2, p_enabled: false });
  await sleep(21_000);
  const r6 = await run('and the invoice please');
  const a6 = r6.decisions.filter((d) => d.outcome === 'succeeded');
  check(a6.length > 0 && a6.every((d) => d.model_id === M1), 'a disabled MODEL is skipped: the next enabled one serves', a6[0]?.model_id ?? 'none');
  check((a6[0]?.plan?.considered ?? []).some((c) => c.model === M2 && /disabled/.test(c.excluded ?? '')), 'with the reason on record');

  // ── 6. modes keep their settings ──────────────────────────────────────────────────────
  section('6. Switching back to MANUAL restores the saved assignment');
  await door('set_model_enabled', { p_model_id: M2, p_enabled: true });
  await door('set_provider_enabled', { p_provider_id: PW, p_enabled: true, p_reason: '' });
  const back = one(await door('set_routing_mode', { p_mode: 'manual', p_reason: `${MARKER}: back to pinned` }));
  const stillThere = one(await rest('GET', 'ai', `agent_model_assignments?organization_id=eq.${ORG}&agent_key=eq.sales&select=model_id,fallbacks`));
  check(back?.outcome === 'changed' && stillThere?.model_id === M1, 'MANUAL again, and the assignment is exactly as it was left', String(stillThere?.model_id));
  const hist = (await rest('GET', 'audit', `audit_log?action=like.ai_routing*&order=created_at.desc&limit=40&select=action,before,after`)).json ?? [];
  check(['ai_routing.mode_changed', 'ai_routing.assignment_set'].every((a) => hist.some((h) => h.action === a)), 'every mode and assignment change is audited with before and after');

  // ── 7. no secret anywhere ─────────────────────────────────────────────────────────
  section('6b. A decision is history');
  const someDecision = one(await rest('GET', 'ai', `routing_decisions?organization_id=eq.${ORG}&select=id,mode&limit=1`));
  const del = await rest('DELETE', 'ai', `routing_decisions?id=eq.${someDecision?.id}`);
  const upd = await rest('PATCH', 'ai', `routing_decisions?id=eq.${someDecision?.id}`, { mode: someDecision?.mode === 'auto' ? 'manual' : 'auto' });
  const still = one(await rest('GET', 'ai', `routing_decisions?id=eq.${someDecision?.id}&select=id,mode`));
  check(Boolean(someDecision?.id) && !del.ok && !upd.ok && still?.mode === someDecision?.mode, 'a recorded decision can be neither edited nor removed, even by the service role', `delete ${del.status}, update ${upd.status}`);

  section('7. No secret appears in what was recorded');
  const everything = JSON.stringify({
    decisions: (await rest('GET', 'ai', `routing_decisions?organization_id=eq.${ORG}&select=*&limit=200`)).json,
    runs: (await rest('GET', 'ai', `agent_runs?organization_id=eq.${ORG}&agent_key=eq.sales&select=*&order=created_at.desc&limit=100`)).json,
    steps: (await rest('GET', 'ai', 'agent_steps?select=request,response,error&order=created_at.desc&limit=200')).json,
    audit: (await rest('GET', 'audit', 'audit_log?select=before,after&order=created_at.desc&limit=300')).json,
    alerts: (await rest('GET', 'core', 'alerts?select=summary&order=created_at.desc&limit=100')).json,
    keyStatus: (await fx.call(owner.token, 'POST', 'ai', 'rpc/provider_key_status', {})).json,
  });
  check(!Object.values(SECRETS).some((s) => everything.includes(s)) && !Object.values(SECRETS).some((s) => everything.includes(s.slice(0, 22))), 'none of the three keys appears in a decision, run, step, audit row, alert or key status');
} catch (e) {
  console.error(e);
  failures += 1;
} finally {
  stub.closeAllConnections();
  stub.close();
  // Leave the organization as found.
  await rest('PATCH', 'ai', 'agents?key=eq.sales', { enabled: savedAgent?.enabled ?? true, default_model: savedAgent?.default_model }).catch(() => {});
  await rest('DELETE', 'ai', `agent_model_assignments?organization_id=eq.${ORG}&agent_key=eq.sales`).catch(() => {});
  await rest('DELETE', 'ai', `agent_routing_overrides?organization_id=eq.${ORG}&agent_key=eq.sales&category=eq.client_facing`).catch(() => {});
  await rest('PATCH', 'ai', `routing_settings?organization_id=eq.${ORG}`, { mode: savedMode }).catch(() => {});
  await rest('DELETE', 'core', 'alerts?fingerprint=eq.router-manual:sales').catch(() => {});
  await rest('PATCH', 'ai', `providers?provider_id=in.(${created.providers.join(',')})`, { enabled: false, archived_at: new Date().toISOString() }).catch(() => {});
  await fx.cleanup().catch(() => {});
  console.log(`\n${failures === 0 ? '\x1b[32m✔' : '\x1b[31m✖'} ${checks - failures}/${checks} checks passed\x1b[0m`);
  process.exit(failures === 0 ? 0 : 1);
}
