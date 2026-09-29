import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';
import { sendClientMessage } from '@/modules/crm/service';

import { sendProjectUpdateSchema, type SendProjectUpdateInput } from './project-updates-schema';

/**
 * Send a project update — SCR-019 (migration 20261001120000).
 *
 * `client`: the body goes to the project's WhatsApp group thread
 * (`crm.conversations.kind = 'project_group'`) through `sendClientMessage`
 * — the ONE outbound chokepoint, so consent, the 24-hour window, the
 * outreach limits and the provider all decide there, and every refusal
 * comes back verbatim. Only after the send succeeded is the
 * `project_updates` row written, naming the thread and the message. A
 * project with no group thread is told so: nothing is sent to a guessed
 * number. If WhatsApp is not configured the chokepoint's own refusal is
 * the answer — an honest not-configured state, never a silent success.
 *
 * `internal`: recorded on the project for the team. Nothing is sent —
 * the page says so beside the option.
 *
 * `lead.write` for a client send (what it takes to message a client
 * anywhere else), `project.write` for an internal note.
 */
export type ProjectUpdateOutcome = { updateId: string; sentTo: 'client' | 'internal'; delivered: boolean };

export async function sendProjectUpdate(input: SendProjectUpdateInput): Promise<Result<ProjectUpdateOutcome>> {
  const parsed = sendProjectUpdateSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid update.');

  const context = await requireInternal();
  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');
  const needed = parsed.data.sentTo === 'client' ? 'lead.write' : 'project.write';
  if (!can(context, needed)) {
    return err('FORBIDDEN', parsed.data.sentTo === 'client' ? 'You do not have permission to message clients.' : 'You do not have permission to post a project update.');
  }

  const supabase = await createClient();

  let conversationId: string | null = null;
  let messageId: string | null = null;

  if (parsed.data.sentTo === 'client') {
    const { data: thread, error: threadError } = await supabase
      .schema('crm')
      .from('conversations')
      .select('id, status')
      .eq('project_id', parsed.data.projectId)
      .eq('kind', 'project_group')
      .neq('status', 'abandoned')
      .maybeSingle();
    if (threadError) {
      console.error(JSON.stringify({ level: 'error', scope: 'sendProjectUpdate.thread', detail: threadError.message }));
      return err('INTERNAL', 'The project’s client thread could not be read.');
    }
    if (!thread) {
      return err('CONFLICT', 'This project has no linked WhatsApp group yet, so there is no client thread to send to. Link the group on the Overview first.');
    }

    const sent = await sendClientMessage({
      conversationId: thread.id,
      body: parsed.data.body,
      idempotencyKey: `project-update:${parsed.data.projectId}:${crypto.randomUUID()}`,
    });
    if (!sent.ok) return sent;
    conversationId = thread.id;
    messageId = sent.data.messageId;
  }

  const { data, error } = await supabase
    .schema('projects')
    .from('project_updates')
    .insert({
      organization_id: context.organizationId,
      project_id: parsed.data.projectId,
      body: parsed.data.body,
      sent_to: parsed.data.sentTo,
      sent_by: context.userId,
      conversation_id: conversationId,
      message_id: messageId,
    })
    .select('id')
    .single();
  if (error || !data) {
    console.error(JSON.stringify({ level: 'error', scope: 'sendProjectUpdate.record', detail: error?.message }));
    return err(
      'INTERNAL',
      parsed.data.sentTo === 'client'
        ? 'The update reached the client thread, but could not be recorded on the project. Do not send it again — it is in the transcript.'
        : 'Could not record the update.',
    );
  }

  return ok({ updateId: data.id, sentTo: parsed.data.sentTo, delivered: parsed.data.sentTo === 'client' });
}
