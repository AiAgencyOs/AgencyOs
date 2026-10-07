'use server';

import { revalidatePath } from 'next/cache';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import type { FormState } from '@/modules/identity/types';

import { readValueReportFacts } from './customer-360-queries';
import { CURRENT_VALUE_REPORT_TEMPLATE_VERSION, renderValueReport } from './value-report';

/**
 * Phase 8D Admin actions: communication governance and value-report drafts. ONE server action over a WHITELIST of database doors (the same shape as
 * the Phase 8A action). Nothing here decides: each door checks the role, the state and the tenant under its own lock and its answer is reported in plain
 * words. Nothing here SENDS anything: "record a contact" is a person saying what they did, a value report is a draft a person edits and approves.
 *
 * The one door with logic is `report_store`: it reads the facts from the database, renders the body with the VERSIONED template (a pure function of the
 * facts) and stores the draft with the digest of the facts it rendered, so the database refuses a body built from facts that have since changed.
 */

type Fd = FormData;
const text = (fd: Fd, key: string) => String(fd.get(key) ?? '').trim();
const optional = (fd: Fd, key: string) => text(fd, key) || null;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const isDate = (v: string) => DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
/** A `datetime-local` value is read as UTC (the form says so); anything else is refused, never guessed. */
const utc = (v: string | null): string | null => (v && DATETIME.test(v) && !Number.isNaN(Date.parse(`${v}:00Z`)) ? `${v}:00Z` : null);
const bounded = (fd: Fd, key: string, min: number, max: number): number | null => {
  const raw = text(fd, key);
  if (raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};

type Door = { rpc: string; args: (fd: Fd) => Record<string, unknown>; ok: readonly string[] };

const DOORS: Record<string, Door> = {
  set_cap: {
    rpc: 'set_client_communication_cap',
    args: (fd) => ({ p_client_account_id: text(fd, 'clientId'), p_channel: text(fd, 'channel') === 'all' ? null : optional(fd, 'channel'), p_max_contacts: bounded(fd, 'maxContacts', 1, 1000), p_window_days: bounded(fd, 'windowDays', 1, 365) }),
    ok: ['set'],
  },
  clear_cap: { rpc: 'clear_client_communication_cap', args: (fd) => ({ p_client_account_id: text(fd, 'clientId'), p_channel: text(fd, 'channel') === 'all' ? null : optional(fd, 'channel') }), ok: ['cleared'] },
  add_quiet: {
    rpc: 'add_client_quiet_period',
    args: (fd) => ({ p_client_account_id: text(fd, 'clientId'), p_starts_at: utc(optional(fd, 'startsAt')), p_ends_at: utc(optional(fd, 'endsAt')), p_reason: text(fd, 'reason') }),
    ok: ['added'],
  },
  cancel_quiet: { rpc: 'cancel_client_quiet_period', args: (fd) => ({ p_quiet_period_id: text(fd, 'quietPeriodId'), p_reason: text(fd, 'reason') }), ok: ['cancelled'] },
  record_contact: {
    rpc: 'record_client_communication',
    args: (fd) => ({
      p_client_account_id: text(fd, 'clientId'), p_channel: text(fd, 'channel'), p_purpose: text(fd, 'purpose'), p_summary: text(fd, 'summary'), p_project_id: optional(fd, 'projectId'),
      p_contact_id: optional(fd, 'contactId'), p_occurred_at: utc(optional(fd, 'occurredAt')), p_message_id: null, p_external_ref: optional(fd, 'externalRef'),
    }),
    ok: ['recorded', 'duplicate'],
  },
  record_event: { rpc: 'record_client_communication_event', args: (fd) => ({ p_ledger_id: text(fd, 'ledgerId'), p_event: text(fd, 'event'), p_note: optional(fd, 'note'), p_occurred_at: utc(optional(fd, 'occurredAt')) }), ok: ['recorded'] },
  report_edit: { rpc: 'edit_value_report_draft', args: (fd) => ({ p_report_id: text(fd, 'reportId'), p_body: text(fd, 'body') }), ok: ['edited'] },
  report_approve: { rpc: 'approve_value_report_draft', args: (fd) => ({ p_report_id: text(fd, 'reportId') }), ok: ['approved'] },
  report_discard: { rpc: 'discard_value_report_draft', args: (fd) => ({ p_report_id: text(fd, 'reportId'), p_reason: text(fd, 'reason') }), ok: ['discarded'] },
};

const WORDS: Record<string, string> = {
  set: 'Cap saved. Anyone asking whether this client may be contacted now sees it.',
  cleared: 'Cap cleared. This client has no cap on that channel now.',
  added: 'Quiet period added: nobody may contact this client inside it.',
  cancelled: 'Quiet period cancelled. The record stays.',
  recorded: 'Recorded. Nothing was sent by this: it is your record of what you did.',
  duplicate: 'That provider reference was already recorded: the existing entry stands.',
  edited: 'Wording saved. The facts under it do not change.',
  approved: 'Approved as the wording you stand behind. Nothing was sent.',
  discarded: 'Draft discarded.',
  drafted: 'Draft saved from the recorded facts. Nothing was sent: edit it, then approve it.',
  not_authorized: 'You do not have permission to do this.',
  no_actor: 'You are not signed in as a member.',
  not_found: 'That record was not found.',
  out_of_range: 'That number is outside the allowed range.',
  bad_channel: 'Choose a channel.',
  bad_purpose: 'Choose a purpose.',
  bad_event: 'Choose what happened.',
  bad_interval: 'The end must come after the start.',
  reason_required: 'A reason is required (at least five characters).',
  already_cancelled: 'That quiet period was already cancelled.',
  summary_required: 'Say what was done (at least five characters).',
  in_the_future: 'A contact cannot be dated in the future.',
  before_the_send: 'That cannot be dated before the contact it describes.',
  not_a_sent_entry: 'Only a contact a person made can have a delivery or reply recorded.',
  already_recorded: 'That is already recorded for this entry.',
  body_required: 'The wording must be at least twenty characters.',
  names_a_price: 'A report names no price, quote or discount. Take that wording out.',
  not_a_draft: 'That report is no longer a draft.',
  bad_template_version: 'The report template version is not valid.',
  bad_period: 'Choose a period of at most 400 days, with the end on or after the start.',
  nothing_to_report: 'Nothing was recorded for this client in that period, so there is nothing to report.',
  facts_changed: 'The recorded facts changed while the draft was being written. Build it again.',
};

export async function phaseEightDDoorAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const context = await requireInternal();
  if (!can(context, 'project.write')) return { status: 'error', message: 'You do not have permission to change this client.' };
  const name = text(formData, 'door');
  const clientId = text(formData, 'clientId');
  if (!UUID.test(clientId)) return { status: 'error', message: 'That record was not found.' };

  const supabase = await createClient();

  // build a value-report draft: facts from the database, words from the versioned template, one door
  if (name === 'report_store') {
    const start = text(formData, 'periodStart');
    const end = text(formData, 'periodEnd');
    if (!isDate(start) || !isDate(end) || end < start) return { status: 'error', message: WORDS.bad_period! };
    const read = await readValueReportFacts(clientId, start, end);
    if (!read) return { status: 'error', message: WORDS.bad_period! };
    if (read.facts.length === 0) return { status: 'error', message: WORDS.nothing_to_report! };
    const body = renderValueReport({ clientName: read.clientName, periodStart: start, periodEnd: end, facts: read.facts }, CURRENT_VALUE_REPORT_TEMPLATE_VERSION);
    if (body.length > 8000) return { status: 'error', message: 'That period holds too many facts for one report. Choose a shorter period.' };
    const { data, error } = await supabase.schema('projects').rpc('store_value_report_draft' as never, {
      p_client_account_id: clientId, p_start: start, p_end: end, p_template_version: CURRENT_VALUE_REPORT_TEMPLATE_VERSION, p_body: body, p_facts_digest: read.digest,
    } as never);
    if (error) return { status: 'error', message: 'The database did not answer; nothing was recorded.' };
    const row = ((Array.isArray(data) ? data[0] : data) ?? {}) as { outcome?: string | null };
    const outcome = String(row.outcome ?? 'no answer');
    if (outcome !== 'drafted') return { status: 'error', message: WORDS[outcome] ?? `Refused: ${outcome.replace(/_/g, ' ')}.` };
    revalidatePath(`/clients/${clientId}/customer-360`);
    return { status: 'success', message: WORDS.drafted! };
  }

  const door = Object.prototype.hasOwnProperty.call(DOORS, name) ? DOORS[name] : undefined;
  if (!door) return { status: 'error', message: 'Unknown action.' };

  const built = door.args(formData);
  // a malformed id or time is refused here with a word, never sent to the database to fail as a type error
  for (const [key, value] of Object.entries(built)) {
    if (typeof value === 'string' && value !== '' && /^p_(client_account|project|contact|ledger|report|quiet_period)_id$/.test(key) && !UUID.test(value)) return { status: 'error', message: 'A selected record is not valid.' };
  }
  if (name === 'set_cap' && (built.p_max_contacts === null || built.p_window_days === null)) return { status: 'error', message: WORDS.out_of_range! };
  if (name === 'add_quiet' && (built.p_starts_at === null || built.p_ends_at === null)) return { status: 'error', message: WORDS.bad_interval! };
  if (name === 'record_contact' && text(formData, 'occurredAt') !== '' && built.p_occurred_at === null) return { status: 'error', message: 'The time is not valid.' };

  const { data, error } = await supabase.schema('projects').rpc(door.rpc as never, built as never);
  if (error) return { status: 'error', message: 'The database did not answer; nothing was recorded.' };
  const row = ((Array.isArray(data) ? data[0] : data) ?? {}) as { outcome?: string | null };
  const outcome = String(row.outcome ?? 'no answer');
  if (!door.ok.includes(outcome)) return { status: 'error', message: WORDS[outcome] ?? `Refused: ${outcome.replace(/_/g, ' ')}.` };
  revalidatePath(`/clients/${clientId}/customer-360`);
  return { status: 'success', message: WORDS[outcome] ?? 'Done.' };
}
