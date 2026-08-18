import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import type { SecurityPosture } from './security-eval';

/**
 * The deployment's structural security posture, read through the owner-gated
 * `core.security_posture()` RPC. `unreadable()` on failure (G-054): a security
 * page that rendered "all clear" because it could not read would be the most
 * dangerous false comfort of all, so a failed read refuses rather than reassures.
 */
export async function getSecurityPosture(): Promise<SecurityPosture> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('core').rpc('security_posture');
  if (error) unreadable('getSecurityPosture', error);

  const p = (data ?? {}) as Partial<SecurityPosture>;
  return {
    unguarded_fks: p.unguarded_fks ?? [],
    unfrozen_tables: p.unfrozen_tables ?? [],
    invoker_writes: p.invoker_writes ?? [],
  };
}
