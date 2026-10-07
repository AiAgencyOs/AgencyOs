'use server';

import { revalidatePath } from 'next/cache';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import type { FormState } from '@/modules/identity/types';

/**
 * Phase 7b Admin actions: ONE server action over a WHITELIST of database doors (the same shape as phase-seven-actions.ts). Nothing here decides: a portal
 * request is confirmed or declined by a person (the door checks delivery rights, the exact version and that the person gives their own verification), a
 * retention policy and an archive are an Admin's (the door checks), and every refusal is reported as the door wrote it.
 *
 * There is deliberately NO door here that deletes anything, accepts a handover on a client's behalf without a person's verification, or enables an agent.
 */

type Fd = FormData;
const text = (fd: Fd, key: string) => String(fd.get(key) ?? '').trim();
const optional = (fd: Fd, key: string) => text(fd, key) || null;
const yes = (fd: Fd, key: string) => text(fd, key) === 'yes';

type Door = { rpc: string; args: (fd: Fd) => Record<string, unknown>; ok: readonly string[] };

const DOORS: Record<string, Door> = {
  settle_request: {
    rpc: 'settle_portal_handover_request',
    args: (fd) => ({ p_request_id: text(fd, 'requestId'), p_decision: text(fd, 'decision'), p_verification: optional(fd, 'verification'), p_note: optional(fd, 'note') }),
    ok: ['confirmed', 'declined'],
  },
  set_policy: {
    rpc: 'set_retention_policy',
    args: (fd) => {
      const days = text(fd, 'days');
      const portal = text(fd, 'recordClass') === 'client_portal_access' ? yes(fd, 'portalReadOnly') : null;
      return { p_record_class: text(fd, 'recordClass'), p_indefinite: yes(fd, 'indefinite'), p_retention_days: yes(fd, 'indefinite') || days === '' ? null : Number(days), p_portal_read_only: portal, p_reason: text(fd, 'reason') };
    },
    ok: ['set'],
  },
  start_archive: { rpc: 'start_project_archive', args: (fd) => ({ p_project_id: text(fd, 'projectId') }), ok: ['started', 'already_archiving', 'already_archived'] },
  finish_archive: { rpc: 'finish_project_archive', args: (fd) => ({ p_project_id: text(fd, 'projectId') }), ok: ['archived', 'already_archived'] },
};

const WORDS: Record<string, string> = {
  confirmed: 'Confirmed: the formal acceptance (or change request) is recorded against the exact version, with your verification as the evidence.',
  declined: 'Declined, with your reason recorded.',
  set: 'Saved as a new policy version.',
  started: 'Archiving started: the project\'s scope records are frozen. Nothing was deleted.',
  already_archiving: 'Already archiving.',
  archived: 'Archived. The record stays searchable; nothing was deleted.',
  already_archived: 'Already archived.',
  not_authorized: 'You do not have permission to do this.',
  no_actor: 'This must be done by a signed-in person.',
  verification_required: 'Write down how you verified that the request really came from the client (a call, an email, the signed document).',
  note_required: 'A reason is required.',
  already_settled: 'That request was already settled.',
  package_superseded: 'That version was superseded: acceptance applies to the exact current version.',
  not_completed: 'Only a completed Phase 7 project is archived.',
  no_retention_policy: 'Set a retention policy for every record class first: the system holds no default period.',
  period_or_indefinite: 'A policy is a period in days OR indefinite, never both and never neither.',
  portal_policy_only_for_portal_access: 'Only the client portal access policy says whether the portal becomes read-only.',
  reason_required: 'A reason is required.',
};

export async function phaseSevenBDoorAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const context = await requireInternal();
  if (!can(context, 'project.write')) return { status: 'error', message: 'You do not have permission to change this project.' };
  const name = text(formData, 'door');
  const door = Object.prototype.hasOwnProperty.call(DOORS, name) ? DOORS[name] : undefined;
  if (!door) return { status: 'error', message: 'Unknown action.' };

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc(door.rpc as never, door.args(formData) as never);
  if (error) return { status: 'error', message: 'The database did not answer; nothing was recorded.' };
  const row = ((Array.isArray(data) ? data[0] : data) ?? {}) as { outcome?: string | null; missing?: string[] | null };
  const outcome = String(row.outcome ?? 'no answer');
  const missing = Array.isArray(row.missing) && row.missing.length > 0 ? ` Missing: ${row.missing.join(', ')}.` : '';
  if (!door.ok.includes(outcome)) return { status: 'error', message: `${WORDS[outcome] ?? `Refused: ${outcome.replace(/_/g, ' ')}.`}${missing}` };
  revalidatePath(`/projects/${text(formData, 'projectId')}`);
  return { status: 'success', message: WORDS[outcome] ?? 'Done.' };
}
