import 'server-only';

import { providerCredentialStatus } from '@/lib/ai/vault';
import type { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { ageDays, expiryState, needsRotation, SECRET_SLOTS, type ExpiryState, type SecretSlotDef } from './registry';
import { secretSource, type SecretSource } from './resolve';
import { secretStatus, vaultConfigured, type SecretStatusRow } from './vault';

type RequestClient = Awaited<ReturnType<typeof createClient>>;

export type KeyRow = {
  slot: SecretSlotDef;
  /** Where the runtime reads it from right now. */
  source: SecretSource;
  /** A vault copy exists but the environment copy shadows it. */
  vaultShadowed: boolean;
  hint: string | null;
  expiresOn: string | null;
  expiry: ExpiryState;
  updatedAt: string | null;
  updatedByName: string | null;
  ageDays: number | null;
  rotate: boolean;
  lastVerifiedAt: string | null;
  lastVerifiedOk: boolean | null;
  lastVerifiedDetail: string | null;
  /** Something a person should look at: expired, expiring, overdue for rotation, or a check that failed. */
  attention: boolean;
};

export type KeysOverview = { rows: KeyRow[]; vaultReady: boolean };

/**
 * Everything the Keys & secrets screen shows, presence and moments only. No
 * value is read here: `secretSource` answers "is there one, and from where"
 * without returning it, and the status rows carry a four-character hint the
 * owner typed themselves.
 */
export async function readKeysOverview(supabase: RequestClient, now: Date): Promise<Result<KeysOverview>> {
  const [vault, providers] = await Promise.all([secretStatus(supabase), providerCredentialStatus(supabase)]);
  if (!vault.ok) return err(vault.error.code, vault.error.message);
  if (!providers.ok) return err(providers.error.code, providers.error.message);

  const vaultBySlot = new Map<string, SecretStatusRow>(vault.data.map((r) => [r.slot, r]));
  const providerByName = new Map(providers.data.map((p) => [p.provider, p]));

  const rows = await Promise.all(
    SECRET_SLOTS.map(async (slot): Promise<KeyRow> => {
      const src = await secretSource(slot.key);
      const v = vaultBySlot.get(slot.key);
      const p = slot.provider ? providerByName.get(slot.provider) : undefined;
      // The moment the STORED copy was set; an environment-set key has no such moment the panel can know.
      const updatedAt = v?.updatedAt ?? (p?.configured ? p.updatedAt : null);
      const expiry = expiryState(v?.expiresOn, now);
      const rotate = src.source === 'vault' || src.vaultShadowed ? needsRotation(slot, updatedAt, now) : false;
      const failed = v?.lastVerifiedOk === false;
      return {
        slot,
        source: src.source,
        vaultShadowed: src.vaultShadowed,
        hint: v?.hint ?? null,
        expiresOn: v?.expiresOn ?? null,
        expiry,
        updatedAt,
        updatedByName: v?.updatedByName ?? null,
        ageDays: ageDays(updatedAt, now),
        rotate,
        lastVerifiedAt: v?.lastVerifiedAt ?? null,
        lastVerifiedOk: v?.lastVerifiedOk ?? null,
        lastVerifiedDetail: v?.lastVerifiedDetail ?? null,
        attention: expiry === 'expired' || expiry === 'soon' || rotate || failed,
      };
    }),
  );
  return ok({ rows, vaultReady: vaultConfigured() });
}
