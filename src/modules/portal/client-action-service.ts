import 'server-only';

import { createClient } from '@/lib/db/server';

/**
 * The portal's one WRITE door for a client action request: `projects.resolve_client_action_request`. It records the client's CLAIM that they did what was asked
 * (a note and an optional reference). It confirms nothing: a person at the agency checks and confirms. The database decides every outcome; the words only report it.
 */

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

export const RESOLVE_WORDS: Record<string, string> = {
  submitted: 'Thank you. Your project contact will check it and confirm; it is not marked done until they have.',
  already_submitted: 'You have already told us this is done. We will confirm it shortly.',
  note_required: 'Please tell us what you did, in a sentence or two.',
  contains_secret: 'That text looks like a password or key. Please do not send secrets here; describe what you did instead.',
  portal_read_only: 'This project has been completed and archived: the portal is read-only.',
  not_open: 'This request is no longer open.',
  not_found: 'That request could not be found.',
  not_a_client: 'Only a client user can answer this request.',
};

export async function resolveClientActionRequest(requestId: string, note: string, reference: string | null): Promise<{ ok: boolean; message: string }> {
  const supabase = await createClient();
  const { data, error } = await (supabase.schema('projects') as unknown as { rpc: Rpc }).rpc('resolve_client_action_request', { p_request_id: requestId, p_note: note, p_reference: reference });
  if (error) return { ok: false, message: 'This could not be sent right now. Nothing was recorded.' };
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string | null } | null | undefined;
  const outcome = String(row?.outcome ?? 'no answer');
  return { ok: outcome === 'submitted', message: RESOLVE_WORDS[outcome] ?? 'This could not be sent.' };
}
