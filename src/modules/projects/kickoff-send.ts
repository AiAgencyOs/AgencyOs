import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';
import { sendClientMessage } from '@/modules/crm/service';

import { describeBlockers } from './kickoff-blockers';
import { pmKickoff } from './pm-messages';
import { recordKickoff } from './planning';

/**
 * §5.11 — the PM announces the kickoff in the project group, and the message
 * IS the evidence.
 *
 * Until now the form asked a person to send the message themselves and paste
 * its reference. This sends it: the readiness gate is checked FIRST (a kickoff
 * announced and then refused would be this system telling a client something
 * that is not true), the short official message goes to the project's WhatsApp
 * group through the governed send door under the person who pressed the button
 * (consent, the window and the owner's kill switch all still decide there), and
 * the recorded message becomes the evidence `record_kickoff` requires.
 *
 * Idempotent: the message is queued under `pm:kickoff:<project>`, so a second
 * press after a failure at the recording step finds the message already sent
 * rather than sending it twice.
 */
export async function sendKickoffAndRecord(input: { projectId: string }): Promise<Result<{ kickedOff: boolean; messageId: string }>> {
  const context = await requireInternal();
  if (!can(context, 'project.write')) {
    return err('FORBIDDEN', 'You do not have permission to kick this project off.');
  }

  const supabase = await createClient();

  const { data: readiness, error: readinessError } = await supabase
    .schema('projects')
    .rpc('pre_kickoff_readiness', { p_project_id: input.projectId });
  if (readinessError) return err('INTERNAL', 'Could not check whether the project is ready.');
  const gateRow = (Array.isArray(readiness) ? readiness[0] : readiness) as { ready?: boolean; unmet?: string[] | null } | undefined;
  if (!gateRow?.ready) {
    const unmet = gateRow?.unmet ?? [];
    return err(
      'CONFLICT',
      unmet.length > 0 ? `Not ready yet — ${describeBlockers(unmet).join(' ')}` : 'This project is not ready for kickoff.',
    );
  }

  const { data: groups, error: groupError } = await supabase
    .schema('crm')
    .from('conversations')
    .select('id, lead_id')
    .eq('kind', 'project_group')
    .eq('project_id', input.projectId)
    .neq('status', 'abandoned')
    .order('updated_at', { ascending: false })
    .limit(1);
  if (groupError) return err('INTERNAL', 'Could not look up the project group.');
  const group = groups?.[0];
  if (!group) {
    return err('CONFLICT', 'This project has no WhatsApp group to announce the kickoff in. Map the group first, or record a kickoff you sent another way.');
  }

  const { quotationLanguageForConversation } = await import('@/modules/sales/quotation-language');
  const language = await quotationLanguageForConversation(supabase as never, group.id).catch(() => 'en' as const);

  const sent = await sendClientMessage({
    conversationId: group.id,
    body: pmKickoff(language),
    idempotencyKey: `pm:kickoff:${input.projectId}`,
  });
  if (!sent.ok) return sent;

  const recorded = await recordKickoff({ projectId: input.projectId, evidenceRef: `pm:kickoff:${input.projectId}:${sent.data.messageId}` });
  if (!recorded.ok) return recorded;
  return ok({ kickedOff: true, messageId: sent.data.messageId });
}

