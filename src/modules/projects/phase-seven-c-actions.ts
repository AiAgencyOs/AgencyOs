'use server';

import { revalidatePath } from 'next/cache';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import type { FormState } from '@/modules/identity/types';

/**
 * Phase 7c Admin actions: ONE server action over a WHITELIST of two database doors (the same shape as phase-seven-b-actions.ts). Nothing here decides: the door
 * checks delivery rights, the due date, secrets and the person's own verification, and every refusal is reported as the door wrote it. Nothing is sent to the
 * client from here, and nothing confirms a client's claim without the person writing down what they checked.
 */

type Fd = FormData;
const text = (fd: Fd, key: string) => String(fd.get(key) ?? '').trim();
const optional = (fd: Fd, key: string) => text(fd, key) || null;

type Door = { rpc: string; args: (fd: Fd) => Record<string, unknown>; ok: readonly string[] };

const DOORS: Record<string, Door> = {
  raise_client_action: {
    rpc: 'create_client_action_request',
    args: (fd) => {
      const due = text(fd, 'dueAt');
      return { p_project_id: text(fd, 'projectId'), p_kind: text(fd, 'kind'), p_title: text(fd, 'title'), p_instructions: text(fd, 'instructions'), p_due_at: due ? new Date(due).toISOString() : null };
    },
    ok: ['raised', 'already_open'],
  },
  settle_client_action: {
    rpc: 'settle_client_action_request',
    args: (fd) => ({ p_request_id: text(fd, 'requestId'), p_decision: text(fd, 'decision'), p_note: optional(fd, 'note') }),
    ok: ['confirmed', 'rejected', 'cancelled'],
  },
};

const WORDS: Record<string, string> = {
  raised: 'Raised. The client sees it in the portal; nothing was sent to them.',
  already_open: 'That request is already open.',
  confirmed: 'Confirmed, with your verification recorded.',
  rejected: 'Sent back to the client with your note.',
  cancelled: 'Cancelled, with your reason recorded.',
  not_authorized: 'You do not have permission to do this.',
  no_actor: 'This must be done by a signed-in person.',
  due_in_the_past: 'The deadline must be in the future.',
  instructions_required: 'Write the exact instruction for the client.',
  bad_title: 'A short title is required (200 characters at most).',
  contains_secret: 'That text looks like a password or key. Describe it instead; never put a secret here.',
  not_in_phase_seven: 'This project is not in the Phase 7 pipeline.',
  verification_required: 'Write down what you checked (the DNS answer, the account, the record) before confirming.',
  note_required: 'A note for the client is required.',
  reason_required: 'A reason is required.',
  nothing_to_confirm: 'The client has not said they did it yet.',
  nothing_to_return: 'The client has not said they did it yet.',
  already_settled: 'That request was already settled.',
};

export async function phaseSevenCDoorAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const context = await requireInternal();
  if (!can(context, 'project.write')) return { status: 'error', message: 'You do not have permission to change this project.' };
  const name = text(formData, 'door');
  const door = Object.prototype.hasOwnProperty.call(DOORS, name) ? DOORS[name] : undefined;
  if (!door) return { status: 'error', message: 'Unknown action.' };

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc(door.rpc as never, door.args(formData) as never);
  if (error) return { status: 'error', message: 'The database did not answer; nothing was recorded.' };
  const row = ((Array.isArray(data) ? data[0] : data) ?? {}) as { outcome?: string | null };
  const outcome = String(row.outcome ?? 'no answer');
  if (!door.ok.includes(outcome)) return { status: 'error', message: WORDS[outcome] ?? `Refused: ${outcome.replace(/_/g, ' ')}.` };
  revalidatePath(`/projects/${text(formData, 'projectId')}`);
  return { status: 'success', message: WORDS[outcome] ?? 'Done.' };
}
