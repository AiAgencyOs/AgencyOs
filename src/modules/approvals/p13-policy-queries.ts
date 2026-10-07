import 'server-only';

import { createClient } from '@/lib/db/server';
import { asRows, looseSchema } from '@/lib/p13/loose-client';
import { unreadable } from '@/lib/result';

import { POLICY_KINDS, type PolicyKind, type PolicyVersionRow } from './p13-policy-model';

/** Every policy version of the caller's organization (RLS-scoped: internal staff only). */
export async function listPolicyVersions(): Promise<PolicyVersionRow[]> {
  const supabase = await createClient();
  const { data, error } = await looseSchema(supabase, 'core')
    .from('p13_policy_versions')
    .select('id, policy_kind, version, status, summary, body, effective_from, activated_at, activation_reason')
    .order('version', { ascending: false })
    .limit(500);
  if (error) unreadable('listPolicyVersions', error);
  return asRows(data).flatMap((r) =>
    POLICY_KINDS.includes(r.policy_kind as PolicyKind) && typeof r.id === 'string' && typeof r.version === 'number'
      ? [{ ...(r as unknown as PolicyVersionRow), body: (r.body && typeof r.body === 'object' ? r.body : {}) as Record<string, unknown> }]
      : [],
  );
}
