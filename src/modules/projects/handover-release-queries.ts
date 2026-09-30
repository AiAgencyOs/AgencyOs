import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

export type SmokeItem = { label: string; doneAt: string | null };

export type HandoverRelease = {
  id: string;
  status: string;
  rollbackPlan: string | null;
  smokeChecklist: SmokeItem[];
};

/**
 * The newest handover's rollback plan and smoke checklist — SCR-049's two
 * records (20260929170000). Newest, matching `readHandoverPackage`: the one
 * the release gate is about is whichever was started last. `null` means no
 * handover has been prepared, which the page says rather than colouring red.
 */
export async function readHandoverRelease(projectId: string): Promise<HandoverRelease | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('projects')
    .from('handovers')
    .select('id, status, rollback_plan, smoke_checklist')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) unreadable('readHandoverRelease', error);
  if (!data) return null;

  const raw = Array.isArray(data.smoke_checklist) ? data.smoke_checklist : [];
  const smokeChecklist: SmokeItem[] = raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const label = typeof entry.label === 'string' ? entry.label : null;
    if (!label) return [];
    return [{ label, doneAt: typeof entry.done_at === 'string' ? entry.done_at : null }];
  });

  return { id: data.id, status: data.status, rollbackPlan: data.rollback_plan, smokeChecklist };
}
