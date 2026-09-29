import 'server-only';

import { createClient } from '@/lib/db/server';
import type { Database } from '@/lib/db/types';
import { unreadable } from '@/lib/result';

/**
 * Reads for the per-project Release Gate (SCR-049's per-project half).
 *
 * Every reader here is a fact the gate page had no door to: the three
 * answers `projects.production_readiness` gives, the sign-off date on the
 * project row (`getProject` deliberately does not select it), and the
 * handover package (`projects.handovers` + `handover_items`, which only the
 * client portal and the job runner ever read). Nothing here decides
 * anything — `mark_production_ready` is the only door, and this page reuses
 * its form.
 *
 * Every reader refuses rather than answering with a zero, for the same reason
 * `queries.ts` does: "no open blockers" because the database did not answer
 * is the sentence somebody reads right before telling a client to deploy.
 */

/** The row `projects.production_readiness` returns — the gate's own view. */
export type ProductionReadiness = {
  noOpenBlockers: boolean;
  noOpenMajors: boolean;
  buildApproved: boolean;
};

export async function readProductionReadiness(projectId: string): Promise<ProductionReadiness> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('projects')
    .rpc('production_readiness', { p_project_id: projectId })
    .single();

  if (error) unreadable('readProductionReadiness', error);

  // `.single()` on an rpc loses the row type the same way readProjectQuality's
  // does; the shape is the function's declared `returns table`.
  const row = data as Database['projects']['Functions']['production_readiness']['Returns'][number];

  return {
    noOpenBlockers: row.no_open_blockers,
    noOpenMajors: row.no_open_majors,
    buildApproved: row.build_approved,
  };
}

/**
 * When the project was signed off, if it was. `null` is "not yet", and a
 * project RLS does not return is a failed read rather than an unsigned one:
 * the page has already resolved the project through `getProject`.
 */
export async function readProductionReadyAt(projectId: string): Promise<string | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('projects')
    .from('projects')
    .select('production_ready_at')
    .eq('id', projectId)
    .is('deleted_at', null)
    .single();

  if (error) unreadable('readProductionReadyAt', error);

  return data.production_ready_at;
}

type HandoverRow = Database['projects']['Tables']['handovers']['Row'];
type HandoverItemRow = Database['projects']['Tables']['handover_items']['Row'];

export type HandoverItem = Pick<HandoverItemRow, 'id' | 'kind' | 'label' | 'reference' | 'transfer_method' | 'notes'>;

export type HandoverPackage = Pick<HandoverRow, 'id' | 'status' | 'summary' | 'delivered_at' | 'accepted_at' | 'created_at'> & {
  items: HandoverItem[];
};

/**
 * The newest handover for a project with its package lines — Directive §22.
 *
 * Newest rather than "the open one": a project handed over, extended and
 * handed over again has an accepted row and a preparing row, and the one the
 * release gate is about is whichever was started last. A credential item's
 * `reference` is null by CHECK, so nothing here can print a secret.
 */
export async function readHandoverPackage(projectId: string): Promise<HandoverPackage | null> {
  const supabase = await createClient();

  const { data: handover, error: handoverError } = await supabase
    .schema('projects')
    .from('handovers')
    .select('id, status, summary, delivered_at, accepted_at, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (handoverError) unreadable('readHandoverPackage.handover', handoverError);
  if (!handover) return null;

  const { data: items, error: itemsError } = await supabase
    .schema('projects')
    .from('handover_items')
    .select('id, kind, label, reference, transfer_method, notes')
    .eq('handover_id', handover.id)
    .order('created_at', { ascending: true });

  if (itemsError) unreadable('readHandoverPackage.items', itemsError);

  return { ...handover, items: items ?? [] };
}
