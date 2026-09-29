import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * Reads for SCR-044 — the release hold on a project, and every hold across
 * the organization for the QA dashboard's readiness column.
 */

export type ReleaseHold = {
  reason: string;
  heldAt: string;
  heldBy: string | null;
  heldByName: string | null;
};

export async function readReleaseHold(projectId: string): Promise<ReleaseHold | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('projects')
    .from('projects')
    .select('release_hold_reason, release_held_at, release_held_by')
    .eq('id', projectId)
    .is('deleted_at', null)
    .single();
  if (error) unreadable('readReleaseHold', error);
  if (!data.release_hold_reason || !data.release_held_at) return null;

  let heldByName: string | null = null;
  if (data.release_held_by) {
    const { data: member, error: memberError } = await supabase
      .schema('core')
      .from('memberships')
      .select('user_id, users:user_id(full_name, email)')
      .eq('user_id', data.release_held_by)
      .maybeSingle();
    if (memberError) unreadable('readReleaseHold.heldBy', memberError);
    const user = ((member as Record<string, unknown> | null)?.users ?? {}) as { full_name?: string | null; email?: string | null };
    heldByName = user.full_name ?? user.email ?? null;
  }

  return { reason: data.release_hold_reason, heldAt: data.release_held_at, heldBy: data.release_held_by, heldByName };
}

/** Every standing hold, by project id — the QA dashboard's "held" mark. */
export async function listReleaseHolds(): Promise<Map<string, string>> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('projects')
    .from('projects')
    .select('id, release_hold_reason')
    .not('release_hold_reason', 'is', null)
    .is('deleted_at', null);
  if (error) unreadable('listReleaseHolds', error);

  return new Map((data ?? []).flatMap((p) => (p.release_hold_reason ? [[p.id, p.release_hold_reason] as const] : [])));
}
