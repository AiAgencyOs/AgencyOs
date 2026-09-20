import 'server-only';

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { createAdminClient } from '@/lib/db/admin';
import type { createClient } from '@/lib/db/server';
import { serverEnv } from '@/lib/env';
import { err, ok, type Result } from '@/lib/result';

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

function encrypt(plaintext: string): { ciphertext: string; iv: string; authTag: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64') };
}

function decrypt(ciphertext: string, iv: string, authTag: string): string {
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
  const { error } = await supabase
    .schema('ai')
    .from('provider_credentials')
    .upsert({ provider, ciphertext, iv, auth_tag: authTag, updated_by: userId });

  if (error) return err('INTERNAL', `Could not store the key: ${error.message}`);
  return ok(undefined);
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

  const supabase = createAdminClient();
  const { data, error } = await supabase.schema('ai').from('provider_credentials').select('ciphertext, iv, auth_tag').eq('provider', provider).maybeSingle();
  if (error || !data) return null;
  try {
    return decrypt(data.ciphertext, data.iv, data.auth_tag);
  } catch {
    // A key that fails to decrypt (VAULT_ENCRYPTION_KEY rotated or wrong) is
    // reported the same as unset — never a thrown error mid-request.
    return null;
  }
}
