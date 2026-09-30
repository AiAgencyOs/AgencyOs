'use server';

import { revalidatePath } from 'next/cache';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { forgetGithubTokenScopes, readGithubTokenScopes } from '@/lib/git/github';
import { verifyWhatsAppConfig } from '@/lib/admin/whatsapp-verify';
import { slotFor } from '@/lib/secrets/registry';
import { recordSecretCheck, revokeSecret, storeSecret } from '@/lib/secrets/vault';
import type { FormState } from '@/modules/identity/types';

/**
 * The Keys & secrets doors — schema → service → action → form, like every
 * other write in the panel.
 *
 * Storing and revoking are the OWNER's alone (`storeSecret` / `revokeSecret`
 * check it, `core.store_secret` / `core.revoke_secret` check it again). Verify
 * is an admin-tier action because it only asks the vendor whether the stored
 * key works. Nothing here reads a value back: a key is typed once, encrypted,
 * and never shown again — the result message says so.
 */

const refresh = () => {
  for (const p of ['/security/keys', '/integrations', '/production-readiness', '/settings', '/operations']) revalidatePath(p);
};

export async function storeSecretAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const context = await requireInternal();
  const slot = String(formData.get('slot') ?? '');
  const value = String(formData.get('value') ?? '');
  const expiresOn = String(formData.get('expiresOn') ?? '').trim();
  if (expiresOn && !/^\d{4}-\d{2}-\d{2}$/.test(expiresOn)) return { status: 'error', message: 'The expiry date must be a calendar date.' };

  const supabase = await createClient();
  const result = await storeSecret(supabase, { slot, value, expiresOn: expiresOn || null }, context);
  if (!result.ok) return { status: 'error', message: result.error.message };

  // A token that just changed must be read afresh, not from the once-per-process scope read.
  if (slot === 'GITHUB_TOKEN') forgetGithubTokenScopes();
  refresh();
  const label = slotFor(slot)?.label ?? slot;
  return {
    status: 'success',
    message: `${label} ${result.data.replaced ? 'replaced' : 'stored'} — encrypted, never shown again${result.data.hint ? ` (ends …${result.data.hint})` : ''}. If the hosting environment also sets ${slot}, that value is still the one in use.`,
  };
}

export async function revokeSecretAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const context = await requireInternal();
  const slot = String(formData.get('slot') ?? '');
  const supabase = await createClient();
  const result = await revokeSecret(supabase, slot, context);
  if (!result.ok) return { status: 'error', message: result.error.message };
  if (slot === 'GITHUB_TOKEN') forgetGithubTokenScopes();
  refresh();
  return { status: 'success', message: `${slotFor(slot)?.label ?? slot} revoked. Whatever used it now says it is not configured.` };
}

/**
 * Ask the vendor whether the key in use works, and record the answer beside
 * a vault-stored key. Two slots have a live check today, each an existing
 * verifier; every other slot has none and the screen does not offer one.
 */
export async function verifySecretAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const context = await requireInternal();
  if (!can(context, 'audit.read')) return { status: 'error', message: 'Only an owner or ops admin may verify a key.' };
  const slot = slotFor(String(formData.get('slot') ?? ''));
  if (!slot?.verifier) return { status: 'error', message: 'There is no live check for that key.' };

  const check = await runCheck(slot.verifier);
  const { good, detail } = check;

  const supabase = await createClient();
  await recordSecretCheck(supabase, slot.key, good, detail);
  refresh();
  return { status: good ? 'success' : 'error', message: detail };
}

async function runCheck(verifier: 'github' | 'whatsapp'): Promise<{ good: boolean; detail: string }> {
  if (verifier === 'github') {
    forgetGithubTokenScopes();
    const r = await readGithubTokenScopes();
    if (!r.ok) return { good: false, detail: r.detail };
    const scopes = r.data.scopes === null ? 'scopes not stated — a fine-grained token, GitHub decides each write' : `scopes: ${r.data.scopes.join(', ') || 'none'}`;
    return { good: true, detail: `GitHub accepted the token${r.data.login ? ` (signed in as ${r.data.login})` : ''}; ${scopes}.` };
  }
  const r = await verifyWhatsAppConfig();
  if (!r.ok) return { good: false, detail: r.error.message };
  return { good: r.data.ok, detail: r.data.message };
}
