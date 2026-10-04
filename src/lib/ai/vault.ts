import 'server-only';

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { createAdminClient } from '@/lib/db/admin';
import type { createClient } from '@/lib/db/server';
import { serverEnv } from '@/lib/env';
import { hasRole, type RoleSubject } from '@/lib/authz/permissions';
import { err, ok, type Result } from '@/lib/result';

import { orderUsableKeys, type HealthState } from './provider-match';

/**
 * The vault the owner asked for — ADM-84 §9 overturned 2026-09-20.
 *
 * Encrypts a provider key in application code (AES-256-GCM) before it ever
 * reaches Postgres, and decrypts only here. `ai.provider_credentials` stores
 * three base64 strings and nothing that means anything without
 * VAULT_ENCRYPTION_KEY, which lives only in Vercel — the same custodian ADM-60
 * named for SUPABASE_SERVICE_ROLE_KEY.
 *
 * `getProviderCredential` always uses the admin client. `src/lib/ai/providers.ts`
 * calls it from every context a provider can be resolved in, including the job
 * runner (no user session at all) — so it cannot depend on a signed-in
 * session, on the same footing as ARCHITECTURE.md §7.3's four permitted
 * service-role call sites: decrypting a stored key to build an outbound API
 * client is trusted server code regardless of what triggered it.
 *
 * Writing and listing status go through the caller's own per-request client
 * instead (RLS's core.is_admin() policy backs the app-layer check in
 * app/(internal)/settings/actions.ts, the same defence-in-depth
 * `requirement_versions_update` uses).
 */

export const VAULT_PROVIDERS = ['anthropic', 'openai', 'gemini', 'xai', 'openrouter'] as const;
export type VaultProvider = (typeof VAULT_PROVIDERS)[number];

const ALGORITHM = 'aes-256-gcm';

function encryptionKey(): Buffer {
  const raw = serverEnv().VAULT_ENCRYPTION_KEY;
  if (!raw) throw new Error('VAULT_ENCRYPTION_KEY is not set — the vault cannot encrypt or decrypt anything.');
  // Normalises whatever length/encoding the secret was generated with to
  // exactly 32 bytes. VAULT_ENCRYPTION_KEY is a high-entropy random secret
  // (the .env.example instruction is `openssl rand -hex 32`), not a
  // low-entropy passphrase, so a plain digest is sufficient — no KDF needed.
  return createHash('sha256').update(raw).digest();
}

export function encrypt(plaintext: string): { ciphertext: string; iv: string; authTag: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64') };
}

export function decrypt(ciphertext: string, iv: string, authTag: string): string {
  const decipher = createDecipheriv(ALGORITHM, encryptionKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

type RequestClient = Awaited<ReturnType<typeof createClient>>;

/**
 * Admin-entered, admin-only. `userId` is the caller's own id
 * (AuthContext.userId) — never trusted from form data.
 */
export async function setProviderCredential(
  supabase: RequestClient,
  provider: VaultProvider,
  rawKey: string,
  userId: string,
): Promise<Result<void>> {
  const trimmed = rawKey.trim();
  if (!trimmed) return err('VALIDATION', 'A key is required.');
  if (!VAULT_PROVIDERS.includes(provider)) return err('VALIDATION', `Unknown provider "${provider}".`);

  const { ciphertext, iv, authTag } = encrypt(trimmed);
  const hint = trimmed.length >= 20 ? trimmed.slice(-4) : null;
  void userId; // the doors use the signed-in caller (auth.uid()), never an id passed in

  // The legacy form's "the key" is the key labelled "primary" in the provider's key list (the AI Provider Manager).
  const { data: existing, error: readError } = await supabase.schema('ai').rpc('provider_key_status', { p_provider_id: provider });
  if (readError) return err('INTERNAL', 'Could not store the key.');
  const primary = (existing ?? []).find((k) => k.label === 'primary');

  const outcome = primary
    ? (await supabase.schema('ai').rpc('rotate_provider_key', { p_key_id: primary.id as string, p_ciphertext: ciphertext, p_iv: iv, p_auth_tag: authTag, p_hint: hint ?? '' })).data
    : (await supabase.schema('ai').rpc('add_provider_key', { p_provider_id: provider, p_label: 'primary', p_environment: 'production', p_ciphertext: ciphertext, p_iv: iv, p_auth_tag: authTag, p_hint: hint ?? '', p_priority: 10 })).data;
  const row = (Array.isArray(outcome) ? outcome[0] : outcome) as { outcome?: string } | undefined;
  if (row?.outcome === 'added' || row?.outcome === 'rotated') return ok(undefined);
  if (row?.outcome === 'forbidden' || row?.outcome === 'no_actor') return err('FORBIDDEN', 'Only the owner or an ops admin may store a provider key.');
  return err('INTERNAL', 'Could not store the key.');
}

/**
 * Owner-entered, owner-only — SCR-064's "revoke". Stricter than storing
 * (is_admin): losing a key stops every agent routed to that vendor.
 *
 * Goes through `ai.revoke_provider_credential` rather than a bare DELETE so
 * the removal and its audit row (`provider_credential.revoked`: who set it,
 * when, never what) commit together; the function is security invoker, so
 * `provider_credentials_admin_rw` decides again. The caller's role is checked
 * here too, as the app-layer half. Nothing about the key is read, returned
 * or logged.
 */
export async function deleteProviderCredential(
  supabase: RequestClient,
  provider: VaultProvider,
  subject: RoleSubject,
): Promise<Result<{ provider: VaultProvider }>> {
  if (!VAULT_PROVIDERS.includes(provider)) return err('VALIDATION', `Unknown provider "${provider}".`);
  // Decision 2026-09-30 (F2): the union — a secondary owner is an owner here.
  if (!hasRole(subject, 'owner')) return err('FORBIDDEN', 'Only the owner may revoke a provider key.');

  const { data, error } = await supabase.schema('ai').rpc('revoke_provider_credential', { p_provider: provider });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'deleteProviderCredential', provider, detail: error.message }));
    return err('INTERNAL', 'Could not revoke the key.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  switch (row?.outcome) {
    case 'revoked':
      return ok({ provider });
    case 'not_found':
      return err('NOT_FOUND', `No ${provider} key is stored in the vault. An env-set key cannot be revoked from here.`);
    default:
      return err('FORBIDDEN', 'Only the owner may revoke a provider key.');
  }
}

export type ProviderCredentialStatus = { provider: string; configured: boolean; updatedAt: string | null };

/** Which providers have a vault-stored key, and when. Never the key itself. */
export async function providerCredentialStatus(supabase: RequestClient): Promise<Result<ProviderCredentialStatus[]>> {
  const { data, error } = await supabase.schema('ai').rpc('provider_credential_status');
  if (error) return err('INTERNAL', `Could not read vault status: ${error.message}`);
  return ok((data ?? []).map((row) => ({ provider: row.provider, configured: row.configured, updatedAt: row.updated_at })));
}

/**
 * The plaintext key, or null if nothing is stored for this provider. Callers
 * are `src/lib/ai/providers.ts` only — never expose this to a user-facing
 * path, never log the return value.
 */
export async function getProviderCredential(provider: VaultProvider): Promise<string | null> {
  // No encryption key, no possible plaintext — skip the DB round trip
  // entirely rather than fetch ciphertext nothing can open. This also keeps
  // every existing "no env key ⇒ not registered" test hermetic: without
  // VAULT_ENCRYPTION_KEY set (true of every test environment today, since it
  // is new and optional), the vault is never reached over the network.
  if (!serverEnv().VAULT_ENCRYPTION_KEY) return null;

  // The legacy single-key table is frozen: the key a provider uses first is now its best USABLE key in ai.provider_keys - the same
  // rule the router follows (enabled, not rejected, not resting), so transcription, embeddings and images never take a key the
  // Provider Manager has parked.
  const supabase = createAdminClient();
  const { data: rows, error } = await supabase
    .schema('ai')
    .from('provider_keys')
    .select('ciphertext, iv, auth_tag, label, enabled, priority, health_state, cooldown_until')
    .eq('provider_id', provider);
  if (error) return null;
  const data = orderUsableKeys(
    (rows ?? []).map((k) => ({
      ...k,
      health: k.health_state as HealthState,
      cooldownUntil: k.cooldown_until ? new Date(k.cooldown_until) : null,
    })),
    new Date(),
  )[0];
  if (!data) return null;
  try {
    return decrypt(data.ciphertext, data.iv, data.auth_tag);
  } catch {
    // A key that fails to decrypt (VAULT_ENCRYPTION_KEY rotated or wrong) is
    // reported the same as unset — never a thrown error mid-request.
    return null;
  }
}
