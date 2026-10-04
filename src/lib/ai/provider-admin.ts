import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can, type Capability } from '@/lib/authz/permissions';
import { createAdminClient } from '@/lib/db/admin';
import type { createClient } from '@/lib/db/server';
import { serverEnv } from '@/lib/env';
import { err, ok, type Result } from '@/lib/result';

import { discoverModels, type DiscoveredModel } from './provider-discovery';
import { endpointAndSecret, recordProbe } from './provider-endpoint';
import { checkProviderBaseUrl, privateHostsAllowed } from './provider-url';
import { resetProviderRegistry } from './router';
import { encrypt } from './vault';

type RequestClient = Awaited<ReturnType<typeof createClient>>;
const first = <T>(data: unknown): T | undefined => (Array.isArray(data) ? data[0] : data) as T | undefined;

/**
 * The AI Provider Manager's write surface: providers, keys, models, connection tests, discovery.
 *
 * Thin by design. Every rule - who may, what is audited, what a stored key looks like - lives in the `ai.*` doors; this layer:
 *   • checks the capability so a reader never meets a form they cannot submit (the database asks again),
 *   • encrypts a key BEFORE it leaves the process and never keeps, returns or logs it,
 *   • refuses an unsafe base URL (https only, nothing internal) before it is stored AND again before it is called,
 *   • runs the tests and discovery server-side with the stored key, reporting only what the provider said about itself,
 *   • forgets the cached registry after every change so the running process stops using what was just turned off.
 */

async function gate(capability: Capability): Promise<Result<true>> {
  const context = await requireInternal();
  if (!can(context, capability)) return err('FORBIDDEN', 'You do not have permission to manage AI providers.');
  return ok(true);
}

const allowPrivate = () => privateHostsAllowed(serverEnv() as unknown as { NODE_ENV?: string } & Record<string, string | undefined>);

export type ProviderInput = {
  providerId: string;
  kind: 'anthropic' | 'openai_compat' | 'anthropic_compat';
  displayName: string;
  baseUrl: string;
  authScheme: 'bearer' | 'x-api-key';
  matchPrefixes: string[];
  matchContains: string[];
  extraHeaders: Record<string, string>;
  timeoutMs: number;
  retryMax: number;
  modelsPath: string;
  apiVersion: string;
  priority: number;
};

export async function saveProvider(supabase: RequestClient, input: ProviderInput): Promise<Result<{ created: boolean }>> {
  const g = await gate('ai.provider.manage');
  if (!g.ok) return g;
  const url = checkProviderBaseUrl(input.baseUrl, { allowPrivate: allowPrivate() });
  if (!url.ok) return err('VALIDATION', url.reason);
  const { data, error } = await supabase.schema('ai').rpc('upsert_provider', {
    p_provider_id: input.providerId,
    p_kind: input.kind,
    p_display_name: input.displayName,
    p_base_url: input.baseUrl.trim().replace(/\/$/, ''),
    p_auth_scheme: input.authScheme,
    p_match_prefixes: input.matchPrefixes,
    p_match_contains: input.matchContains,
    p_extra_headers: input.extraHeaders as never,
    p_timeout_ms: input.timeoutMs,
    p_retry_max: input.retryMax,
    p_models_path: input.modelsPath,
    p_api_version: input.apiVersion,
    p_priority: input.priority,
  });
  if (error) return err('INTERNAL', 'Could not save the provider.');
  switch (first<{ outcome?: string }>(data)?.outcome) {
    case 'created':
      resetProviderRegistry();
      return ok({ created: true });
    case 'updated':
      resetProviderRegistry();
      return ok({ created: false });
    case 'secret_in_headers':
      return err('VALIDATION', 'A header that carries a credential cannot be stored here - add the key as a key instead.');
    case 'invalid':
      return err('VALIDATION', 'Check the identifier (lower-case letters, digits, - and _), the URL, and that a custom provider names how it recognises its models.');
    default:
      return err('FORBIDDEN', 'Only the owner or an ops admin may manage providers.');
  }
}

export async function setProviderEnabled(supabase: RequestClient, providerId: string, enabled: boolean, reason: string): Promise<Result<true>> {
  const g = await gate('ai.provider.manage');
  if (!g.ok) return g;
  const { data, error } = await supabase.schema('ai').rpc('set_provider_enabled', { p_provider_id: providerId, p_enabled: enabled, p_reason: reason });
  if (error) return err('INTERNAL', 'Could not change the provider.');
  switch (first<{ outcome?: string }>(data)?.outcome) {
    case 'enabled':
    case 'disabled':
      resetProviderRegistry();
      return ok(true);
    case 'needs_reason':
      return err('VALIDATION', 'Say why you are turning this provider off - every agent routed to it stops.');
    case 'archived':
      return err('CONFLICT', 'That provider is archived.');
    case 'unknown_provider':
      return err('NOT_FOUND', 'That provider was not found.');
    default:
      return err('FORBIDDEN', 'Only the owner or an ops admin may enable or disable a provider.');
  }
}

export async function archiveProvider(supabase: RequestClient, providerId: string): Promise<Result<true>> {
  const g = await gate('ai.provider.manage');
  if (!g.ok) return g;
  const { data, error } = await supabase.schema('ai').rpc('archive_provider', { p_provider_id: providerId });
  if (error) return err('INTERNAL', 'Could not archive the provider.');
  if (first<{ outcome?: string }>(data)?.outcome === 'archived') {
    resetProviderRegistry();
    return ok(true);
  }
  return err('FORBIDDEN', 'Only the owner may archive a provider.');
}

export async function deleteProvider(supabase: RequestClient, providerId: string): Promise<Result<true>> {
  const g = await gate('ai.provider.manage');
  if (!g.ok) return g;
  const { data, error } = await supabase.schema('ai').rpc('delete_provider', { p_provider_id: providerId });
  if (error) return err('INTERNAL', 'Could not delete the provider.');
  switch (first<{ outcome?: string }>(data)?.outcome) {
    case 'deleted':
      resetProviderRegistry();
      return ok(true);
    case 'builtin':
      return err('CONFLICT', 'A built-in provider is never deleted - disable or archive it.');
    case 'has_history':
      return err('CONFLICT', 'This provider has models or runs on record, so it cannot be deleted. Archive it to keep the history.');
    default:
      return err('FORBIDDEN', 'Only the owner may delete a custom provider.');
  }
}

// ── keys ──────────────────────────────────────────────────────────────

export async function addKey(supabase: RequestClient, input: { providerId: string; label: string; environment: 'production' | 'test'; secret: string; priority: number }): Promise<Result<{ keyId: string }>> {
  const g = await gate('ai.credential.manage');
  if (!g.ok) return g;
  const secret = input.secret.trim();
  if (secret.length < 8) return err('VALIDATION', 'That does not look like an API key (too short).');
  if (/\s/.test(secret)) return err('VALIDATION', 'A key has no spaces or line breaks - check that only the key was pasted.');
  if (!serverEnv().VAULT_ENCRYPTION_KEY) return err('VALIDATION', 'VAULT_ENCRYPTION_KEY is not set on this deployment, so nothing can be encrypted.');
  const { ciphertext, iv, authTag } = encrypt(secret);
  const { data, error } = await supabase.schema('ai').rpc('add_provider_key', {
    p_provider_id: input.providerId,
    p_label: input.label,
    p_environment: input.environment,
    p_ciphertext: ciphertext,
    p_iv: iv,
    p_auth_tag: authTag,
    p_hint: secret.length >= 20 ? secret.slice(-4) : '',
    p_priority: input.priority,
  });
  if (error) return err('INTERNAL', 'Could not store the key.');
  const row = first<{ outcome?: string; key_id?: string | null }>(data);
  switch (row?.outcome) {
    case 'added':
      resetProviderRegistry();
      return ok({ keyId: row.key_id as string });
    case 'label_taken':
      return err('CONFLICT', 'This provider already has a key with that label.');
    case 'unknown_provider':
      return err('NOT_FOUND', 'That provider was not found (or is archived).');
    case 'invalid':
      return err('VALIDATION', 'The key or its label was not accepted.');
    default:
      return err('FORBIDDEN', 'Only the owner or an ops admin may add a key.');
  }
}

export async function rotateKey(supabase: RequestClient, keyId: string, secret: string): Promise<Result<true>> {
  const g = await gate('ai.credential.manage');
  if (!g.ok) return g;
  const trimmed = secret.trim();
  if (trimmed.length < 8 || /\s/.test(trimmed)) return err('VALIDATION', 'That does not look like an API key.');
  if (!serverEnv().VAULT_ENCRYPTION_KEY) return err('VALIDATION', 'VAULT_ENCRYPTION_KEY is not set on this deployment, so nothing can be encrypted.');
  const { ciphertext, iv, authTag } = encrypt(trimmed);
  const { data, error } = await supabase.schema('ai').rpc('rotate_provider_key', { p_key_id: keyId, p_ciphertext: ciphertext, p_iv: iv, p_auth_tag: authTag, p_hint: trimmed.length >= 20 ? trimmed.slice(-4) : '' });
  if (error) return err('INTERNAL', 'Could not rotate the key.');
  if (first<{ outcome?: string }>(data)?.outcome === 'rotated') {
    resetProviderRegistry();
    return ok(true);
  }
  return err('NOT_FOUND', 'That key was not found.');
}

export async function setKeyState(supabase: RequestClient, keyId: string, enabled: boolean, priority?: number): Promise<Result<true>> {
  const g = await gate('ai.credential.manage');
  if (!g.ok) return g;
  const { data, error } = await supabase.schema('ai').rpc('set_provider_key_state', { p_key_id: keyId, p_enabled: enabled, p_priority: priority });
  if (error) return err('INTERNAL', 'Could not change the key.');
  if (first<{ outcome?: string }>(data)?.outcome === 'saved') {
    resetProviderRegistry();
    return ok(true);
  }
  return err('NOT_FOUND', 'That key was not found.');
}

export async function removeKey(supabase: RequestClient, keyId: string): Promise<Result<true>> {
  const g = await gate('ai.credential.manage');
  if (!g.ok) return g;
  const { data, error } = await supabase.schema('ai').rpc('remove_provider_key', { p_key_id: keyId });
  if (error) return err('INTERNAL', 'Could not remove the key.');
  switch (first<{ outcome?: string }>(data)?.outcome) {
    case 'removed':
      resetProviderRegistry();
      return ok(true);
    case 'unknown_key':
      return err('NOT_FOUND', 'That key was not found.');
    default:
      return err('FORBIDDEN', 'Only the owner may remove a key.');
  }
}

// ── connection test and discovery (server-side, with the stored key) ──────────

export type TestResult = { ok: boolean; state: string; detail: string; latencyMs: number; modelCount: number; noModelList: boolean };

/** Test the connection with a stored key (or the best usable one) and record what the provider said about itself. */
export async function testProvider(providerId: string, keyId: string | null = null): Promise<Result<TestResult>> {
  const g = await gate('ai.provider.read');
  if (!g.ok) return g;
  const target = await endpointAndSecret(providerId, keyId);
  if (!target.ok) return target;
  const outcome = await discoverModels(target.data.endpoint, target.data.secret);
  await recordProbe(createAdminClient(), providerId, target.data.keyId, outcome);
  resetProviderRegistry();
  return ok({ ok: outcome.ok, state: outcome.state, detail: outcome.detail, latencyMs: outcome.latencyMs, modelCount: outcome.models.length, noModelList: outcome.noModelList });
}

/** Ask the provider which models it serves and record them (new ones arrive DISABLED; vanished ones are marked, never deleted). */
export async function refreshModels(supabase: RequestClient, providerId: string): Promise<Result<{ added: number; refreshed: number; gone: number; detail: string; noModelList: boolean }>> {
  const g = await gate('ai.provider.manage');
  if (!g.ok) return g;
  const target = await endpointAndSecret(providerId, null);
  if (!target.ok) return target;
  const outcome = await discoverModels(target.data.endpoint, target.data.secret);
  const admin = createAdminClient();
  await admin.schema('ai').rpc('record_model_sync', { p_provider_id: providerId, p_ok: outcome.ok, p_detail: outcome.detail });
  await admin.schema('ai').rpc('record_provider_health', { p_provider_id: providerId, p_state: outcome.state, p_detail: outcome.detail, p_latency_ms: outcome.latencyMs, p_counted: false });
  if (!outcome.ok) return err('CONFLICT', outcome.detail);
  if (outcome.models.length === 0) return ok({ added: 0, refreshed: 0, gone: 0, detail: outcome.detail, noModelList: true });

  const { data, error } = await supabase.schema('ai').rpc('record_discovered_models', { p_provider_id: providerId, p_models: outcome.models as unknown as never });
  if (error) return err('INTERNAL', 'Could not record the discovered models.');
  const row = first<{ outcome?: string; added?: number; refreshed?: number; gone?: number }>(data);
  if (row?.outcome !== 'recorded') return err('FORBIDDEN', 'Only the owner or an ops admin may update the model list.');
  resetProviderRegistry();
  return ok({ added: row.added ?? 0, refreshed: row.refreshed ?? 0, gone: row.gone ?? 0, detail: outcome.detail, noModelList: false });
}

export async function registerManualModel(supabase: RequestClient, input: { providerId: string; modelId: string; displayName: string; capabilities: string[]; contextTokens: number | null; toolCalling: boolean | null; structuredOutput: boolean | null }): Promise<Result<true>> {
  const g = await gate('ai.provider.manage');
  if (!g.ok) return g;
  const { data, error } = await supabase.schema('ai').rpc('register_manual_model', {
    p_provider_id: input.providerId,
    p_model_id: input.modelId,
    p_display_name: input.displayName,
    p_capabilities: input.capabilities,
    p_context_tokens: input.contextTokens ?? undefined,
    p_tool_calling: input.toolCalling ?? undefined,
    p_structured_output: input.structuredOutput ?? undefined,
  });
  if (error) return err('INTERNAL', 'Could not register the model.');
  switch (first<{ outcome?: string }>(data)?.outcome) {
    case 'registered':
      return ok(true);
    case 'unknown_provider':
      return err('NOT_FOUND', 'That provider was not found.');
    case 'invalid':
      return err('VALIDATION', 'Check the model id and the capability list.');
    default:
      return err('FORBIDDEN', 'Only the owner or an ops admin may register a model.');
  }
}

/** `providerId` names WHICH provider's offer of the model: the same id can be served by two (the real API and a gateway). */
export async function setModelEnabled(supabase: RequestClient, modelId: string, enabled: boolean, providerId?: string): Promise<Result<true>> {
  const g = await gate('ai.provider.manage');
  if (!g.ok) return g;
  const { data, error } = await supabase.schema('ai').rpc('set_model_enabled', { p_model_id: modelId, p_enabled: enabled, ...(providerId ? { p_provider: providerId } : {}) });
  if (error) return err('INTERNAL', 'Could not change the model.');
  switch (first<{ outcome?: string }>(data)?.outcome) {
    case 'enabled':
    case 'disabled':
      resetProviderRegistry();
      return ok(true);
    case 'unknown_model':
      return err('NOT_FOUND', 'That model was not found.');
    case 'ambiguous':
      return err('CONFLICT', 'Two providers offer that model id - say which one.');
    default:
      return err('FORBIDDEN', 'Only the owner or an ops admin may enable or disable a model.');
  }
}

export type { DiscoveredModel };
