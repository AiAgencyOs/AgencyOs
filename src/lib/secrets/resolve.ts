import 'server-only';

import { getProviderCredential } from '@/lib/ai/vault';
import { serverEnv } from '@/lib/env';

import { slotFor, type SecretSlotDef } from './registry';
import { readVaultSecret, vaultHas } from './vault';

/**
 * The one way the rest of the code asks for a key.
 *
 *   const token = await resolveSecret('GITHUB_TOKEN');
 *
 * The rule is the provider vault's own, applied to every slot: a value set in
 * the DEPLOYMENT ENVIRONMENT wins, the vault is the fallback, and nothing at
 * all is `null`. So a deployment that works today keeps working the day the
 * vault ships, and an owner who wants to change a key from the panel first
 * removes the environment copy (the screen says which one is being used).
 *
 * Never logs, never returns a value to a browser: callers are server code that
 * is about to call a vendor with it.
 */

function fromEnv(key: string): string | null {
  const v = (serverEnv() as Record<string, unknown>)[key];
  if (typeof v === 'number') return String(v);
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

function fromVault(slot: SecretSlotDef): Promise<string | null> {
  if (slot.storage === 'provider_vault' && slot.provider) return getProviderCredential(slot.provider);
  if (slot.storage === 'vault') return readVaultSecret(slot.key);
  return Promise.resolve(null);
}

export async function resolveSecret(key: string): Promise<string | null> {
  const env = fromEnv(key);
  if (env) return env;
  const slot = slotFor(key);
  return slot ? fromVault(slot) : null;
}

/** Whether a slot resolves to anything — for readiness checks that used to be `present('X')`. */
export async function secretConfigured(key: string): Promise<boolean> {
  return (await resolveSecret(key)) !== null;
}

export type SecretSource = 'env' | 'vault' | 'none';
export type SecretSourceReport = {
  /** Where the runtime reads it from right now. */
  source: SecretSource;
  /** A vault copy exists but the environment copy shadows it. */
  vaultShadowed: boolean;
};

/** Where a slot's value comes from — for the screen. Presence only; no value leaves this function. */
export async function secretSource(key: string): Promise<SecretSourceReport> {
  const slot = slotFor(key);
  const env = fromEnv(key) !== null;
  let inVault = false;
  if (slot?.storage === 'vault') inVault = await vaultHas(key);
  else if (slot?.storage === 'provider_vault' && slot.provider) inVault = (await getProviderCredential(slot.provider)) !== null;
  if (env) return { source: 'env', vaultShadowed: inVault };
  return { source: inVault ? 'vault' : 'none', vaultShadowed: false };
}
