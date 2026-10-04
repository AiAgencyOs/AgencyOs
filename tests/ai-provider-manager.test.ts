import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { after, describe, mock, test } from 'node:test';

import { providerUnavailable } from '../src/lib/ai/failure.ts';
import { consequenceOf, keyEligibility, maskedKey, modelMatches, orderUsableKeys, type KeyState } from '../src/lib/ai/provider-match.ts';
import { checkProviderBaseUrl, isPrivateAddress, privateHostsAllowed } from '../src/lib/ai/provider-url.ts';
import { err, ok } from '../src/lib/result.ts';

const read = (p: string) => readFileSync(p, 'utf8');
const migration = read('supabase/migrations/20261013100000_one_place_for_every_ai_provider.sql');

describe('how a provider recognises its models', () => {
  const openai = { prefixes: ['gpt-', 'chatgpt-', 'o1', 'o3'], contains: [] };
  const router = { prefixes: [], contains: ['/'] };
  test('prefixes and fragments, never patterns', () => {
    assert.equal(modelMatches(openai, 'gpt-5-mini'), true);
    assert.equal(modelMatches(openai, 'o3-mini'), true);
    assert.equal(modelMatches(openai, 'claude-sonnet-5'), false);
    assert.equal(modelMatches(router, 'openai/gpt-5'), true);
    assert.equal(modelMatches(router, 'gpt-5'), false);
    assert.equal(modelMatches({ prefixes: [''], contains: [''] }, 'anything'), false, 'an empty rule matches nothing');
    assert.equal(modelMatches({ prefixes: ['x'], contains: [] }, '  '), false);
  });
});

describe('which key may be tried, and in what order', () => {
  const now = new Date('2026-10-04T10:00:00Z');
  const key = (over: Partial<KeyState> = {}): KeyState => ({ enabled: true, health: 'unknown', priority: 100, cooldownUntil: null, label: 'k', ...over });

  test('a disabled key, a rejected key and a resting key are not tried', () => {
    assert.deepEqual(keyEligibility(key({ enabled: false }), now), { usable: false, reason: 'disabled' });
    assert.deepEqual(keyEligibility(key({ health: 'auth_error' }), now), { usable: false, reason: 'auth_error' });
    assert.deepEqual(keyEligibility(key({ cooldownUntil: new Date('2026-10-04T10:01:00Z') }), now), { usable: false, reason: 'cooling_down' });
    assert.deepEqual(keyEligibility(key({ cooldownUntil: new Date('2026-10-04T09:59:00Z') }), now), { usable: true });
  });

  test('lowest priority first, then healthier first, then by label - deterministic', () => {
    const ordered = orderUsableKeys(
      [key({ label: 'c', priority: 50, health: 'degraded' }), key({ label: 'b', priority: 50, health: 'healthy' }), key({ label: 'a', priority: 10, health: 'unknown' }), key({ label: 'x', health: 'auth_error' })],
      now,
    );
    assert.deepEqual(ordered.map((k) => k.label), ['a', 'b', 'c']);
  });

  test('only a failure about the KEY rotates to another key', () => {
    assert.equal(consequenceOf('auth').tryNextKey, true);
    assert.equal(consequenceOf('rate_limit').tryNextKey, true);
    for (const kind of ['model_missing', 'server', 'timeout', 'network'] as const) assert.equal(consequenceOf(kind).tryNextKey, false, kind);
    assert.equal(consequenceOf(null).tryNextKey, false);
    assert.equal(consequenceOf('rate_limit', 'You exceeded your current quota, please check your billing').providerState, 'quota_exhausted');
    assert.equal(consequenceOf('auth').providerState, 'auth_error');
    // A vendor outage is not about the key: it must never leave the only key resting (found when the fixture verifiers injected 5xx).
    for (const kind of ['server', 'timeout', 'network'] as const) assert.equal(consequenceOf(kind).cooldownSeconds, 0, kind);
  });

  test('a key is only ever shown as its last four characters', () => {
    assert.equal(maskedKey('abcd'), '••••••••••abcd');
    assert.doesNotMatch(maskedKey(null), /[a-z0-9]/i);
  });
});

describe('where a provider may live', () => {
  test('https only, nothing internal, no credentials or query in the URL', () => {
    assert.equal(checkProviderBaseUrl('https://api.example.com/v1', { allowPrivate: false }).ok, true);
    for (const bad of ['http://api.example.com/v1', 'https://user:pass@api.example.com', 'https://api.example.com/v1?key=1', 'ftp://x.example.com', 'not a url', 'https://127.0.0.1/v1', 'https://169.254.169.254/latest', 'https://10.0.0.5', 'https://192.168.1.1', 'https://[::1]/v1', 'https://localhost:8080', 'https://metadata.google.internal', 'https://service.internal']) {
      assert.equal(checkProviderBaseUrl(bad, { allowPrivate: false }).ok, false, bad);
    }
  });

  test('a loopback host works only where the deployment allows it (dev, the test harness)', () => {
    assert.equal(checkProviderBaseUrl('http://127.0.0.1:54399/v1', { allowPrivate: true }).ok, true);
    assert.equal(checkProviderBaseUrl('http://example.com/v1', { allowPrivate: true }).ok, false, 'plain http to a public host is never allowed');
    assert.equal(privateHostsAllowed({ NODE_ENV: 'development' }), true);
    assert.equal(privateHostsAllowed({ NODE_ENV: 'production' }), false);
    assert.equal(privateHostsAllowed({ NODE_ENV: 'production', ANTHROPIC_BASE_URL: 'http://127.0.0.1:54399' }), true, 'the CI harness is recognised by a loopback override');
    assert.equal(privateHostsAllowed({ NODE_ENV: 'production', OPENAI_BASE_URL: 'https://evil.example.com' }), false);
  });

  test('the address ranges that reach inside a network are all recognised', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1', 'localhost']) assert.equal(isPrivateAddress(a), true, a);
    for (const a of ['8.8.8.8', '1.1.1.1', '172.32.0.1', 'api.openai.com']) assert.equal(isPrivateAddress(a), false, a);
  });
});

// ── a provider over several keys ─────────────────────────────────────────────

mock.module('server-only', { exports: {} });
mock.module('@/lib/db/admin', { exports: { createAdminClient: () => ({}) } });
const envState: Record<string, string> = { NODE_ENV: 'test' };
mock.module('@/lib/env', { exports: { serverEnv: () => envState } });

describe('one provider over several keys', async () => {
  const { createKeyedProvider } = await import('../src/lib/ai/provider-registry.ts');
  type Outcome = { id: string; ok: boolean; kind: string };

  function setup(behaviours: Record<string, Array<'ok' | 'auth' | 'rate' | 'missing' | 'server' | 'refusal'>>) {
    const keyLog: Outcome[] = [];
    const providerLog: string[] = [];
    const calls: string[] = [];
    const adapter = (name: string) => ({
      id: 'p',
      supports: () => true,
      generateStructured: async () => {
        calls.push(name);
        const next = behaviours[name]?.shift() ?? 'ok';
        if (next === 'ok') return ok({ json: { from: name }, model: 'm', usage: { inputTokens: 1, outputTokens: 1, costMinor: 0 } });
        if (next === 'auth') return providerUnavailable(`key ${name} rejected`, 'auth');
        if (next === 'rate') return providerUnavailable(`key ${name} rate limited`, 'rate_limit');
        if (next === 'missing') return providerUnavailable('no such model', 'model_missing');
        if (next === 'server') return providerUnavailable('vendor down', 'server');
        return err('PROVIDER_ERROR', 'the model refused');
      },
    });
    const mk = (label: string, priority: number, keyId: string | null, over: Partial<KeyState> = {}) => ({
      keyId, label, enabled: true, health: 'unknown' as const, priority, cooldownUntil: null, adapter: adapter(label), ...over,
    });
    let clock = new Date('2026-10-04T10:00:00Z');
    const provider = (keys: ReturnType<typeof mk>[]) =>
      createKeyedProvider({
        id: 'p', displayName: 'Provider P', supports: () => true, keys,
        reporter: {
          key: (id, o) => keyLog.push({ id, ok: o.ok, kind: o.kind }),
          provider: (_id, state) => providerLog.push(state),
        },
        now: () => clock,
      });
    return { mk, provider, keyLog, providerLog, calls, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
  }
  const req = { model: 'm', system: 's', messages: [], jsonSchema: {}, schemaName: 'X' } as never;

  test('a rejected key is parked and the next key serves the same request', async () => {
    const t = setup({ one: ['auth'] });
    const p = t.provider([t.mk('one', 1, 'k1'), t.mk('two', 2, 'k2')]);
    const r = await p.generateStructured(req);
    assert.equal(r.ok, true);
    assert.deepEqual(t.calls, ['one', 'two']);
    assert.deepEqual(t.keyLog, [{ id: 'k1', ok: false, kind: 'auth' }, { id: 'k2', ok: true, kind: 'ok' }]);
    assert.equal(t.providerLog.at(-1), 'healthy');
  });

  test('a key in the environment (no database row) is parked in memory: never retried after a 401', async () => {
    const t = setup({ environment: ['auth'] });
    const p = t.provider([t.mk('environment', 0, null), t.mk('two', 2, 'k2')]);
    await p.generateStructured(req);
    await p.generateStructured(req);
    assert.deepEqual(t.calls, ['environment', 'two', 'two'], 'the rejected environment key is not asked a second time');
  });

  test('a rate-limited key rests, the other key serves, and the first is tried again once its cooldown ends', async () => {
    const t = setup({ one: ['rate'] });
    const p = t.provider([t.mk('one', 1, null), t.mk('two', 2, 'k2')]);
    await p.generateStructured(req);
    await p.generateStructured(req);
    assert.deepEqual(t.calls, ['one', 'two', 'two'], 'still resting');
    t.advance(61_000);
    await p.generateStructured(req);
    assert.deepEqual(t.calls, ['one', 'two', 'two', 'one'], 'rested for 60 seconds, then back in rotation');
  });

  test('a missing model, a vendor outage and a refusal do NOT rotate: another key would fail the same way', async () => {
    for (const behaviour of ['missing', 'server', 'refusal'] as const) {
      const t = setup({ one: [behaviour] });
      const p = t.provider([t.mk('one', 1, 'k1'), t.mk('two', 2, 'k2')]);
      const r = await p.generateStructured(req);
      assert.equal(r.ok, false, behaviour);
      assert.deepEqual(t.calls, ['one'], `${behaviour}: one request`);
    }
  });

  test('a refusal is about the request, so it leaves the key and the provider health alone', async () => {
    const t = setup({ one: ['refusal'] });
    const p = t.provider([t.mk('one', 1, 'k1')]);
    await p.generateStructured(req);
    assert.deepEqual(t.keyLog, []);
    assert.deepEqual(t.providerLog, []);
  });

  test('every key rejected: the last answer is returned, nothing is retried in a loop', async () => {
    const t = setup({ one: ['auth'], two: ['auth'] });
    const p = t.provider([t.mk('one', 1, 'k1'), t.mk('two', 2, 'k2')]);
    const r = await p.generateStructured(req);
    assert.equal(r.ok, false);
    assert.deepEqual(t.calls, ['one', 'two']);
    const again = await p.generateStructured(req);
    assert.equal(again.ok, false);
    assert.match(again.ok ? '' : again.error.message, /no usable key right now/);
    assert.deepEqual(t.calls, ['one', 'two'], 'a second request asks nobody: both keys are parked until a person acts');
  });

  test('disabled keys and keys in a stored cooldown are skipped from the start', async () => {
    const t = setup({});
    const p = t.provider([t.mk('off', 1, 'k1', { enabled: false }), t.mk('rest', 2, 'k2', { cooldownUntil: new Date('2026-10-04T10:05:00Z') }), t.mk('live', 3, 'k3')]);
    await p.generateStructured(req);
    assert.deepEqual(t.calls, ['live']);
  });

  test('with no key at all it is a named provider-unavailable result, never a throw', async () => {
    const t = setup({});
    const p = t.provider([]);
    const r = await p.generateStructured(req);
    assert.equal(r.ok, false);
    assert.match(r.ok ? '' : r.error.message, /Provider P has no usable key/);
  });
});

// ── asking a provider what it can do ────────────────────────────────────────────

describe('model discovery', async () => {
  const { discoverModels } = await import('../src/lib/ai/provider-discovery.ts');
  let server: Server;
  let port = 0;
  let seen: { url: string; headers: Record<string, string | string[] | undefined> }[] = [];
  let reply: (url: string) => { status: number; body?: unknown; headers?: Record<string, string> } = () => ({ status: 200, body: { data: [] } });
  await new Promise<void>((resolve) => {
    server = createServer((req, res) => {
      seen.push({ url: req.url ?? '', headers: req.headers });
      const r = reply(req.url ?? '');
      res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers ?? {}) });
      res.end(r.body === undefined ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
    }).listen(0, '127.0.0.1', () => { port = (server.address() as { port: number }).port; resolve(); });
  });
  const endpoint = (over: Record<string, unknown> = {}) => ({ kind: 'openai_compat' as const, baseUrl: `http://127.0.0.1:${port}/v1`, authScheme: 'bearer' as const, modelsPath: '/models', extraHeaders: {}, ...over });

  test('an OpenAI-style list is normalised, authenticated with the key, and de-duplicated', async () => {
    seen = [];
    reply = () => ({ status: 200, body: { data: [{ id: 'gpt-x', context_length: 128000 }, { id: 'gpt-x' }, { id: 'o3-mini' }, { nothing: 1 }] } });
    const r = await discoverModels(endpoint(), 'sk-secret-key-1234567890');
    assert.equal(r.ok, true);
    assert.equal(r.state, 'healthy');
    assert.deepEqual(r.models, [{ id: 'gpt-x', contextTokens: 128000 }, { id: 'o3-mini' }]);
    assert.equal(seen[0]?.url, '/v1/models');
    assert.equal(seen[0]?.headers.authorization, 'Bearer sk-secret-key-1234567890');
  });

  test('Anthropic: /v1/models, x-api-key and a version header; Gemini: the models/ prefix is dropped', async () => {
    seen = [];
    reply = () => ({ status: 200, body: { data: [{ id: 'claude-x', display_name: 'Claude X' }] } });
    const a = await discoverModels(endpoint({ kind: 'anthropic', authScheme: 'x-api-key', baseUrl: `http://127.0.0.1:${port}` }), 'sk-ant-key-1234567890');
    assert.deepEqual(a.models, [{ id: 'claude-x', displayName: 'Claude X' }]);
    assert.equal(seen[0]?.url, '/v1/models');
    assert.equal(seen[0]?.headers['x-api-key'], 'sk-ant-key-1234567890');
    assert.equal(seen[0]?.headers['anthropic-version'], '2023-06-01');
    reply = () => ({ status: 200, body: { data: [{ id: 'models/gemini-2.5-pro' }] } });
    const g = await discoverModels(endpoint(), 'AIza-key-1234567890123456');
    assert.deepEqual(g.models.map((m) => m.id), ['gemini-2.5-pro']);
  });

  test('a rejected key is auth_error; a rate limit is rate_limited; a 5xx is unavailable', async () => {
    for (const [status, state] of [[401, 'auth_error'], [403, 'auth_error'], [429, 'rate_limited'], [503, 'unavailable']] as const) {
      reply = () => ({ status, body: { error: 'x' } });
      const r = await discoverModels(endpoint(), 'sk-secret-key-1234567890');
      assert.equal(r.ok, false, String(status));
      assert.equal(r.state, state, String(status));
    }
  });

  test('no models endpoint is NOT a failure: connected, empty, "register by hand"', async () => {
    reply = () => ({ status: 404 });
    const r = await discoverModels(endpoint(), 'sk-secret-key-1234567890');
    assert.equal(r.ok, true);
    assert.equal(r.noModelList, true);
    assert.deepEqual(r.models, []);
    assert.match(r.detail, /Register its models by hand/);
    reply = () => ({ status: 200, body: '<html>not json</html>' });
    const html = await discoverModels(endpoint(), 'sk-secret-key-1234567890');
    assert.equal(html.noModelList, true);
  });

  test('a redirect is never followed (it would carry the key to a host nobody checked)', async () => {
    seen = [];
    reply = () => ({ status: 302, headers: { location: 'http://127.0.0.1:1/steal' } });
    const r = await discoverModels(endpoint(), 'sk-secret-key-1234567890');
    assert.equal(r.ok, false);
    assert.match(r.detail, /redirect/);
    assert.equal(seen.length, 1);
  });

  test('the key never appears in anything it returns', async () => {
    reply = () => ({ status: 401, body: { error: { message: 'bad key sk-secret-key-1234567890' } } });
    const r = await discoverModels(endpoint(), 'sk-secret-key-1234567890');
    assert.doesNotMatch(JSON.stringify(r), /sk-secret-key-1234567890/);
    const unreachable = await discoverModels(endpoint({ baseUrl: 'http://127.0.0.1:1/v1' }), 'sk-secret-key-1234567890');
    assert.equal(unreachable.ok, false);
    assert.doesNotMatch(JSON.stringify(unreachable), /sk-secret-key-1234567890/);
  });

  test('an internal address is refused before any connection when private hosts are not allowed', async () => {
    envState.NODE_ENV = 'production';
    try {
      seen = [];
      const r = await discoverModels(endpoint({ baseUrl: 'https://169.254.169.254/latest' }), 'sk-secret-key-1234567890');
      assert.equal(r.ok, false);
      assert.match(r.detail, /internal/);
      const local = await discoverModels(endpoint(), 'sk-secret-key-1234567890');
      assert.equal(local.ok, false, 'loopback is refused in production');
      assert.equal(seen.length, 0, 'no connection was made');
    } finally {
      envState.NODE_ENV = 'test';
    }
  });

  after(() => {
    server.closeAllConnections();
    server.close();
  });
});

describe('the database holds the line', () => {
  test('keys are readable only through metadata: no policy and no grant for any end-user role', () => {
    assert.match(migration, /alter table ai\.provider_keys enable row level security;/);
    assert.match(migration, /revoke all on table ai\.provider_keys from public, anon, authenticated;/);
    assert.match(migration, /create policy provider_keys_service_only on ai\.provider_keys for all to service_role/);
    assert.doesNotMatch(migration, /grant[^;]*on ai\.provider_keys to[^;]*authenticated/);
    const start = migration.indexOf('create or replace function ai.provider_key_status');
    const body = migration.slice(start, migration.indexOf('revoke all on function ai.provider_key_status', start));
    assert.doesNotMatch(body, /ciphertext|auth_tag|\biv\b/, 'the status door never selects the secret');
  });

  test('removing a key, archiving or deleting a provider is the owner\'s alone; everything else an admin\'s', () => {
    for (const [fn, needsOwner] of [['remove_provider_key', true], ['archive_provider', true], ['delete_provider', true], ['add_provider_key', false], ['rotate_provider_key', false], ['upsert_provider', false], ['set_provider_enabled', false], ['set_model_enabled', false]] as const) {
      const start = migration.indexOf(`create or replace function ai.${fn}(`);
      assert.ok(start > 0, fn);
      const body = migration.slice(start, migration.indexOf('$$;', start));
      assert.ok(body.includes(`ai._provider_actor(${needsOwner})`), `${fn} asks for ${needsOwner ? 'the owner' : 'an admin'}`);
      assert.match(body, /core\.record_audit/, `${fn} is audited`);
    }
  });

  test('a custom provider must say how it recognises its models, and a credential cannot ride in a header', () => {
    assert.match(migration, /providers_match_something check \(is_builtin or cardinality\(match_prefixes\) \+ cardinality\(match_contains\) > 0\)/);
    assert.match(migration, /'authorization', 'x-api-key', 'api-key', 'cookie', 'proxy-authorization'/);
  });

  test('a provider can only be deleted when nothing ever used it', () => {
    const start = migration.indexOf('create or replace function ai.delete_provider');
    const body = migration.slice(start, migration.indexOf('$$;', start));
    assert.match(body, /if v_p\.is_builtin then return query select 'builtin'/);
    assert.match(body, /ai\.models m where m\.provider = p_provider_id[\s\S]{0,200}ai\.agent_steps/);
  });

  test('newly discovered models arrive DISABLED, a vanished one is marked and never deleted, and an Admin\'s own settings are never overwritten', () => {
    const start = migration.indexOf('create or replace function ai.record_discovered_models');
    const body = migration.slice(start, migration.indexOf('$$;', start));
    assert.ok(body.includes("'available', false, 'discovered'"), 'a new model is inserted enabled = false');
    assert.match(body, /set status = 'deprecated'/);
    assert.doesNotMatch(body, /delete from ai\.models/);
    assert.match(body, /Never overwrite what an Admin set by hand/);
  });

  test('the legacy single-key table is frozen after its keys were carried over unchanged', () => {
    assert.match(migration, /insert into ai\.provider_keys[\s\S]{0,300}select c\.provider, 'primary', 'production', c\.ciphertext, c\.iv, c\.auth_tag/);
    assert.match(migration, /before insert or update or delete on ai\.provider_credentials/);
  });

  test('a rotated key starts fresh: the old one\'s failures say nothing about the new value', () => {
    const start = migration.indexOf('create or replace function ai.rotate_provider_key');
    const body = migration.slice(start, migration.indexOf('$$;', start));
    assert.match(body, /health_state = 'unknown', consecutive_failures = 0, cooldown_until = null, last_error = null/);
  });
});

describe('how an Anthropic-compatible provider is authenticated', async () => {
  const { createClaudeProvider } = await import('../src/lib/ai/claude.ts');
  let server: Server;
  let port = 0;
  let headers: Record<string, string | string[] | undefined> = {};
  let sentBody = '';
  await new Promise<void>((resolve) => {
    server = createServer((req, res) => {
      headers = req.headers;
      sentBody = '';
      req.on('data', (c) => { sentBody += c; });
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'no' } }));
    }).listen(0, '127.0.0.1', () => { port = (server.address() as { port: number }).port; resolve(); });
  });
  const call = async (authScheme: 'bearer' | 'x-api-key') => {
    headers = {};
    const p = await createClaudeProvider({ apiKey: 'sk-test-key-123456', authScheme, baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 3000 });
    await p!.generateStructured({ model: 'claude-x', system: 's', messages: [{ role: 'user', content: 'hi' }], jsonSchema: { type: 'object' }, schemaName: 'x' });
  };

  test('a gateway that takes a bearer token gets Authorization: Bearer, and no x-api-key', async () => {
    await call('bearer');
    assert.equal(headers.authorization, 'Bearer sk-test-key-123456');
    assert.equal(headers['x-api-key'], undefined);
  });

  test('and its twin: the real API default still gets x-api-key, and no bearer header', async () => {
    await call('x-api-key');
    assert.equal(headers['x-api-key'], 'sk-test-key-123456');
    assert.equal(headers.authorization, undefined);
  });

  test('a gateway that may ignore the output schema is told the schema in the prompt; the real API default is not', async () => {
    const ask = async (schemaInPrompt: boolean) => {
      const p = await createClaudeProvider({ apiKey: 'sk-test-key-123456', schemaInPrompt, baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 3000 });
      await p!.generateStructured({ model: 'claude-x', system: 'Be brief.', messages: [{ role: 'user', content: 'hi' }], jsonSchema: { type: 'object', properties: { zebra: { type: 'string' } } }, schemaName: 'x' });
      // The request is read after the (401) response, so give the body a moment to arrive.
      await new Promise((r) => setTimeout(r, 50));
      return JSON.parse(sentBody).system as string;
    };
    const withIt = await ask(true);
    assert.ok(withIt.startsWith('Be brief.') && /zebra/.test(withIt) && /nothing else/.test(withIt));
    assert.equal(await ask(false), 'Be brief.');
  });

  test('close', () => { server.closeAllConnections(); server.close(); });
});

describe('reading JSON out of what a model said', async () => {
  const { parseModelJson } = await import('../src/lib/ai/model-json.ts');
  const json = (t: string) => { const r = parseModelJson(t); return r.ok ? r.json : 'FAIL'; };

  test('plain JSON, a fenced block and prose around ONE object are all read', () => {
    assert.deepEqual(json('{"a":1}'), { a: 1 });
    assert.deepEqual(json('```json\n{"a":[1,2]}\n```'), { a: [1, 2] });
    assert.deepEqual(json('```\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(json('Here you go:\n{"a":"x } y","b":{"c":1}}\nHope that helps.'), { a: 'x } y', b: { c: 1 } });
    assert.deepEqual(json('[1,2,3]'), [1, 2, 3]);
  });

  test('and its twins: two values, an unterminated value, or no JSON are refused, never guessed', () => {
    assert.equal(json('{"a":1} and also {"b":2}'), 'FAIL');
    assert.equal(json('{"a":1'), 'FAIL');
    assert.equal(json('I could not do that.'), 'FAIL');
    assert.equal(json(''), 'FAIL');
    assert.equal(json('```json\n{"a":\n```'), 'FAIL');
  });
});

describe('a gateway that answers in prose gets ONE repair attempt', async () => {
  const { createClaudeProvider } = await import('../src/lib/ai/claude.ts');
  let server: Server;
  let port = 0;
  let replies: string[] = [];
  let requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  await new Promise<void>((resolve) => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        requests.push(JSON.parse(body));
        const text = replies.shift() ?? '';
        // A reply starting with "tool:" is carried as a tool_use block with no text block, the way a Bedrock-style gateway does it.
        const content = text.startsWith('tool:') ? [{ type: 'tool_use', id: 't1', name: 'out', input: JSON.parse(text.slice(5)) }] : text ? [{ type: 'text', text }] : [];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-x', stop_reason: 'end_turn', content, usage: { input_tokens: 10, output_tokens: 5 } }));
      });
    }).listen(0, '127.0.0.1', () => { port = (server.address() as { port: number }).port; resolve(); });
  });
  const ask = async (schemaInPrompt: boolean) => {
    const p = await createClaudeProvider({ apiKey: 'sk-test-key-123456', schemaInPrompt, baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 3000 });
    return p!.generateStructured({ model: 'claude-x', system: 's', messages: [{ role: 'user', content: 'go' }], jsonSchema: { type: 'object' }, schemaName: 'x' });
  };

  test('prose first, JSON on the repair: it succeeds, the model was shown what it said, and the tokens of both calls are counted', async () => {
    replies = ["I'll build that now.", '{"a":1}'];
    requests = [];
    const r = await ask(true);
    assert.ok(r.ok);
    assert.deepEqual(r.ok && r.data.json, { a: 1 });
    assert.equal(requests.length, 2);
    assert.equal(requests[1]!.messages.length, 3, 'the original message, what it said, and the correction');
    assert.equal(r.ok && r.data.usage.inputTokens, 20);
  });

  test('an empty answer is re-asked once; two failures in a row are an error, not a loop', async () => {
    replies = ['', '{"a":2}'];
    requests = [];
    assert.deepEqual((await ask(true) as { data: { json: unknown } }).data.json, { a: 2 });
    replies = ['nope', 'still nope'];
    requests = [];
    const bad = await ask(true);
    assert.ok(!bad.ok && /not valid JSON/.test(bad.error.message));
    assert.equal(requests.length, 2);
  });

  test('a gateway that carries the answer as a tool call: the JSON is read from the one call, a string field or the object itself', async () => {
    replies = ['tool:' + JSON.stringify({ content: JSON.stringify({ screens: [1, 2] }) })];
    requests = [];
    const a = await ask(true);
    assert.deepEqual(a.ok && a.data.json, { screens: [1, 2] });
    replies = ['tool:{"screens":[3],"note":"x"}'];
    const b = await ask(true);
    assert.deepEqual(b.ok && b.data.json, { screens: [3], note: 'x' });
    replies = ['tool:{}', 'tool:{}'];
    const c = await ask(true);
    assert.ok(!c.ok && /no output/.test(c.error.message), 'an empty tool call is still "no output", not an invented answer');
  });

  test('its twin: the real API (schema enforced) is never asked twice', async () => {
    replies = ['prose only'];
    requests = [];
    const r = await ask(false);
    assert.ok(!r.ok);
    assert.equal(requests.length, 1);
  });

  test('close', () => { server.closeAllConnections(); server.close(); });
});
