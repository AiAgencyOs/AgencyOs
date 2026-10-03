import 'server-only';

import { slotFor } from '@/lib/secrets/registry';
import { secretSource } from '@/lib/secrets/resolve';

import { configStatus, type ConfigItem, type ConfigStatus } from './config-status';

/**
 * `configStatus()` plus the vault: a slot the registry keeps in the vault (or
 * the provider vault) is present when EITHER the environment or the vault holds
 * it, and says which (`source`). Everything else is exactly `configStatus()`.
 * The env-only listing in config-status.ts stays sync and pure for tests and the doctor.
 */
export async function configStatusResolved(env: Record<string, string | undefined> = process.env): Promise<ConfigStatus> {
  const base = configStatus(env);
  const items = await Promise.all(
    base.items.map(async (item): Promise<ConfigItem> => {
      const slot = slotFor(item.key);
      if (!slot || slot.storage === 'env_only') return item;
      const report = await secretSource(item.key);
      return { ...item, present: report.source !== 'none', source: report.source };
    }),
  );
  return { ...base, items };
}
