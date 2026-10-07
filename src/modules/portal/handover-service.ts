import 'server-only';

import { createClient } from '@/lib/db/server';

/**
 * The portal's two WRITE doors for the delivered handover. Neither accepts anything:
 *
 *   * `projects.log_handover_access`            an append-only log of who viewed the package and which item they opened (P707 §9)
 *   * `projects.request_handover_acceptance`    a REQUEST row. The client accepts; a person with delivery rights confirms it with their own verification before it
 *                                               is recorded as the formal acceptance of the exact version (P708 §6, ADM-08d). A click here is never an acceptance.
 *
 * The database decides every outcome (the account, the delivered version, the read-only and expiry policy); the words below only report it.
 */

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

async function projectsRpc(): Promise<Rpc> {
  const supabase = await createClient();
  return (fn, args) => (supabase.schema('projects') as unknown as { rpc: Rpc }).rpc(fn, args);
}

const outcomeOf = (data: unknown): string => {
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string | null } | null | undefined;
  return String(row?.outcome ?? 'no answer');
};

/** `logged` | `not_a_client` (a staff preview is not logged as the client) | any refusal. A database that does not answer throws: an access that cannot be logged is not allowed. */
export async function logHandoverAccess(packageId: string, event: 'viewed' | 'item_opened', itemKind?: string): Promise<string> {
  const rpc = await projectsRpc();
  const { data, error } = await rpc('log_handover_access', { p_package_id: packageId, p_event: event, p_item_kind: itemKind ?? null });
  if (error) throw new Error(`the handover access could not be logged: ${error.message}`);
  return outcomeOf(data);
}

export const REQUEST_WORDS: Record<string, string> = {
  requested: 'Sent. Your project contact will confirm it with you; it becomes a recorded acceptance only once they have.',
  already_requested: 'You have already sent this request for this version.',
  note_required: 'Please say what you would like changed.',
  contains_secret: 'That text looks like a password or key. Please do not send secrets here; describe the problem instead.',
  package_superseded: 'A newer version of the handover has been delivered. Please review that one.',
  portal_read_only: 'This project has been completed and archived: the portal is read-only.',
  project_completed: 'This project has already been completed.',
  not_delivered: 'This version has not been delivered to you yet.',
  not_found: 'That handover could not be found.',
  not_a_client: 'Only a client user can send this request.',
};

export async function requestHandoverAcceptance(packageId: string, kind: 'acceptance_request' | 'changes_request', note: string | null): Promise<{ ok: boolean; message: string }> {
  const rpc = await projectsRpc();
  const { data, error } = await rpc('request_handover_acceptance', { p_package_id: packageId, p_kind: kind, p_note: note });
  if (error) return { ok: false, message: 'The request could not be sent right now. Nothing was recorded.' };
  const outcome = outcomeOf(data);
  return { ok: outcome === 'requested', message: REQUEST_WORDS[outcome] ?? 'The request could not be sent.' };
}
