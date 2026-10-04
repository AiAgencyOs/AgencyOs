import 'server-only';

import { createAdminClient } from '@/lib/db/admin';
import { serverEnv } from '@/lib/env';
import { err, ok, type Result } from '@/lib/result';

import type { discoverModels, ProviderEndpoint } from './provider-discovery';
import { decrypt } from './vault';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Where a provider lives and which key to probe it with - shared by the Admin's Test / Refresh buttons and the background sweep, so a
 * probe is the same call whoever asks. The key is decrypted in memory for the one request and never returned to a browser.
 */

export async function endpointAndSecret(providerId: string, keyId: string | null): Promise<Result<{ endpoint: ProviderEndpoint; secret: string; keyId: string | null }>> {
  const admin = createAdminClient();
  const { data: provider } = await admin.schema('ai').from('providers').select('*').eq('provider_id', providerId).maybeSingle();
  if (!provider) return err('NOT_FOUND', 'That provider was not found.');
  const { data: keys } = await admin
    .schema('ai')
    .from('provider_keys')
    .select('id, ciphertext, iv, auth_tag, enabled, priority, label, health_state')
    .eq('provider_id', providerId)
    .order('priority')
    .order('label');
  const candidates = (keys ?? []).filter((k) => (keyId ? k.id === keyId : k.enabled && k.health_state !== 'auth_error'));
  const key = candidates[0];
  if (!key) {
    // The environment key of a built-in is a key too: the same test applies to it.
    const env = serverEnv() as unknown as Record<string, string | undefined>;
    const envKey = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY', xai: 'XAI_API_KEY', openrouter: 'OPENROUTER_API_KEY' }[providerId];
    const fromEnv = envKey ? env[envKey]?.trim() : undefined;
    if (!keyId && fromEnv) {
      return ok({ endpoint: endpointOf(provider), secret: fromEnv, keyId: null });
    }
    return err('CONFLICT', 'This provider has no usable key to test with. Add a key first.');
  }
  try {
    return ok({ endpoint: endpointOf(provider), secret: decrypt(key.ciphertext, key.iv, key.auth_tag), keyId: key.id });
  } catch {
    return err('CONFLICT', 'The stored key could not be decrypted (VAULT_ENCRYPTION_KEY changed since it was stored). Rotate the key.');
  }
}

function endpointOf(p: { kind: string; base_url: string; auth_scheme: string; models_path: string; extra_headers: unknown; api_version: string | null; timeout_ms: number; provider_id: string }): ProviderEndpoint {
  const env = serverEnv() as unknown as Record<string, string | undefined>;
  const override = { anthropic: 'ANTHROPIC_BASE_URL', openai: 'OPENAI_BASE_URL', gemini: 'GEMINI_BASE_URL', xai: 'XAI_BASE_URL', openrouter: 'OPENROUTER_BASE_URL' }[p.provider_id];
  return {
    kind: p.kind as ProviderEndpoint['kind'],
    baseUrl: (override ? env[override]?.trim() : undefined) || p.base_url,
    authScheme: p.auth_scheme === 'x-api-key' ? 'x-api-key' : 'bearer',
    modelsPath: p.models_path,
    extraHeaders: (p.extra_headers ?? {}) as Record<string, string>,
    apiVersion: p.api_version,
    timeoutMs: Math.min(p.timeout_ms, 15_000),
  };
}

/** Record what a probe learned about the provider and, when a stored key made it, about that key. The same record whoever probed. */
export async function recordProbe(
  admin: Admin,
  providerId: string,
  keyId: string | null,
  outcome: Awaited<ReturnType<typeof discoverModels>>,
): Promise<void> {
  await admin.schema('ai').rpc('record_provider_health', { p_provider_id: providerId, p_state: outcome.state, p_detail: outcome.detail, p_latency_ms: outcome.latencyMs, p_counted: false });
  if (keyId) {
    await admin.schema('ai').rpc('record_key_outcome', {
      p_key_id: keyId,
      p_ok: outcome.ok,
      p_error: outcome.ok ? '' : outcome.detail,
      p_kind: outcome.ok ? 'ok' : outcome.state === 'auth_error' ? 'auth' : outcome.state === 'rate_limited' ? 'rate_limit' : outcome.state === 'quota_exhausted' ? 'quota' : 'unavailable',
      // Only a rate limit or an exhausted quota rests a key; a vendor outage says nothing about the key.
      p_cooldown_seconds: outcome.state === 'rate_limited' || outcome.state === 'quota_exhausted' ? 60 : 0,
    });
  }
}
