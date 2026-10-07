'use server';

import { revalidatePath } from 'next/cache';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import type { FormState } from '@/modules/identity/types';

/**
 * Phase 8A second-half Admin actions: ONE server action over a WHITELIST of database doors (preferences, cadence, feedback, goals, support follow-ups).
 * Nothing here decides: each door checks the role, the state and the tenant under its own lock and its refusal is shown in plain words. Nothing here sends
 * anything to a client, and a Developer/QA request is only an event: no Developer task is created by it.
 */

type Fd = FormData;
const text = (fd: Fd, key: string) => String(fd.get(key) ?? '').trim();
const optional = (fd: Fd, key: string) => text(fd, key) || null;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const utc = (v: string | null): string | null => (v && DATETIME.test(v) && !Number.isNaN(Date.parse(`${v}:00Z`)) ? `${v}:00Z` : null);
const channels = (fd: Fd): string[] => fd.getAll('avoidChannels').map((v) => String(v)).filter((v) => v !== '');
const gap = (fd: Fd): number | null => {
  const raw = text(fd, 'minGapDays');
  const n = Number(raw);
  return raw !== '' && Number.isInteger(n) && n >= 0 && n <= 365 ? n : null;
};

type Door = { rpc: string; args: (fd: Fd) => Record<string, unknown>; ok: readonly string[] };

const DOORS: Record<string, Door> = {
  set_preference: {
    rpc: 'set_client_contact_preference',
    args: (fd) => ({ p_client_account_id: text(fd, 'clientId'), p_preferred_channel: optional(fd, 'preferredChannel'), p_avoid_channels: channels(fd), p_language: optional(fd, 'language'), p_note: optional(fd, 'note') }),
    ok: ['set'],
  },
  set_cadence: { rpc: 'set_communication_category_cadence', args: (fd) => ({ p_purpose: text(fd, 'purpose'), p_min_gap_days: gap(fd) }), ok: ['set'] },
  clear_cadence: { rpc: 'clear_communication_category_cadence', args: (fd) => ({ p_purpose: text(fd, 'purpose') }), ok: ['cleared'] },
  record_feedback: {
    rpc: 'p8f_record_client_feedback',
    args: (fd) => ({ p_project_id: text(fd, 'projectId'), p_source: text(fd, 'source'), p_sentiment: text(fd, 'sentiment'), p_summary: text(fd, 'summary'), p_check_in_id: optional(fd, 'checkInId'), p_occurred_at: utc(optional(fd, 'occurredAt')) }),
    ok: ['recorded'],
  },
  record_goal: { rpc: 'record_client_goal', args: (fd) => ({ p_project_id: text(fd, 'projectId'), p_goal: text(fd, 'goal') }), ok: ['recorded', 'duplicate'] },
  close_goal: { rpc: 'close_client_goal', args: (fd) => ({ p_goal_id: text(fd, 'goalId'), p_status: text(fd, 'status'), p_note: text(fd, 'note') }), ok: ['closed'] },
  request_followup: { rpc: 'request_support_followup', args: (fd) => ({ p_ticket_id: text(fd, 'ticketId'), p_kind: text(fd, 'kind'), p_note: optional(fd, 'note') }), ok: ['requested'] },
};

const WORDS: Record<string, string> = {
  set: 'Saved.',
  cleared: 'Cleared. There is no rule for that category now.',
  recorded: 'Recorded. This is your record of what the client said; nothing was sent.',
  duplicate: 'That goal is already active: the existing one stands.',
  closed: 'Goal closed with your note.',
  requested: 'Requested. An event now carries the request; no Developer task was created by this.',
  not_authorized: 'You do not have permission to do this.',
  no_actor: 'You are not signed in as a member.',
  not_found: 'That record was not found.',
  bad_channel: 'Choose a valid channel.',
  preferred_is_avoided: 'The preferred channel cannot also be one to avoid.',
  bad_language: 'Use a language code such as en or pt-BR.',
  bad_purpose: 'Choose a purpose.',
  out_of_range: 'Choose a whole number of days from 0 to 365.',
  bad_source: 'Choose where the feedback came from.',
  bad_sentiment: 'Choose a sentiment.',
  summary_required: 'Say what was said (at least five characters).',
  goal_required: 'State the goal (at least five characters).',
  in_the_future: 'That cannot be dated in the future.',
  check_in_not_on_this_project: 'That check-in belongs to a different project.',
  bad_status: 'Choose achieved or dropped.',
  note_required: 'A note is required.',
  already_closed: 'That goal is already closed.',
  bad_kind: 'Choose developer or qa.',
  not_classified: 'Classify the ticket first.',
  not_a_developer_matter: 'This ticket is not a matter for a Developer.',
  wrong_state: 'The ticket is not in a state where that can be requested.',
  already_requested: 'That was already requested for this ticket.',
};

export async function phaseEightGaps2DoorAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const context = await requireInternal();
  if (!can(context, 'project.write')) return { status: 'error', message: 'You do not have permission to change this.' };
  const name = text(formData, 'door');
  const door = Object.prototype.hasOwnProperty.call(DOORS, name) ? DOORS[name] : undefined;
  if (!door) return { status: 'error', message: 'Unknown action.' };

  const built = door.args(formData);
  for (const [key, value] of Object.entries(built)) {
    if (typeof value === 'string' && value !== '' && /^p_(client_account|project|check_in|goal|ticket)_id$/.test(key) && !UUID.test(value)) return { status: 'error', message: 'A selected record is not valid.' };
  }
  if (name === 'set_cadence' && built.p_min_gap_days === null) return { status: 'error', message: WORDS.out_of_range! };
  if (name === 'record_feedback' && text(formData, 'occurredAt') !== '' && built.p_occurred_at === null) return { status: 'error', message: 'The time is not valid.' };

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc(door.rpc as never, built as never);
  if (error) return { status: 'error', message: 'The database did not answer; nothing was recorded.' };
  const row = ((Array.isArray(data) ? data[0] : data) ?? {}) as { outcome?: string | null };
  const outcome = String(row.outcome ?? 'no answer');
  if (!door.ok.includes(outcome)) return { status: 'error', message: WORDS[outcome] ?? `Refused: ${outcome.replace(/_/g, ' ')}.` };
  revalidatePath('/projects/customer-success');
  revalidatePath('/projects/customer-success/records');
  return { status: 'success', message: WORDS[outcome] ?? 'Done.' };
}
