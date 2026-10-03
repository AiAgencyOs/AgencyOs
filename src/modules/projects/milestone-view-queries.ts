import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/** What the Milestones tab draws: each milestone with its description (the payment-plan reader omits it). */
export type MilestoneView = { id: string; name: string; description: string | null; position: number; status: string; dueOn: string | null; metAt: string | null };

export async function listMilestoneViews(projectId: string): Promise<MilestoneView[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('projects')
    .from('milestones')
    .select('id, name, description, position, status, due_on, met_at')
    .eq('project_id', projectId)
    .order('position', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) unreadable('listMilestoneViews', error);
  return (data ?? []).map((m) => ({ id: m.id, name: m.name, description: m.description, position: m.position, status: m.status, dueOn: m.due_on, metAt: m.met_at }));
}
