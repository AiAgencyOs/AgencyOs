import 'server-only';

import { lookup } from 'node:dns/promises';

import { serverEnv } from '@/lib/env';

import { consequenceOf, type FailureKindName, type HealthState, type ProviderKind } from './provider-match';
import { checkProviderBaseUrl, isPrivateAddress, privateHostsAllowed } from './provider-url';

/**
 * Asking a provider what it can do: is the key accepted, and which models does it serve.
 *
 * The one place the server connects to an Admin-typed URL outside an inference call, so it is the one place that holds the
 * address policy (https, no credentials in the URL, no loopback/private/metadata address - checked on the literal host AND on what
 * the name resolves to) and a response-size cap. It returns normalised facts and a health state; it never returns, logs or echoes
 * the key, and any text a vendor sends back is redacted of the key before it is kept.
 *
 * Providers that serve inference but have no usable models endpoint are not a failure here: `models` comes back empty with the
 * reason, and the Admin registers models by hand.
 */

export type ProviderEndpoint = {
  kind: ProviderKind;
  baseUrl: string;
  authScheme: 'bearer' | 'x-api-key';
  modelsPath: string;
  extraHeaders: Record<string, string>;
  apiVersion?: string | null;
  timeoutMs?: number;
};

export type DiscoveredModel = { id: string; displayName?: string; contextTokens?: number };

export type DiscoveryOutcome = {
  ok: boolean;
  state: HealthState;
  detail: string;
  latencyMs: number;
  models: DiscoveredModel[];
  /** True when the vendor answered but exposes no models list we can read (manual registration is the way forward). */
  noModelList: boolean;
};

const MAX_BODY = 2_000_000;
const DEFAULT_TIMEOUT = 10_000;

function redact(text: string, secret: string): string {
  return secret ? text.split(secret).join('[redacted]') : text;
}

async function addressPolicy(baseUrl: string): Promise<{ ok: true; url: URL } | { ok: false; reason: string }> {
  const allowPrivate = privateHostsAllowed(serverEnv() as unknown as { NODE_ENV?: string } & Record<string, string | undefined>);
  const checked = checkProviderBaseUrl(baseUrl, { allowPrivate });
  if (!checked.ok || allowPrivate) return checked;
  // A public-looking NAME can still resolve to an internal address; check what it resolves to before connecting.
  try {
    const records = await lookup(checked.url.hostname, { all: true });
    if (records.some((r) => isPrivateAddress(r.address))) {
      return { ok: false, reason: 'That host resolves to an internal address, so the server will not connect to it.' };
    }
  } catch {
    return { ok: false, reason: 'That host name could not be resolved.' };
  }
  return checked;
}

function normalise(kind: ProviderKind, body: unknown): DiscoveredModel[] {
  const out: DiscoveredModel[] = [];
  const list: unknown[] = Array.isArray((body as { data?: unknown })?.data)
    ? ((body as { data: unknown[] }).data)
    : Array.isArray((body as { models?: unknown })?.models)
      ? ((body as { models: unknown[] }).models)
      : Array.isArray(body)
        ? (body as unknown[])
        : [];
  for (const raw of list) {
    const m = raw as Record<string, unknown>;
    let id = typeof m.id === 'string' ? m.id : typeof m.name === 'string' ? m.name : '';
    // Gemini's own listing names models "models/gemini-2.5-pro"; the id agents use is the part after the slash.
    if (kind !== 'anthropic' && id.startsWith('models/')) id = id.slice('models/'.length);
    id = id.trim();
    if (!id || id.length > 200) continue;
    const display = typeof m.display_name === 'string' ? m.display_name : typeof m.displayName === 'string' ? m.displayName : undefined;
    const ctx = [m.context_length, m.context_window, m.inputTokenLimit, m.max_input_tokens].find((v) => typeof v === 'number' && v > 0) as number | undefined;
    out.push({ id, ...(display ? { displayName: display.slice(0, 120) } : {}), ...(ctx ? { contextTokens: Math.floor(ctx) } : {}) });
  }
  const seen = new Set<string>();
  return out.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
}

/** Connect, authenticate, list models. One bounded request; never throws. */
export async function discoverModels(endpoint: ProviderEndpoint, apiKey: string): Promise<DiscoveryOutcome> {
  const started = Date.now();
  const fail = (state: HealthState, detail: string): DiscoveryOutcome => ({ ok: false, state, detail: redact(detail, apiKey).slice(0, 300), latencyMs: Date.now() - started, models: [], noModelList: false });

  const policy = await addressPolicy(endpoint.baseUrl);
  if (!policy.ok) return fail('unavailable', policy.reason);

  const base = endpoint.baseUrl.replace(/\/$/, '');
  // Anthropic's list lives at /v1/models whatever the configured host; everyone else uses the configured path.
  const path = endpoint.kind === 'anthropic' || endpoint.kind === 'anthropic_compat' ? (endpoint.modelsPath === '/models' ? '/v1/models' : endpoint.modelsPath) : endpoint.modelsPath;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(endpoint.authScheme === 'x-api-key' ? { 'x-api-key': apiKey } : { Authorization: `Bearer ${apiKey}` }),
    ...(endpoint.kind === 'anthropic' || endpoint.kind === 'anthropic_compat' ? { 'anthropic-version': endpoint.apiVersion || '2023-06-01' } : {}),
    ...endpoint.extraHeaders,
  };

  let response: Response;
  let text: string;
  try {
    response = await fetch(`${base}${path}`, { method: 'GET', headers, cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(endpoint.timeoutMs ?? DEFAULT_TIMEOUT) });
    text = (await response.text()).slice(0, MAX_BODY);
  } catch (cause) {
    const timedOut = cause instanceof Error && cause.name === 'TimeoutError';
    return fail('unavailable', timedOut ? 'The provider did not answer in time.' : 'Could not reach the provider.');
  }

  // A redirect would carry the key to a host nobody checked.
  if (response.status >= 300 && response.status < 400) return fail('unavailable', 'The provider redirected the request; a redirect is never followed.');

  if (response.status === 401 || response.status === 403) return fail('auth_error', 'The key was rejected by the provider.');
  if (response.status === 429) return fail(consequenceOf('rate_limit', text).providerState, 'The provider is rate limiting this key.');
  if (response.status >= 500) return fail('unavailable', `The provider answered ${response.status}.`);
  if (response.status === 404 || response.status === 405) {
    // Authenticated, perhaps - but there is no models endpoint to read. Not a failure: register models by hand.
    return { ok: true, state: 'healthy', detail: 'The provider has no readable models list. Register its models by hand.', latencyMs: Date.now() - started, models: [], noModelList: true };
  }
  if (!response.ok) return fail('degraded', `The provider answered ${response.status}.`);

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: true, state: 'degraded', detail: 'The provider answered, but not with a models list we can read. Register models by hand.', latencyMs: Date.now() - started, models: [], noModelList: true };
  }
  const models = normalise(endpoint.kind, body);
  return {
    ok: true,
    state: 'healthy',
    detail: models.length > 0 ? `${models.length} model${models.length === 1 ? '' : 's'} found.` : 'Connected, but the provider listed no models. Register models by hand.',
    latencyMs: Date.now() - started,
    models,
    noModelList: models.length === 0,
  };
}

export type { FailureKindName };
