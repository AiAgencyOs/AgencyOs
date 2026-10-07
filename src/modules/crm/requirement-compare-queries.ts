import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import type { RequirementPayloadLike } from './requirement-diff';

export type RequirementVersionForCompare = {
  id: string;
  version: number;
  source: string;
  status: string;
  created_at: string;
  generated_by_run_id: string | null;
  created_by: string | null;
  payload: RequirementPayloadLike;
};

/** The requested versions of one conversation's requirement set (RLS-scoped). Versions that do not exist are simply absent. */
export async function readRequirementVersionsForCompare(conversationId: string, versions: readonly number[]): Promise<RequirementVersionForCompare[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('crm')
    .from('requirement_versions')
    .select('id, version, source, status, created_at, generated_by_run_id, created_by, payload')
    .eq('conversation_id', conversationId)
    .in('version', [...versions]);
  if (error) unreadable('readRequirementVersionsForCompare', error);
  return (data ?? []).map((r) => ({ ...r, payload: (r.payload && typeof r.payload === 'object' && !Array.isArray(r.payload) ? r.payload : {}) as RequirementPayloadLike }));
}

/** The highest requirement version any quotation was drawn from, among the versions given; null when none was quoted. */
export async function readQuotedRequirementVersion(versionIds: readonly { id: string; version: number }[]): Promise<number | null> {
  if (versionIds.length === 0) return null;
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('sales')
    .from('proposals')
    .select('requirement_version_id')
    .in('requirement_version_id', versionIds.map((v) => v.id));
  if (error) unreadable('readQuotedRequirementVersion', error);
  const quoted = new Set((data ?? []).map((p) => p.requirement_version_id));
  const hits = versionIds.filter((v) => quoted.has(v.id)).map((v) => v.version);
  return hits.length === 0 ? null : Math.max(...hits);
}
