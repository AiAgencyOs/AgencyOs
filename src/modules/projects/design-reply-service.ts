import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

/**
 * A person handles what the project manager would not decide on its own - Phase 3 PM §4.9: a final
 * confirmation (it locks the design), a possible scope change (it stops the phase), or a reading it
 * was not sure of. Both doors re-check the role; this layer only turns an outcome into a sentence.
 */

async function actor(): Promise<Result<true>> {
  const context = await requireInternal();
  if (!can(context, 'project.write')) return err('FORBIDDEN', 'You do not have permission to change this project’s design work.');
  return ok(true);
}

const one = <T>(data: unknown): T | undefined => (Array.isArray(data) ? data[0] : data) as T | undefined;

export async function acceptDesignReply(input: { proposalId: string; themeOptionId?: string; colorOptionId?: string }): Promise<Result<{ decisionId: string | null }>> {
  const gate = await actor();
  if (!gate.ok) return gate;
  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('accept_design_reply_proposal', {
    p_proposal_id: input.proposalId,
    p_theme_option_id: input.themeOptionId,
    p_color_option_id: input.colorOptionId,
  });
  if (error) return err('INTERNAL', 'Could not record the reply.');
  const row = one<{ outcome?: string; decision_id?: string | null }>(data);
  switch (row?.outcome ?? 'no answer') {
    case 'accepted':
      return ok({ decisionId: row?.decision_id ?? null });
    case 'not_waiting':
      return err('CONFLICT', 'That reply has already been handled.');
    case 'needs_both':
      return err('VALIDATION', 'A final confirmation must name the exact theme AND the exact colour. Pick both, then accept.');
    case 'needs_selection':
      return err('VALIDATION', 'A selection must name the direction the client chose.');
    case 'not_shown':
      return err('CONFLICT', 'The client was not shown that option, so it cannot be recorded as their choice.');
    case 'color_not_of_theme':
      return err('VALIDATION', 'That palette does not belong to that direction.');
    case 'unknown_proposal':
      return err('NOT_FOUND', 'That reply was not found.');
    default:
      return err('FORBIDDEN', 'You do not have permission to record a client reply on this project.');
  }
}

export async function dismissDesignReply(input: { proposalId: string; note: string }): Promise<Result<true>> {
  const gate = await actor();
  if (!gate.ok) return gate;
  if (!input.note.trim()) return err('VALIDATION', 'Say why this reply needs no action - it goes on the record.');
  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('dismiss_design_reply_proposal', { p_proposal_id: input.proposalId, p_note: input.note });
  if (error) return err('INTERNAL', 'Could not dismiss the reply.');
  switch (one<{ outcome?: string }>(data)?.outcome ?? 'no answer') {
    case 'dismissed':
      return ok(true);
    case 'not_waiting':
      return err('CONFLICT', 'That reply has already been handled.');
    case 'needs_note':
      return err('VALIDATION', 'Say why this reply needs no action - it goes on the record.');
    default:
      return err('FORBIDDEN', 'You do not have permission to dismiss a client reply on this project.');
  }
}
