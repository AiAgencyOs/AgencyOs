import 'server-only';

import { createClient } from '@/lib/db/server';

/**
 * The signed-in tenant's name, for the shell's organisation chip.
 *
 * RLS returns only the caller's own organisation, so no id is passed. `null`
 * when it cannot be read — the shell then shows nothing rather than a
 * placeholder name, because a wrong name on every page is worse than none.
 */
export async function readOrganizationName(): Promise<string | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('core').from('organizations').select('name').limit(1).maybeSingle();
  if (error) return null;
  const name = (data?.name ?? '').trim();
  return name.length > 0 ? name : null;
}
