import 'server-only';

import { createAdminClient } from '@/lib/db/admin';
import type { createClient } from '@/lib/db/server';
import { serverEnv } from '@/lib/env';
import { hasRole, type RoleSubject } from '@/lib/authz/permissions';
import { decrypt, encrypt } from '@/lib/ai/vault';
import { err, ok, type Result } from '@/lib/result';

import { hintOf, slotFor, validateSecretValue } from './registry';

/**
 * The generic vault — the Keys & secrets screen's store.
 *
 * The same encryption as the AI provider vault (AES-256-GCM in code, keyed by
 * VAULT_ENCRYPTION_KEY, which lives only in the hosting environment), applied
 * to every other integration secret. Writing, revoking and listing status go
 * through the caller's own per-request client and the four `core.*` doors,
 * each of which re-checks the role in the database. Reading a value for use
 * (`readVaultSecret`) uses the admin client, because the job runner and the
 * webhooks that need a key have no signed-in user — the same footing as the
 * provider vault's `getProviderCredential`.
 */

type RequestClient = Awaited<ReturnType<typeof createClient>>;

/** A short-lived per-instance cache: a key is read on every outbound call, a vault read is a round trip. */
const TTL_MS = 30_000;
const cache = new Map<string, { at: number; value: string | null }>();

export function forgetVaultSecret(slot: string): void {
  cache.delete(slot);
}

export function vaultConfigured(): boolean {
  return Boolean(serverEnv().VAULT_ENCRYPTION_KEY);
}

/**
 * The plaintext for a vault slot, or null. Callers are `resolveSecret` only —
 * never a user-facing path, never logged.
 */
export async function readVaultSecret(slot: string): Promise<string | null> {
  // No encryption key, no possible plaintext: skip the round trip entirely.
  if (!vaultConfigured()) return null;

  const hit = cache.get(slot);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const admin = createAdminClient();
  const { data, error } = await admin.schema('core').from('secret_credentials').select('ciphertext, iv, auth_tag').eq('slot', slot).maybeSingle();
  let value: string | null = null;
  if (!error && data) {
    try {
      value = decrypt(data.ciphertext, data.iv, data.auth_tag);
    } catch {
      // A value that fails to decrypt (VAULT_ENCRYPTION_KEY rotated or wrong)
      // is reported as unset — never a thrown error in the middle of a request.
      value = null;
    }
  }
  cache.set(slot, { at: Date.now(), value });
  return value;
}

/** Whether a slot has a stored row at all — presence only, no decryption. */
export async function vaultHas(slot: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data } = await admin.schema('core').from('secret_credentials').select('slot').eq('slot', slot).maybeSingle();
  return Boolean(data);
}

export type StoreSecretInput = { slot: string; value: string; expiresOn?: string | null };

export async function storeSecret(supabase: RequestClient, input: StoreSecretInput, subject: RoleSubject): Promise<Result<{ slot: string; replaced: boolean; hint: string | null }>> {
  const slot = slotFor(input.slot);
  if (!slot) return err('VALIDATION', `“${input.slot}” is not a key this system uses.`);
  if (slot.storage !== 'vault') {
    return err('VALIDATION', slot.storage === 'env_only' ? `${slot.label} cannot be stored here. ${slot.envOnlyReason ?? ''}`.trim() : `${slot.label} is stored with the AI provider keys; use its own form.`);
  }
  // A GitHub token can merge a pull request and a WhatsApp token can message
  // every client: storing is the owner's alone (the database re-checks).
  if (!hasRole(subject, 'owner')) return err('FORBIDDEN', 'Only the owner may store or replace a key.');
  if (!vaultConfigured()) return err('VALIDATION', 'VAULT_ENCRYPTION_KEY is not set on this deployment, so nothing can be encrypted. Set it in the hosting environment first.');

  const value = input.value.trim();
  const problem = validateSecretValue(slot.key, value);
  if (problem) return err('VALIDATION', problem);
  if (input.expiresOn && !slot.canExpire) return err('VALIDATION', `${slot.label} does not expire, so no expiry date is recorded.`);

  const hint = hintOf(value);
  const { ciphertext, iv, authTag } = encrypt(value);
  const { data, error } = await supabase.schema('core').rpc('store_secret', {
    p_slot: slot.key,
    p_ciphertext: ciphertext,
    p_iv: iv,
    p_auth_tag: authTag,
    p_hint: hint,
    p_expires_on: input.expiresOn || null,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'storeSecret', slot: slot.key, detail: error.message }));
    return err('INTERNAL', 'Could not store the key.');
  }
  const outcome = (Array.isArray(data) ? data[0] : data)?.outcome;
  switch (outcome) {
    case 'stored':
    case 'replaced':
      forgetVaultSecret(slot.key);
      return ok({ slot: slot.key, replaced: outcome === 'replaced', hint });
    case 'expired':
      return err('VALIDATION', 'That expiry date has already passed.');
    case 'invalid_slot':
    case 'invalid_value':
      return err('VALIDATION', 'The key was not accepted.');
    default:
      return err('FORBIDDEN', 'Only the owner may store or replace a key.');
  }
}

export async function revokeSecret(supabase: RequestClient, slotKey: string, subject: RoleSubject): Promise<Result<{ slot: string }>> {
  const slot = slotFor(slotKey);
  if (!slot || slot.storage !== 'vault') return err('VALIDATION', `“${slotKey}” is not stored in this vault.`);
  if (!hasRole(subject, 'owner')) return err('FORBIDDEN', 'Only the owner may revoke a key.');

  const { data, error } = await supabase.schema('core').rpc('revoke_secret', { p_slot: slot.key });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'revokeSecret', slot: slot.key, detail: error.message }));
    return err('INTERNAL', 'Could not revoke the key.');
  }
  const outcome = (Array.isArray(data) ? data[0] : data)?.outcome;
  switch (outcome) {
    case 'revoked':
      forgetVaultSecret(slot.key);
      return ok({ slot: slot.key });
    case 'not_found':
      return err('NOT_FOUND', `No ${slot.label} is stored in the vault. A value set in the hosting environment cannot be revoked from here.`);
    default:
      return err('FORBIDDEN', 'Only the owner may revoke a key.');
  }
}

export type SecretStatusRow = {
  slot: string;
  hint: string | null;
  expiresOn: string | null;
  updatedAt: string;
  updatedByName: string | null;
  lastVerifiedAt: string | null;
  lastVerifiedOk: boolean | null;
  lastVerifiedDetail: string | null;
};

/** Which slots are stored, and when — never a value. An admin session only (the function checks). */
export async function secretStatus(supabase: RequestClient): Promise<Result<SecretStatusRow[]>> {
  const { data, error } = await supabase.schema('core').rpc('secret_status');
  if (error) return err('INTERNAL', `Could not read the vault: ${error.message}`);
  return ok(
    (data ?? []).map((r) => ({
      slot: r.slot,
      hint: r.hint,
      expiresOn: r.expires_on,
      updatedAt: r.updated_at,
      updatedByName: r.updated_by_name,
      lastVerifiedAt: r.last_verified_at,
      lastVerifiedOk: r.last_verified_ok,
      lastVerifiedDetail: r.last_verified_detail,
    })),
  );
}

export async function recordSecretCheck(supabase: RequestClient, slotKey: string, okResult: boolean, detail: string): Promise<Result<void>> {
  const { data, error } = await supabase.schema('core').rpc('record_secret_check', { p_slot: slotKey, p_ok: okResult, p_detail: detail.slice(0, 300) });
  if (error) return err('INTERNAL', 'Could not record the check.');
  const outcome = (Array.isArray(data) ? data[0] : data)?.outcome;
  return outcome === 'recorded' ? ok(undefined) : err('NOT_FOUND', 'That key is not stored in the vault, so there is no result to record.');
}
