import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import type { WindowState } from './outbound-window';

/**
 * The 24-hour window and the project group, for the lead's thread — SCR-058.
 *
 * The window rule lives in ONE place, `crm.window_state` (G-214: per
 * counterpart number, across every thread, 24 hours from their last inbound
 * message; a group is exempt; a number that never wrote is `never`, not
 * `closed`). `readWindowState` in outbound-window.ts asks it with the
 * runner's admin client; this asks the same function under the caller's own
 * session, so the header shows exactly what the sender would decide.
 */
export async function readConversationWindow(conversationId: string): Promise<WindowState> {
  const supabase = await createClient();

  const { data, error } = await supabase.schema('crm').rpc('window_state', { p_conversation_id: conversationId });
  if (error) unreadable('readConversationWindow', error);

  const state = Array.isArray(data) ? data[0] : data;
  return state === 'open' || state === 'closed' || state === 'never' || state === 'group' ? state : 'unreadable';
}

export type LeadProjectGroup = { conversationId: string; projectId: string; title: string | null };

/**
 * The project-group conversation behind a lead, when the lead's won deal
 * became a project that has one. lead → opportunity → project → the
 * `project_group` conversation, each step a table this module may read
 * under RLS; null at any missing link, because a lead with no project has
 * no group and that is a fact, not a failure.
 */
export async function readProjectGroupForLead(leadId: string): Promise<LeadProjectGroup | null> {
  const supabase = await createClient();

  const { data: opportunities, error: opportunityError } = await supabase
    .schema('sales')
    .from('opportunities')
    .select('id')
    .eq('lead_id', leadId);
  if (opportunityError) unreadable('readProjectGroupForLead.opportunities', opportunityError);
  const opportunityIds = (opportunities ?? []).map((o) => o.id);
  if (opportunityIds.length === 0) return null;

  const { data: projects, error: projectError } = await supabase
    .schema('projects')
    .from('projects')
    .select('id')
    .in('opportunity_id', opportunityIds);
  if (projectError) unreadable('readProjectGroupForLead.projects', projectError);
  const projectIds = (projects ?? []).map((p) => p.id);
  if (projectIds.length === 0) return null;

  const { data: group, error: groupError } = await supabase
    .schema('crm')
    .from('conversations')
    .select('id, project_id, title')
    .in('project_id', projectIds)
    .eq('kind', 'project_group')
    .neq('status', 'abandoned')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (groupError) unreadable('readProjectGroupForLead.group', groupError);
  if (!group || !group.project_id) return null;

  return { conversationId: group.id, projectId: group.project_id, title: group.title };
}
