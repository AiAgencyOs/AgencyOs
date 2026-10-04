import 'server-only';

import { createAdminClient } from '@/lib/db/admin';
import { serverEnv } from '@/lib/env';
import { err, ok, type Result } from '@/lib/result';

import { createClaudeProvider } from './claude';
import { createChatCompletionsProvider, reasoningEffort, type ChatCompletionsConfig } from './chat-completions';
import { failureKindOf, providerUnavailable } from './failure';
import { consequenceOf, keyEligibility, modelMatches, orderUsableKeys, type HealthState, type KeyState, type ProviderKind } from './provider-match';
import type { AiProvider, StructuredRequest, StructuredResponse, ToolCallResponse, ToolUseRequest } from './types';
import { decrypt } from './vault';

/**
 * The provider registry, built from DATA (ai.providers + ai.provider_keys) instead of a constant.
 *
 *   • Every provider the Admin has enabled and that has at least one usable key is a candidate; a model is served by the first
 *     (lowest priority number) whose match rule fits it, or by the provider a manual assignment names.
 *   • A provider with several keys becomes ONE provider that rotates through them: a rejected key is parked until a person acts,
 *     a rate-limited key rests, and the next key serves the same request. Only failures that are about THE KEY rotate - a missing
 *     model or a vendor outage would fail the same on every key and is returned as it is.
 *   • The environment still wins: an env key for a built-in provider (the hosting dashboard, the CI stubs) is the first key tried
 *     and a loopback base-URL override still points the adapter at the harness.
 *   • Nothing here returns, logs or serialises a key. The only function that holds one is the adapter it was handed to.
 *
 * Built lazily and cached for a short time rather than for the life of the process: an Admin who disables a provider or a key
 * must not have to wait for a redeploy, and key health changes with every call.
 */

type ProviderRow = {
  provider_id: string;
  kind: string;
  display_name: string;
  is_builtin: boolean;
  enabled: boolean;
  base_url: string;
  auth_scheme: string;
  match_prefixes: string[];
  match_contains: string[];
  extra_headers: Record<string, string>;
  timeout_ms: number;
  retry_max: number;
  priority: number;
  archived_at: string | null;
};

type KeyRow = {
  id: string;
  provider_id: string;
  label: string;
  ciphertext: string;
  iv: string;
  auth_tag: string;
  enabled: boolean;
  priority: number;
  health_state: string;
  cooldown_until: string | null;
};

type KeyInstance = KeyState & { readonly keyId: string | null; readonly adapter: AiProvider };

export type RegisteredProvider = {
  readonly id: string;
  readonly displayName: string;
  readonly kind: ProviderKind;
  readonly priority: number;
  readonly provider: AiProvider;
};

const TTL_MS = 20_000;
let cache: { at: number; value: Promise<readonly RegisteredProvider[]> } | null = null;

/** Forgets the registry: the next call rebuilds it from the database and the environment as they are NOW. */
export function resetProviderRegistry(): void {
  cache = null;
}

// ── the built-in adapters' own quirks (kept from providers.ts; the data says WHERE and WHICH, the code says HOW) ──

const BUILTIN_ENV: Record<string, { key: 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY' | 'GEMINI_API_KEY' | 'XAI_API_KEY' | 'OPENROUTER_API_KEY'; base: 'ANTHROPIC_BASE_URL' | 'OPENAI_BASE_URL' | 'GEMINI_BASE_URL' | 'XAI_BASE_URL' | 'OPENROUTER_BASE_URL' }> = {
  anthropic: { key: 'ANTHROPIC_API_KEY', base: 'ANTHROPIC_BASE_URL' },
  openai: { key: 'OPENAI_API_KEY', base: 'OPENAI_BASE_URL' },
  gemini: { key: 'GEMINI_API_KEY', base: 'GEMINI_BASE_URL' },
  xai: { key: 'XAI_API_KEY', base: 'XAI_BASE_URL' },
  openrouter: { key: 'OPENROUTER_API_KEY', base: 'OPENROUTER_BASE_URL' },
};

function chatTweaks(providerId: string): Partial<ChatCompletionsConfig> {
  switch (providerId) {
    case 'openai':
      return {
        maxTokensParam: 'max_completion_tokens',
        effort: (model, effort) => (/^(o[1-9]|gpt-5)/.test(model) && !/-chat/.test(model) ? { reasoning_effort: reasoningEffort(effort) } : {}),
        keyPatterns: [/sk-[A-Za-z0-9_-]{10,}/g],
      };
    case 'gemini':
      return { keyPatterns: [/AIza[A-Za-z0-9_-]{20,}/g] };
    case 'xai':
      return { keyPatterns: [/xai-[A-Za-z0-9_-]{10,}/g] };
    case 'openrouter':
      return { keyPatterns: [/sk-or-[A-Za-z0-9_-]{10,}/g, /sk-[A-Za-z0-9_-]{10,}/g] };
    default:
      return { keyPatterns: [/sk-[A-Za-z0-9_-]{10,}/g, /[A-Za-z0-9_-]{32,}/g] };
  }
}

async function buildAdapter(row: ProviderRow, apiKey: string): Promise<AiProvider | null> {
  const env = serverEnv() as unknown as Record<string, string | undefined>;
  const builtin = BUILTIN_ENV[row.provider_id];
  // A loopback override from the environment (the harness) beats the stored URL for a built-in; a stored URL is otherwise the truth.
  const baseUrl = (builtin ? env[builtin.base]?.trim() : undefined) || row.base_url;
  const supports = (model: string) => modelMatches({ prefixes: row.match_prefixes, contains: row.match_contains }, model);

  if (row.kind === 'anthropic' || row.kind === 'anthropic_compat') {
    const defaultHost = row.provider_id === 'anthropic' && row.base_url === 'https://api.anthropic.com';
    return createClaudeProvider({
      id: row.provider_id,
      apiKey,
      // The SDK's own default host is right for the real API; only a custom or overridden URL is passed through.
      ...(defaultHost && !(builtin && env[builtin.base]?.trim()) ? {} : { baseUrl }),
      timeoutMs: row.timeout_ms,
      supports,
    });
  }
  return createChatCompletionsProvider({
    id: row.provider_id,
    name: row.display_name,
    baseUrl,
    apiKey,
    supports,
    headers: row.extra_headers ?? {},
    authScheme: row.auth_scheme === 'x-api-key' ? 'x-api-key' : 'bearer',
    timeoutMs: row.timeout_ms,
    keyPatterns: [],
    ...chatTweaks(row.provider_id),
  });
}

// ── what happened is written down, best effort: a health write never fails a call ──

type Reporter = {
  key(keyId: string, outcome: { ok: boolean; error: string; kind: 'ok' | 'auth' | 'rate_limit' | 'quota' | 'unavailable' | 'other'; cooldownSeconds: number }): void;
  provider(providerId: string, state: HealthState, detail: string, latencyMs: number): void;
};

function databaseReporter(): Reporter {
  const write = (fn: () => PromiseLike<unknown>) => {
    try {
      void Promise.resolve(fn()).catch(() => undefined);
    } catch {
      // never fail a model call because a health row could not be written
    }
  };
  return {
    key: (keyId, o) =>
      write(() =>
        createAdminClient().schema('ai').rpc('record_key_outcome', { p_key_id: keyId, p_ok: o.ok, p_error: o.error, p_kind: o.kind, p_cooldown_seconds: o.cooldownSeconds }),
      ),
    provider: (providerId, state, detail, latencyMs) =>
      write(() => createAdminClient().schema('ai').rpc('record_provider_health', { p_provider_id: providerId, p_state: state, p_detail: detail, p_latency_ms: latencyMs, p_counted: true })),
  };
}

/**
 * One provider over several keys. Exported for the tests, which hand it fake adapters and a recording reporter.
 *
 * The in-memory `local` map is the state of keys that have no database row (the environment key): without it a rate-limited env
 * key would be hammered on every call until the registry's next rebuild.
 */
export function createKeyedProvider(args: {
  id: string;
  displayName: string;
  supports: (model: string) => boolean;
  keys: readonly KeyInstance[];
  reporter: Reporter;
  now?: () => Date;
}): AiProvider {
  const now = args.now ?? (() => new Date());
  // What this process has learned since the registry was built, for EVERY key: the stored state is only reloaded when the registry
  // is rebuilt, so without this a key rejected a moment ago would be asked again until then.
  const local = new Map<string, { until: Date | null; auth: boolean }>();
  const slot = (k: KeyInstance) => k.keyId ?? `label:${k.label}`;
  const stateOf = (k: KeyInstance): KeyState => {
    const l = local.get(slot(k));
    return { ...k, health: l?.auth ? 'auth_error' : k.health, cooldownUntil: l?.until ?? k.cooldownUntil };
  };

  async function through<T>(call: (adapter: AiProvider) => Promise<Result<T>>): Promise<Result<T>> {
    const usable = orderUsableKeys(args.keys.map((k) => ({ ...stateOf(k), instance: k })), now());
    if (usable.length === 0) {
      const reasons = args.keys.map((k) => `${k.label}: ${keyEligibility(stateOf(k), now()).usable ? 'usable' : (keyEligibility(stateOf(k), now()) as { reason: string }).reason}`).join(', ');
      return providerUnavailable(`${args.displayName} has no usable key right now (${reasons || 'none configured'}).`, 'auth');
    }

    let last: Result<T> | null = null;
    for (const entry of usable) {
      const key = entry.instance;
      const started = Date.now();
      const result = await call(key.adapter);
      const latency = Date.now() - started;
      if (result.ok) {
        if (key.keyId) args.reporter.key(key.keyId, { ok: true, error: '', kind: 'ok', cooldownSeconds: 0 });
        local.delete(slot(key));
        args.reporter.provider(args.id, 'healthy', '', latency);
        return result;
      }

      last = result;
      const kind = failureKindOf(result.error);
      const consequence = consequenceOf(kind, result.error.message);
      // A refusal or a malformed request says nothing about the key: no health change, and no rotation.
      const aboutTheKey = kind !== null;
      if (aboutTheKey) {
        if (key.keyId) args.reporter.key(key.keyId, { ok: false, error: result.error.message, kind: consequence.keyKind, cooldownSeconds: consequence.cooldownSeconds });
        local.set(slot(key), { auth: consequence.keyKind === 'auth', until: consequence.cooldownSeconds > 0 ? new Date(now().getTime() + consequence.cooldownSeconds * 1000) : null });
        args.reporter.provider(args.id, consequence.providerState, result.error.message, latency);
      }
      if (!aboutTheKey || !consequence.tryNextKey) return result;
    }
    return last as Result<T>;
  }

  const adapters = args.keys.map((k) => k.adapter);
  const allTool = adapters.length > 0 && adapters.every((a) => typeof a.generateWithTools === 'function');

  return {
    id: args.id,
    supports: args.supports,
    generateStructured: (request: StructuredRequest): Promise<Result<StructuredResponse>> => through((a) => a.generateStructured(request)),
    ...(allTool
      ? { generateWithTools: (request: ToolUseRequest): Promise<Result<ToolCallResponse>> => through((a) => (a.generateWithTools as NonNullable<AiProvider['generateWithTools']>)(request)) }
      : {}),
  };
}

async function loadFromDatabase(): Promise<{ providers: ProviderRow[]; keys: KeyRow[] } | null> {
  // No encryption key, nothing can be decrypted: the database is not consulted (this also keeps every hermetic test off the network).
  if (!serverEnv().VAULT_ENCRYPTION_KEY) return null;
  try {
    const admin = createAdminClient();
    const [providers, keys] = await Promise.all([
      admin.schema('ai').from('providers').select('*').is('archived_at', null).order('priority').order('provider_id'),
      admin.schema('ai').from('provider_keys').select('id, provider_id, label, ciphertext, iv, auth_tag, enabled, priority, health_state, cooldown_until'),
    ]);
    if (providers.error || keys.error) return null;
    return { providers: providers.data as unknown as ProviderRow[], keys: keys.data as unknown as KeyRow[] };
  } catch {
    return null;
  }
}

const BUILTIN_DEFAULTS: readonly Omit<ProviderRow, 'archived_at'>[] = [
  { provider_id: 'anthropic', kind: 'anthropic', display_name: 'Anthropic (Claude)', is_builtin: true, enabled: true, base_url: 'https://api.anthropic.com', auth_scheme: 'x-api-key', match_prefixes: ['claude-'], match_contains: [], extra_headers: {}, timeout_ms: 60000, retry_max: 1, priority: 10 },
  { provider_id: 'openai', kind: 'openai_compat', display_name: 'OpenAI', is_builtin: true, enabled: true, base_url: 'https://api.openai.com/v1', auth_scheme: 'bearer', match_prefixes: ['gpt-', 'chatgpt-', 'o1', 'o2', 'o3', 'o4', 'o5', 'o6', 'o7', 'o8', 'o9'], match_contains: [], extra_headers: {}, timeout_ms: 60000, retry_max: 1, priority: 20 },
  { provider_id: 'gemini', kind: 'openai_compat', display_name: 'Google Gemini', is_builtin: true, enabled: true, base_url: 'https://generativelanguage.googleapis.com/v1beta/openai', auth_scheme: 'bearer', match_prefixes: ['gemini-'], match_contains: [], extra_headers: {}, timeout_ms: 60000, retry_max: 1, priority: 30 },
  { provider_id: 'xai', kind: 'openai_compat', display_name: 'xAI (Grok)', is_builtin: true, enabled: true, base_url: 'https://api.x.ai/v1', auth_scheme: 'bearer', match_prefixes: ['grok-'], match_contains: [], extra_headers: {}, timeout_ms: 60000, retry_max: 1, priority: 40 },
  { provider_id: 'openrouter', kind: 'openai_compat', display_name: 'OpenRouter', is_builtin: true, enabled: true, base_url: 'https://openrouter.ai/api/v1', auth_scheme: 'bearer', match_prefixes: [], match_contains: ['/'], extra_headers: { 'HTTP-Referer': 'https://agencyos.app', 'X-Title': 'AgencyOS' }, timeout_ms: 60000, retry_max: 1, priority: 900 },
];

async function build(): Promise<readonly RegisteredProvider[]> {
  const env = serverEnv() as unknown as Record<string, string | undefined>;
  const db = await loadFromDatabase();
  // With no database (or a failed read) the five built-ins stand exactly as before, on their environment keys.
  const rows: ProviderRow[] = db ? db.providers : BUILTIN_DEFAULTS.map((p) => ({ ...p, archived_at: null }));
  const now = new Date();
  const out: RegisteredProvider[] = [];

  for (const row of rows) {
    if (!row.enabled || row.archived_at) continue;
    const instances: KeyInstance[] = [];

    // 1. the environment key of a built-in: the hosting dashboard's value, never shadowed by a stored one.
    const builtin = BUILTIN_ENV[row.provider_id];
    const envKey = builtin ? env[builtin.key]?.trim() : undefined;
    if (envKey) {
      const adapter = await buildAdapter(row, envKey);
      if (adapter) instances.push({ keyId: null, label: 'environment', enabled: true, health: 'unknown', priority: 0, cooldownUntil: null, adapter });
    }

    // 2. the stored keys
    for (const k of db?.keys.filter((x) => x.provider_id === row.provider_id) ?? []) {
      let secret: string;
      try {
        secret = decrypt(k.ciphertext, k.iv, k.auth_tag);
      } catch {
        // A key that cannot be decrypted (VAULT_ENCRYPTION_KEY rotated or wrong) is reported as unusable, never thrown mid-request.
        continue;
      }
      const adapter = await buildAdapter(row, secret);
      if (adapter) {
        instances.push({
          keyId: k.id, label: k.label, enabled: k.enabled, health: (k.health_state as HealthState) ?? 'unknown', priority: k.priority,
          cooldownUntil: k.cooldown_until ? new Date(k.cooldown_until) : null, adapter,
        });
      }
    }

    if (instances.length === 0) continue;
    if (orderUsableKeys(instances, now).length === 0 && !instances.some((i) => i.enabled)) continue;

    out.push({
      id: row.provider_id,
      displayName: row.display_name,
      kind: row.kind as ProviderKind,
      priority: row.priority,
      provider: createKeyedProvider({
        id: row.provider_id,
        displayName: row.display_name,
        supports: (m) => modelMatches({ prefixes: row.match_prefixes, contains: row.match_contains }, m),
        keys: instances,
        reporter: databaseReporter(),
      }),
    });
  }
  return out.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

function registry(): Promise<readonly RegisteredProvider[]> {
  if (!cache || Date.now() - cache.at > TTL_MS) cache = { at: Date.now(), value: build() };
  return cache.value;
}

export async function registeredProviders(): Promise<readonly RegisteredProvider[]> {
  return registry();
}

/** The ids of every provider that is enabled and has a key - never a key. */
export async function configuredProviderIds(): Promise<readonly string[]> {
  return (await registry()).map((p) => p.id);
}

/**
 * The provider that serves a model.
 *
 * With `providerId` (a manual assignment) exactly that provider is used - it must be enabled and have a key, and the model id is
 * NOT required to match its recognition rule (a custom gateway's models have arbitrary ids). Without it, the first provider by
 * priority whose rule fits the model serves it, which is the behaviour the router has always had.
 */
export async function resolveRegisteredProvider(model: string, options: { providerId?: string } = {}): Promise<Result<AiProvider>> {
  const all = await registry();
  if (options.providerId) {
    const pinned = all.find((p) => p.id === options.providerId);
    if (!pinned) {
      return err('PROVIDER_ERROR', `Provider "${options.providerId}" is disabled, archived or has no usable key, so model "${model}" cannot be served by it.`);
    }
    return ok(pinned.provider);
  }
  const found = all.find((p) => p.provider.supports(model));
  if (!found) {
    return err(
      'PROVIDER_ERROR',
      all.length === 0
        ? `No AI provider is configured, so model "${model}" cannot be served. Add a provider key in the AI Provider Manager (or set a provider key in the hosting environment).`
        : `No configured AI provider serves model "${model}" (registered: ${all.map((p) => p.id).join(', ')}).`,
    );
  }
  return ok(found.provider);
}
