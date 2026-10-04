#!/usr/bin/env node
/**
 * The AI Provider Manager's database contract - against the real database, as real tokens.
 *
 *   node scripts/verify-ai-providers.mjs
 *
 * What a unit test cannot prove: that the doors refuse who they must, that no path returns a secret, that history survives, and
 * that what the Admin turned off stays off. (The runtime - key rotation, discovery over HTTP, address policy - is proved in
 * tests/ai-provider-manager.test.ts against fake providers; the routing run is proved in verify-ai-routing.mjs.)
 *
 *   1. who may do what: a member reads nothing and writes nothing; an ops admin manages providers, models and keys; ONLY the owner
 *      removes a key, archives or deletes a provider
 *   2. no path returns a secret: not a select, not the status door, not an audit row
 *   3. the five built-ins exist; the legacy keys were carried over unchanged and the old table is frozen
 *   4. a custom provider: it must say how it recognises its models; no credential in a header; a bad id is refused
 *   5. keys: several per provider; a duplicate label is refused; a rejected key stays rejected until a person rotates or re-enables it
 *   6. models: discovered ones arrive DISABLED, an Admin's own setting survives a refresh, a vanished one is marked and never deleted
 *   7. disabling a provider needs a reason and is recorded; a provider with history cannot be deleted
 */

import { Buffer } from 'node:buffer';
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';

import { fixturesFor } from './verify-fixtures.mjs';
import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false, jwt: true });
await announceTarget(target, 'the AI Provider Manager');

const ORG = '00000000-0000-4000-8000-000000000001';
const MARKER = `zzp${randomUUID().slice(0, 6)}`;
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

/** The vault's own cipher (AES-256-GCM, key = sha256 of VAULT_ENCRYPTION_KEY) - the same shape the app stores. */
function seal(secret) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', createHash('sha256').update('a-verification-key-not-a-real-one-32chars').digest(), iv);
  const ct = Buffer.concat([c.update(secret, 'utf8'), c.final()]);
  return { p_ciphertext: ct.toString('base64'), p_iv: iv.toString('base64'), p_auth_tag: c.getAuthTag().toString('base64') };
}

const SECRET_1 = `sk-${MARKER}-first-secret-value-0000`;
const SECRET_2 = `sk-${MARKER}-second-secret-value-1111`;
const PID = `acme-${MARKER}`;
const created = { providers: [] };
let owner;

try {
  owner = await fx.bootstrapOwner(`${MARKER}-o`);
  const ownerTok = owner.token;
  const opsTok = fx.mint(owner.id, 'ops_admin');
  const memberTok = fx.mint(owner.id, 'member');
  const door = (tok, fn, args) => fx.call(tok, 'POST', 'ai', `rpc/${fn}`, args);
  const asOwner = (fn, args) => door(ownerTok, fn, args);
  const asOps = (fn, args) => door(opsTok, fn, args);
  const asMember = (fn, args) => door(memberTok, fn, args);

  const provider = (over = {}) => ({
    p_provider_id: PID, p_kind: 'openai_compat', p_display_name: 'Acme Gateway', p_base_url: 'https://api.acme.example/v1', p_auth_scheme: 'bearer',
    p_match_prefixes: ['acme-'], p_match_contains: [], p_extra_headers: { 'X-Team': 'agency' }, p_timeout_ms: 30000, p_retry_max: 1, p_models_path: '/models', p_api_version: '', p_priority: 150, ...over,
  });

  // ── 1. who may do what ────────────────────────────────────────────────
  section('1. Who may do what');
  const memberCreate = one(await asMember('upsert_provider', provider()));
  check(memberCreate?.outcome === 'forbidden', 'a member cannot add a provider', String(memberCreate?.outcome));
  const memberKeys = (await asMember('provider_key_status', {})).json ?? [];
  check(Array.isArray(memberKeys) && memberKeys.length === 0, 'a member sees no key, not even its label');
  const memberRead = await fx.call(memberTok, 'GET', 'ai', 'providers?select=provider_id');
  check(!memberRead.ok || (memberRead.json ?? []).length === 0, 'and cannot read the provider list', `HTTP ${memberRead.status}`);
  const noActor = await fetch(`${target.url}/rest/v1/rpc/upsert_provider`, { method: 'POST', headers: { apikey: target.serviceKey, 'Content-Type': 'application/json', 'Content-Profile': 'ai' }, body: JSON.stringify(provider()) });
  check(noActor.status === 401 || noActor.status === 403 || ((await noActor.json().catch(() => null))?.[0]?.outcome ?? 'no_actor') === 'no_actor', 'no signed-in person, no change');

  const created1 = one(await asOps('upsert_provider', provider()));
  created.providers.push(PID);
  check(created1?.outcome === 'created', 'an ops admin adds a custom OpenAI-compatible provider', String(created1?.outcome));
  const key1 = one(await asOps('add_provider_key', { p_provider_id: PID, p_label: 'main', p_environment: 'production', ...seal(SECRET_1), p_hint: SECRET_1.slice(-4), p_priority: 10 }));
  check(key1?.outcome === 'added', 'an ops admin adds a key', String(key1?.outcome));
  const memberKeyAdd = one(await asMember('add_provider_key', { p_provider_id: PID, p_label: 'sneaky', p_environment: 'production', ...seal('sk-x'), p_hint: '', p_priority: 1 }));
  check(memberKeyAdd?.outcome === 'forbidden', 'a member cannot add one', String(memberKeyAdd?.outcome));
  const opsRemove = one(await asOps('remove_provider_key', { p_key_id: key1.key_id }));
  check(opsRemove?.outcome === 'owner_only', 'an ops admin cannot REMOVE a key - only the owner can', String(opsRemove?.outcome));
  const opsArchive = one(await asOps('archive_provider', { p_provider_id: PID }));
  check(opsArchive?.outcome === 'owner_only', 'nor archive a provider', String(opsArchive?.outcome));
  const opsDelete = one(await asOps('delete_provider', { p_provider_id: PID }));
  check(opsDelete?.outcome === 'owner_only', 'nor delete one', String(opsDelete?.outcome));

  // ── 2. no path returns a secret ───────────────────────────────────────────
  section('2. No path returns a secret');
  const directOwner = await fx.call(ownerTok, 'GET', 'ai', `provider_keys?provider_id=eq.${PID}&select=ciphertext`);
  check(!directOwner.ok || (directOwner.json ?? []).length === 0, 'even the owner cannot SELECT the key table', `HTTP ${directOwner.status}`);
  const directWrite = await fx.call(ownerTok, 'POST', 'ai', 'provider_keys', { provider_id: PID, label: 'direct', ciphertext: 'a', iv: 'b', auth_tag: 'c' });
  check(!directWrite.ok, 'nor insert into it directly', `HTTP ${directWrite.status}`);
  const status = (await asOps('provider_key_status', { p_provider_id: PID })).json ?? [];
  check(status.length === 1 && status[0].label === 'main' && status[0].hint === SECRET_1.slice(-4), 'the status door shows the label and the last four characters', JSON.stringify(status[0] ?? {}).slice(0, 90));
  check(!JSON.stringify(status).includes(SECRET_1) && !('ciphertext' in (status[0] ?? {})) && !('auth_tag' in (status[0] ?? {})), 'and no ciphertext, no tag, no secret');
  const audits = (await rest('GET', 'audit', `audit_log?action=like.ai_provider*&order=created_at.desc&limit=30&select=action,before,after`)).json ?? [];
  check(audits.some((a) => a.action === 'ai_provider_key.added') && !JSON.stringify(audits).includes(SECRET_1) && !JSON.stringify(audits).includes(SECRET_1.slice(0, 18)), 'every change is audited, and no audit row contains a secret');

  // ── 3. the built-ins and the legacy keys ──────────────────────────────────
  section('3. The five built-ins, and the old single keys');
  const builtins = (await rest('GET', 'ai', 'providers?is_builtin=eq.true&select=provider_id,kind,priority&order=priority')).json ?? [];
  check(builtins.map((b) => b.provider_id).join() === 'anthropic,openai,gemini,xai,openrouter', 'Anthropic, OpenAI, Gemini, xAI and OpenRouter exist as providers, in routing order', builtins.map((b) => b.provider_id).join());
  const legacyWrite = await rest('POST', 'ai', 'provider_credentials', { provider: 'openai', ciphertext: 'a', iv: 'b', auth_tag: 'c', updated_by: owner.id });
  check(!legacyWrite.ok, 'the old single-key table is frozen: nothing can write to it', `HTTP ${legacyWrite.status}`);
  const legacyStatus = (await asOps('provider_credential_status', {})).json ?? [];
  check(legacyStatus.length >= 5, 'the old status door now answers from the new key store', `${legacyStatus.length} providers`);

  // ── 4. a custom provider ──────────────────────────────────────────────────
  section('4. A custom provider: how it recognises its models, and what may be stored');
  const noMatch = one(await asOps('upsert_provider', provider({ p_provider_id: `${PID}-b`, p_match_prefixes: [], p_match_contains: [] })));
  check(noMatch?.outcome === 'invalid', 'a custom provider that cannot say which models are its own is refused', String(noMatch?.outcome));
  const credHeader = one(await asOps('upsert_provider', provider({ p_provider_id: `${PID}-c`, p_extra_headers: { Authorization: 'Bearer sk-leak' } })));
  check(credHeader?.outcome === 'secret_in_headers', 'a credential in a header is refused', String(credHeader?.outcome));
  for (const [what, over] of [['an http host', { p_base_url: 'http://api.acme.example/v1' }], ['a bad identifier', { p_provider_id: 'Bad Id!' }], ['a timeout of a minute and a half hour', { p_timeout_ms: 99999999 }]]) {
    const r = one(await asOps('upsert_provider', provider({ p_provider_id: `${PID}-d`, ...over })));
    check(r?.outcome === 'invalid', `${what} is refused`, String(r?.outcome));
  }
  const edited = one(await asOps('upsert_provider', provider({ p_display_name: 'Acme Gateway (renamed)', p_priority: 120 })));
  check(edited?.outcome === 'updated', 'the same identifier updates it', String(edited?.outcome));
  const builtinEdit = one(await asOps('upsert_provider', provider({ p_provider_id: 'anthropic', p_kind: 'openai_compat', p_display_name: 'Anthropic (Claude)', p_base_url: 'https://api.anthropic.com', p_match_prefixes: ['nope-'], p_priority: 10 })));
  const anth = one(await rest('GET', 'ai', 'providers?provider_id=eq.anthropic&select=kind,match_prefixes'));
  check(builtinEdit?.outcome === 'updated' && anth?.kind === 'anthropic' && anth?.match_prefixes?.[0] === 'claude-', 'a built-in keeps its kind and its model matching whatever is submitted', JSON.stringify(anth));

  // ── 5. keys ───────────────────────────────────────────────────────────────
  section('5. Several keys per provider; a rejected key stays rejected');
  const key2 = one(await asOps('add_provider_key', { p_provider_id: PID, p_label: 'backup', p_environment: 'production', ...seal(SECRET_2), p_hint: SECRET_2.slice(-4), p_priority: 20 }));
  check(key2?.outcome === 'added', 'a second key is added to the same provider', String(key2?.outcome));
  const dup = one(await asOps('add_provider_key', { p_provider_id: PID, p_label: 'backup', p_environment: 'production', ...seal('sk-another-one-1234'), p_hint: '', p_priority: 30 }));
  check(dup?.outcome === 'label_taken', 'a duplicate label is refused', String(dup?.outcome));
  const badProvider = one(await asOps('add_provider_key', { p_provider_id: 'no-such-provider', p_label: 'x', p_environment: 'production', ...seal('sk-another-one-1234'), p_hint: '', p_priority: 30 }));
  check(badProvider?.outcome === 'unknown_provider', 'a key for a provider that does not exist is refused', String(badProvider?.outcome));
  const emptySecret = one(await asOps('add_provider_key', { p_provider_id: PID, p_label: 'empty', p_environment: 'production', p_ciphertext: '', p_iv: '', p_auth_tag: '', p_hint: '', p_priority: 30 }));
  check(emptySecret?.outcome === 'invalid', 'an empty key is refused', String(emptySecret?.outcome));

  const svc = (fn, args) => rest('POST', 'ai', `rpc/${fn}`, args);
  await svc('record_key_outcome', { p_key_id: key1.key_id, p_ok: false, p_error: 'The key was rejected', p_kind: 'auth', p_cooldown_seconds: 0 });
  let k1 = ((await asOps('provider_key_status', { p_provider_id: PID })).json ?? []).find((k) => k.label === 'main');
  check(k1?.health_state === 'auth_error' && k1?.consecutive_failures === 1 && k1?.cooldown_until === null, 'a rejected key is auth_error - and has no cooldown to wait out, it waits for a person', `${k1?.health_state}`);
  await svc('record_key_outcome', { p_key_id: key2.key_id, p_ok: false, p_error: 'Rate limited', p_kind: 'rate_limit', p_cooldown_seconds: 60 });
  const k2 = ((await asOps('provider_key_status', { p_provider_id: PID })).json ?? []).find((k) => k.label === 'backup');
  check(k2?.health_state === 'rate_limited' && Boolean(k2?.cooldown_until), 'a rate-limited key rests until a cooldown ends', `${k2?.health_state}`);
  await svc('record_key_outcome', { p_key_id: key2.key_id, p_ok: true, p_error: '', p_kind: 'ok', p_cooldown_seconds: 0 });
  const k2b = ((await asOps('provider_key_status', { p_provider_id: PID })).json ?? []).find((k) => k.label === 'backup');
  check(k2b?.health_state === 'healthy' && k2b?.cooldown_until === null && k2b?.consecutive_failures === 0, 'a success clears it', `${k2b?.health_state}`);
  const memberOutcome = await fx.call(memberTok, 'POST', 'ai', 'rpc/record_key_outcome', { p_key_id: key1.key_id, p_ok: true, p_error: '', p_kind: 'ok', p_cooldown_seconds: 0 });
  check(!memberOutcome.ok, 'only the runtime (service role) can report an outcome - a signed-in person cannot clear a key\'s failures', `HTTP ${memberOutcome.status}`);

  const rot = one(await asOps('rotate_provider_key', { p_key_id: key1.key_id, ...seal(`sk-${MARKER}-rotated-secret-2222`), p_hint: '2222' }));
  k1 = ((await asOps('provider_key_status', { p_provider_id: PID })).json ?? []).find((k) => k.label === 'main');
  check(rot?.outcome === 'rotated' && k1?.health_state === 'unknown' && k1?.consecutive_failures === 0 && k1?.hint === '2222', 'rotating a key starts it fresh: the rejection belonged to the old value', `${rot?.outcome}/${k1?.health_state}`);
  await svc('record_key_outcome', { p_key_id: key1.key_id, p_ok: false, p_error: 'rejected again', p_kind: 'auth', p_cooldown_seconds: 0 });
  const reenable = one(await asOps('set_provider_key_state', { p_key_id: key1.key_id, p_enabled: false }));
  const reenable2 = one(await asOps('set_provider_key_state', { p_key_id: key1.key_id, p_enabled: true }));
  k1 = ((await asOps('provider_key_status', { p_provider_id: PID })).json ?? []).find((k) => k.label === 'main');
  check(reenable?.outcome === 'saved' && reenable2?.outcome === 'saved' && k1?.health_state === 'unknown', 're-enabling a key is a person\'s decision to try it again, and clears the rejection', `${k1?.health_state}`);

  // ── 6. models ─────────────────────────────────────────────────────────────
  section('6. Models: discovered ones arrive disabled, an Admin\'s settings survive, a vanished one is marked, never deleted');
  const found = one(await asOps('record_discovered_models', { p_provider_id: PID, p_models: [{ id: `acme-fast-${MARKER}`, displayName: 'Acme Fast', contextTokens: 32000 }, { id: `acme-big-${MARKER}` }, { id: '' }] }));
  check(found?.outcome === 'recorded' && found?.added === 2, 'discovery records two new models (and ignores a blank id)', JSON.stringify(found));
  const fast = () => rest('GET', 'ai', `models?model_id=eq.acme-fast-${MARKER}&organization_id=eq.${ORG}&select=enabled,source,status,context_tokens,display_name,quality_tier`).then((r) => one(r));
  let m = await fast();
  check(m?.enabled === false && m?.source === 'discovered' && m?.context_tokens === 32000, 'new models arrive DISABLED - nothing a vendor lists is routed to by itself', JSON.stringify(m));
  const memberEnable = one(await asMember('set_model_enabled', { p_model_id: `acme-fast-${MARKER}`, p_enabled: true }));
  check(memberEnable?.outcome === 'forbidden', 'a member cannot enable a model', String(memberEnable?.outcome));
  const enabled = one(await asOps('set_model_enabled', { p_model_id: `acme-fast-${MARKER}`, p_enabled: true }));
  await rest('PATCH', 'ai', `models?model_id=eq.acme-fast-${MARKER}&organization_id=eq.${ORG}`, { quality_tier: 4, context_tokens: 64000 });
  const refreshed = one(await asOps('record_discovered_models', { p_provider_id: PID, p_models: [{ id: `acme-fast-${MARKER}`, contextTokens: 1 }, { id: `acme-new-${MARKER}` }] }));
  m = await fast();
  check(enabled?.outcome === 'enabled' && m?.enabled === true && m?.quality_tier === 4 && m?.context_tokens === 64000 && m?.display_name === 'Acme Fast', 'a refresh never overwrites what the Admin set (enabled, tier, context)', JSON.stringify(m));
  const big = one(await rest('GET', 'ai', `models?model_id=eq.acme-big-${MARKER}&organization_id=eq.${ORG}&select=status,enabled,source`));
  check(refreshed?.gone === 1 && big?.status === 'deprecated' && big?.source === 'discovered', 'a model the vendor stopped listing is marked deprecated - the row (and its history) stays', JSON.stringify(big));
  const manual = one(await asOps('register_manual_model', { p_provider_id: PID, p_model_id: `acme-manual-${MARKER}`, p_display_name: 'Hand registered', p_capabilities: ['coding', 'structured_output'], p_context_tokens: 16000, p_tool_calling: true, p_structured_output: true }));
  const manualRow = one(await rest('GET', 'ai', `models?model_id=eq.acme-manual-${MARKER}&organization_id=eq.${ORG}&select=source,enabled,status,capabilities`));
  check(manual?.outcome === 'registered' && manualRow?.source === 'manual' && manualRow?.enabled === true, 'a model with no discovery is registered by hand and labelled manual', JSON.stringify(manualRow));
  const badCap = one(await asOps('register_manual_model', { p_provider_id: PID, p_model_id: `acme-bad-${MARKER}`, p_display_name: '', p_capabilities: ['telepathy'], p_context_tokens: 1, p_tool_calling: true, p_structured_output: true }));
  check(badCap?.outcome === 'invalid', 'a capability the system does not know is refused', String(badCap?.outcome));
  const afterGone = one(await asOps('record_discovered_models', { p_provider_id: PID, p_models: [{ id: `acme-big-${MARKER}` }] }));
  const back = one(await rest('GET', 'ai', `models?model_id=eq.acme-big-${MARKER}&organization_id=eq.${ORG}&select=status`));
  check(afterGone?.outcome === 'recorded' && back?.status === 'available', 'a model that comes back is available again', String(back?.status));

  // ── 7. turning a provider off; history ──────────────────────────────────────
  section('7. Turning a provider off; history is never orphaned');
  const noReason = one(await asOps('set_provider_enabled', { p_provider_id: PID, p_enabled: false, p_reason: '  ' }));
  check(noReason?.outcome === 'needs_reason', 'turning a provider off needs a reason - every agent routed to it stops', String(noReason?.outcome));
  const off = one(await asOps('set_provider_enabled', { p_provider_id: PID, p_enabled: false, p_reason: 'verifier: gateway under maintenance' }));
  const row = one(await rest('GET', 'ai', `providers?provider_id=eq.${PID}&select=enabled,health_state`));
  check(off?.outcome === 'disabled' && row?.enabled === false, 'it is disabled', String(off?.outcome));
  await svc('record_provider_health', { p_provider_id: PID, p_state: 'healthy', p_detail: 'probe ok', p_latency_ms: 42 });
  const stillOff = one(await rest('GET', 'ai', `providers?provider_id=eq.${PID}&select=enabled,health_state`));
  check(stillOff?.enabled === false && stillOff?.health_state === 'healthy', 'health is a runtime condition and never switches an Admin\'s decision back on', JSON.stringify(stillOff));
  const del = one(await asOwner('delete_provider', { p_provider_id: PID }));
  check(del?.outcome === 'has_history', 'a provider with models on record cannot be deleted - archive it instead', String(del?.outcome));
  const delBuiltin = one(await asOwner('delete_provider', { p_provider_id: 'openai' }));
  check(delBuiltin?.outcome === 'builtin', 'a built-in is never deleted', String(delBuiltin?.outcome));
  const archived = one(await asOwner('archive_provider', { p_provider_id: PID }));
  const arch = one(await rest('GET', 'ai', `providers?provider_id=eq.${PID}&select=enabled,archived_at`));
  const keysAfter = ((await asOps('provider_key_status', { p_provider_id: PID })).json ?? []).filter((k) => k.enabled);
  check(archived?.outcome === 'archived' && arch?.enabled === false && arch?.archived_at && keysAfter.length === 0, 'the owner archives it: disabled, its keys switched off, the history kept', String(archived?.outcome));
  const reEnable = one(await asOps('set_provider_enabled', { p_provider_id: PID, p_enabled: true }));
  check(reEnable?.outcome === 'archived', 'an archived provider cannot simply be switched back on', String(reEnable?.outcome));
  const lonely = `${PID}-solo`;
  await asOps('upsert_provider', provider({ p_provider_id: lonely }));
  created.providers.push(lonely);
  const delSolo = one(await asOwner('delete_provider', { p_provider_id: lonely }));
  check(delSolo?.outcome === 'deleted', 'a custom provider nothing ever used CAN be deleted, by the owner', String(delSolo?.outcome));
  const delAudit = ((await rest('GET', 'audit', `audit_log?action=eq.ai_provider.deleted&order=created_at.desc&limit=3&select=before`)).json ?? []);
  check(delAudit.some((a) => JSON.stringify(a.before ?? {}).includes(lonely)), 'and the deletion is on the record');
} catch (e) {
  console.error(e);
  failures += 1;
} finally {
  // Leave the registry as found: our custom providers and their models are test data.
  for (const id of created.providers) {
    await rest('DELETE', 'ai', `models?provider=eq.${id}`).catch(() => {});
    await rest('DELETE', 'ai', `provider_keys?provider_id=eq.${id}`).catch(() => {});
    await rest('DELETE', 'ai', `providers?provider_id=eq.${id}`).catch(() => {});
  }
  await fx.cleanup().catch(() => {});
  console.log(`\n${failures === 0 ? '\x1b[32m✔' : '\x1b[31m✖'} ${checks - failures}/${checks} checks passed\x1b[0m`);
  process.exit(failures === 0 ? 0 : 1);
}
