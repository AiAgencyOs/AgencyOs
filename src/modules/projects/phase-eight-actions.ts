'use server';

import { revalidatePath } from 'next/cache';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createAdminClient } from '@/lib/db/admin';
import { createClient } from '@/lib/db/server';
import type { FormState } from '@/modules/identity/types';

/**
 * Phase 8A Admin actions: ONE server action over a WHITELIST of database doors. Nothing here decides: each door checks the role, the state,
 * the coverage rules and the gates under its own lock, and its answer is reported in plain words. The door name comes from the form but can only
 * select an entry of this table; an unknown name is refused.
 *
 * What is deliberately NOT here: any action that sends something to a client, quotes, prices or discounts, approves an Admin decision on someone's behalf,
 * or writes a status a database function derives. A reply is recorded as DRAFTED and then as SENT BY A PERSON; the system sends nothing.
 *
 * The one exception to "the signed-in user's own client" is the intake refresh, which is a service-role door by design (the entry gate reads a table the
 * service role fills). It runs only after an explicit permission check, scoped to the caller's organization.
 */

type Fd = FormData;
const text = (fd: Fd, key: string) => String(fd.get(key) ?? '').trim();
const optional = (fd: Fd, key: string) => text(fd, key) || null;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (v: string) => DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const checked = (fd: Fd, key: string) => fd.get(key) === 'on' || fd.get(key) === 'true';
/** An integer from a form inside bounds, or null (never NaN). */
const bounded = (fd: Fd, key: string, min: number, max: number): number | null => {
  const raw = text(fd, key);
  if (raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};

type Door = { schema: 'projects' | 'sales'; rpc: string; args: (fd: Fd) => Record<string, unknown>; ok: readonly string[] };

const DOORS: Record<string, Door> = {
  waive_gate: { schema: 'projects', rpc: 'waive_phase_eight_gate', args: (fd) => ({ p_project_id: text(fd, 'projectId'), p_gate_id: text(fd, 'gateId'), p_reason: text(fd, 'reason') }), ok: ['waived'] },
  start: {
    schema: 'projects',
    rpc: 'start_phase_eight',
    args: (fd) => ({
      p_project_id: text(fd, 'projectId'),
      p_warranty_starts_on: optional(fd, 'warrantyStartsOn'),
      p_warranty_ends_on: optional(fd, 'warrantyEndsOn'),
      p_warranty_coverage: optional(fd, 'warrantyCoverage'),
      p_warranty_exclusions: optional(fd, 'warrantyExclusions'),
      p_no_warranty_reason: optional(fd, 'noWarrantyReason'),
      p_owner: optional(fd, 'owner'),
    }),
    ok: ['started'],
  },
  set_state: { schema: 'projects', rpc: 'set_phase_eight_state', args: (fd) => ({ p_project_id: text(fd, 'projectId'), p_state: text(fd, 'state'), p_reason: optional(fd, 'reason') }), ok: ['set'] },
  set_setting: { schema: 'projects', rpc: 'set_phase_eight_setting', args: (fd) => ({ p_key: text(fd, 'key'), p_value: bounded(fd, 'value', 1, 100000) }), ok: ['set'] },

  open_ticket: {
    schema: 'projects',
    rpc: 'open_support_ticket',
    args: (fd) => ({ p_organization_id: null, p_project_id: text(fd, 'projectId'), p_title: text(fd, 'title'), p_description: optional(fd, 'description'), p_source: text(fd, 'source'), p_source_ref: optional(fd, 'sourceRef') }),
    ok: ['opened'],
  },
  classify: {
    schema: 'projects',
    rpc: 'classify_support_ticket',
    args: (fd) => ({ p_ticket_id: text(fd, 'ticketId'), p_classification: text(fd, 'classification'), p_coverage_decision: text(fd, 'coverage'), p_coverage_reason: text(fd, 'reason'), p_priority: text(fd, 'priority'), p_plan_id: optional(fd, 'planId') }),
    ok: ['classified'],
  },
  assign: { schema: 'projects', rpc: 'assign_support_ticket', args: (fd) => ({ p_ticket_id: text(fd, 'ticketId'), p_assignee: text(fd, 'assignee') }), ok: ['assigned'] },
  link: {
    schema: 'projects',
    rpc: 'link_support_root_cause',
    args: (fd) => ({ p_ticket_id: text(fd, 'ticketId'), p_defect_id: optional(fd, 'defectId'), p_change_request_id: optional(fd, 'changeRequestId'), p_maintenance_item_id: optional(fd, 'maintenanceItemId'), p_opportunity_id: optional(fd, 'opportunityId') }),
    ok: ['linked'],
  },
  advance: {
    schema: 'projects',
    rpc: 'advance_support_ticket',
    args: (fd) => ({ p_ticket_id: text(fd, 'ticketId'), p_to: text(fd, 'to'), p_note: optional(fd, 'note'), p_evidence: optional(fd, 'evidence'), p_release_needed: checked(fd, 'releaseNeeded') ? true : null }),
    ok: ['advanced', 'cancelled'],
  },
  confirm: { schema: 'projects', rpc: 'record_client_confirmation', args: (fd) => ({ p_ticket_id: text(fd, 'ticketId'), p_evidence: text(fd, 'evidence'), p_confirmed: text(fd, 'confirmed') !== 'no' }), ok: ['confirmed', 'reopened'] },
  escalate: { schema: 'projects', rpc: 'escalate_support_ticket', args: (fd) => ({ p_ticket_id: text(fd, 'ticketId'), p_to_role: text(fd, 'toRole'), p_reason: text(fd, 'reason') }), ok: ['escalated'] },
  acknowledge: { schema: 'projects', rpc: 'acknowledge_support_escalation', args: (fd) => ({ p_ticket_id: text(fd, 'ticketId'), p_note: optional(fd, 'note') }), ok: ['acknowledged'] },
  draft_reply: { schema: 'projects', rpc: 'draft_support_reply', args: (fd) => ({ p_ticket_id: text(fd, 'ticketId'), p_body: text(fd, 'body'), p_language: optional(fd, 'language') }), ok: ['drafted'] },
  reply_sent: { schema: 'projects', rpc: 'record_support_reply_sent', args: (fd) => ({ p_draft_id: text(fd, 'draftId'), p_channel: text(fd, 'channel') }), ok: ['recorded'] },
  discard_reply: { schema: 'projects', rpc: 'discard_support_reply_draft', args: (fd) => ({ p_draft_id: text(fd, 'draftId') }), ok: ['discarded'] },

  snapshot: { schema: 'projects', rpc: 'record_health_snapshot', args: (fd) => ({ p_project_id: text(fd, 'projectId'), p_trigger: 'manual' }), ok: ['first', 'changed', 'unchanged'] },
  recovery_update: {
    schema: 'projects',
    rpc: 'update_recovery_plan',
    args: (fd) => ({ p_plan_id: text(fd, 'planId'), p_owner: text(fd, 'owner'), p_root_cause: text(fd, 'rootCause'), p_actions: text(fd, 'actions'), p_deadline: text(fd, 'deadline') }),
    ok: ['updated'],
  },
  recovery_resolve: { schema: 'projects', rpc: 'resolve_recovery_plan', args: (fd) => ({ p_plan_id: text(fd, 'planId'), p_outcome: text(fd, 'outcome') }), ok: ['resolved'] },
  recovery_abandon: { schema: 'projects', rpc: 'abandon_recovery_plan', args: (fd) => ({ p_plan_id: text(fd, 'planId'), p_reason: text(fd, 'reason') }), ok: ['abandoned'] },

  check_in_create: {
    schema: 'projects',
    rpc: 'create_check_in',
    args: (fd) => ({ p_project_id: text(fd, 'projectId'), p_kind: text(fd, 'kind'), p_period_key: text(fd, 'periodKey'), p_due_on: text(fd, 'dueOn'), p_agenda: optional(fd, 'agenda'), p_source_ref: null, p_organization_id: null }),
    ok: ['created'],
  },
  check_in_complete: { schema: 'projects', rpc: 'complete_check_in', args: (fd) => ({ p_check_in_id: text(fd, 'checkInId'), p_engagement: text(fd, 'engagement'), p_channel: text(fd, 'channel'), p_outcome: text(fd, 'outcome') }), ok: ['completed'] },
  check_in_skip: { schema: 'projects', rpc: 'skip_check_in', args: (fd) => ({ p_check_in_id: text(fd, 'checkInId'), p_reason: text(fd, 'reason') }), ok: ['skipped'] },

  opp_record: {
    schema: 'sales',
    rpc: 'record_phase_eight_opportunity',
    args: (fd) => ({
      p_project_id: text(fd, 'projectId'),
      p_kind: text(fd, 'kind'),
      p_need: text(fd, 'need'),
      p_evidence: [{ type: text(fd, 'evidenceType'), id: text(fd, 'evidenceId') }],
      p_requested_outcome: optional(fd, 'requestedOutcome'),
      p_urgency: text(fd, 'urgency') || 'normal',
      p_stakeholders: optional(fd, 'stakeholders'),
      p_constraints: optional(fd, 'constraints'),
      p_agent_key: null,
      p_organization_id: null,
    }),
    ok: ['recorded'],
  },
  opp_qualify: { schema: 'sales', rpc: 'qualify_phase_eight_opportunity', args: (fd) => ({ p_opportunity_id: text(fd, 'opportunityId'), p_decision: text(fd, 'decision'), p_note: text(fd, 'note') }), ok: ['qualified', 'closed'] },
  opp_handoff: { schema: 'sales', rpc: 'hand_off_phase_eight_opportunity', args: (fd) => ({ p_opportunity_id: text(fd, 'opportunityId') }), ok: ['handed_off'] },
  opp_close: {
    schema: 'sales',
    rpc: 'close_phase_eight_opportunity',
    args: (fd) => ({ p_opportunity_id: text(fd, 'opportunityId'), p_outcome: text(fd, 'outcome'), p_reason: text(fd, 'reason'), p_change_request_id: optional(fd, 'changeRequestId'), p_new_project_id: optional(fd, 'newProjectId') }),
    ok: ['accepted', 'lost', 'closed_no_action'],
  },
};

const WORDS: Record<string, string> = {
  waived: 'Exception recorded with your reason. It shows on the intake as WAIVED, not as passed.',
  started: 'Phase 8 started. The post-handover check-in is due and the first health read was taken.',
  already_started: 'Phase 8 had already started.',
  set: 'Saved.',
  opened: 'Ticket opened.',
  duplicate: 'That message already opened a ticket.',
  classified: 'Classified. The SLA clocks now run from when the ticket was raised.',
  assigned: 'Assigned.',
  linked: 'Linked.',
  advanced: 'Done.',
  cancelled: 'Cancelled, with your note.',
  confirmed: 'The client\'s confirmation is recorded with your evidence.',
  reopened: 'Reopened: the client said it is not fixed.',
  escalated: 'Escalated to a person.',
  acknowledged: 'Acknowledged.',
  drafted: 'Draft saved. Nothing was sent: send it yourself, then record that you did.',
  recorded: 'Recorded. The response clock stopped at this moment because you said you replied.',
  discarded: 'Draft discarded.',
  first: 'First health snapshot recorded.',
  changed: 'Health changed: a snapshot was recorded.',
  unchanged: 'Health is unchanged: no new snapshot.',
  updated: 'Recovery plan updated and in progress.',
  resolved: 'Resolved on a fresh health read.',
  abandoned: 'Recovery plan closed without recovery, with your reason.',
  created: 'Created.',
  completed: 'Check-in recorded.',
  skipped: 'Skipped, with your reason.',
  qualified: 'Qualified by you. It can now be handed to Sales.',
  closed: 'Closed with no action.',
  handed_off: 'Handed to Sales: a CRM opportunity was opened in discovery with no value. The price is Sales\' to quote through the quotation doors.',
  accepted: 'Recorded as accepted, as a separate change request or project.',
  lost: 'Recorded as lost.',
  closed_no_action: 'Closed with no action.',
  intake_filled: 'Intake refreshed.',

  not_authorized: 'You do not have permission to do this.',
  no_actor: 'You are not signed in as a member.',
  not_found: 'That record was not found.',
  not_completed: 'The project is not completed.',
  intake_missing: 'There is no intake yet. Refresh it first.',
  intake_not_ready: 'The intake has blockers. Fix them or ask the owner to waive one with a reason.',
  warranty_required: 'Define the warranty window with its coverage and exclusions, or record that there is none and why.',
  owner_not_a_member: 'The owner must be an active member of this organization.',
  not_waivable: 'That gate cannot be waived.',
  reason_required: 'A reason is required.',
  note_required: 'A note is required.',
  bad_title: 'Give the ticket a title (up to 200 characters).',
  bad_source: 'Choose where the ticket came from.',
  no_phase_eight: 'Phase 8 has not started for this project.',
  workspace_closed: 'This workspace is closed.',
  coverage_mismatch: 'That coverage does not fit that classification. New scope is never covered as warranty or maintenance.',
  outside_warranty: 'The issue was raised outside the warranty window, so it cannot be recorded as covered by warranty.',
  no_active_plan: 'No active maintenance plan version covers the day it was raised.',
  plan_only_for_maintenance: 'A plan is named only for maintenance coverage.',
  bad_priority: 'Choose a priority from P1 to P4.',
  too_late: 'The ticket is past classification.',
  wrong_state: 'The ticket is not in a state that allows that.',
  terminal: 'The ticket is closed.',
  assignee_not_a_member: 'The assignee must be an active member.',
  wrong_link_for_classification: 'That record cannot be linked to a ticket of this classification.',
  wrong_project: 'That record belongs to a different project.',
  nothing_to_link: 'Choose a record to link.',
  classify_first: 'Classify the ticket first.',
  assign_first: 'Assign the ticket first.',
  out_of_scope_is_not_maintenance_work: 'A change request or new project is not worked as maintenance. Route it instead.',
  dispute_unresolved: 'A disputed ticket is not worked until it is classified.',
  root_cause_required: 'Link the defect or maintenance item this ticket is about first.',
  no_qa_for_this_class: 'This kind of ticket does not go to QA.',
  no_release_needed: 'This ticket was marked as needing no release.',
  release_required: 'A release is needed: move it to release first.',
  release_evidence_required: 'Record the release reference as evidence.',
  qa_required: 'A technical fix goes through QA first.',
  qa_not_verified: 'The linked defect is not verified yet.',
  qa_evidence_required: 'Record the QA evidence reference.',
  client_confirmation_required: 'The client\'s confirmation has not been recorded.',
  answer_and_source_required: 'Record the answer you gave.',
  approved_knowledge_citation_required: 'Cite the approved knowledge article this answer came from (Knowledge, then cite for this ticket) before closing.',
  cited_knowledge_no_longer_approved: 'The article you cited has been retired. Cite its current approved version.',
  must_route_first: 'Link the change request or opportunity this became before closing.',
  evidence_required: 'Evidence is required: where and what the client said.',
  already_open: 'An escalation is already open on this ticket.',
  not_escalated: 'This ticket is not escalated.',
  already_acknowledged: 'Already acknowledged.',
  bad_role: 'Choose the owner or the ops admin.',
  bad_body: 'The reply must be 1 to 4000 characters.',
  already_drafted: 'That exact draft already exists.',
  not_a_draft: 'That reply is no longer a draft.',
  bad_channel: 'Choose a channel.',
  paused: 'The workspace is paused.',
  bad_trigger: 'Unknown trigger.',
  incomplete: 'A recovery plan needs an owner, a root cause, actions and a deadline.',
  not_in_progress: 'The recovery plan is not in progress.',
  outcome_required: 'Record the outcome (at least ten characters).',
  health_not_recovered: 'The account is still at risk or critical on a fresh read, so the plan stays open.',
  no_signals: 'No health signals could be read.',
  bad_kind: 'Unknown kind.',
  bad_period: 'A period key and a due date are required.',
  bad_engagement: 'Choose an engagement state.',
  not_due: 'That check-in is no longer due.',
  already_exists: 'That check-in already exists.',
  bad_urgency: 'Unknown urgency.',
  need_required: 'Describe the need (at least ten characters).',
  no_price_here: 'An opportunity names no price, quote or discount: Sales quotes in the quotation doors.',
  evidence_not_found: 'The evidence is not a record of this project.',
  evidence_not_classified: 'The evidence ticket has not been classified.',
  already_included: 'That is already covered by warranty, maintenance or the approved scope: an obligation, not an opportunity.',
  bad_evidence: 'Evidence needs a type and a record id.',
  recovery_first: 'This account needs service recovery first. Commercial outreach waits.',
  not_qualified: 'Qualify the opportunity first.',
  not_handed_off: 'It has not been handed to Sales yet.',
  name_what_it_became: 'Name the change request or the new project it became (exactly one).',
  lead_busy: 'This client\'s lead already has an open deal.',
  bad_decision: 'Unknown decision.',
  bad_outcome: 'Unknown outcome.',
  bad_state: 'Unknown state.',
  unknown_key: 'Unknown setting.',
  out_of_range: 'That value is outside the allowed range.',
};

export async function phaseEightDoorAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const context = await requireInternal();
  if (!can(context, 'project.write')) return { status: 'error', message: 'You do not have permission to change this project.' };
  const name = text(formData, 'door');
  const projectId = text(formData, 'projectId');

  // the intake refresh is the one service-role door: it runs after the permission check above, scoped to the caller's organization
  if (name === 'refresh_intake') {
    if (!UUID.test(projectId) || !context.organizationId) return { status: 'error', message: 'That record was not found.' };
    const admin = createAdminClient();
    const { data, error } = await admin.schema('projects').rpc('fill_phase_eight_intake' as never, { p_organization_id: context.organizationId, p_project_id: projectId } as never);
    if (error) return { status: 'error', message: 'The database did not answer; nothing was recorded.' };
    const row = ((Array.isArray(data) ? data[0] : data) ?? {}) as { outcome?: string | null };
    const outcome = String(row.outcome ?? 'no answer');
    if (outcome !== 'ready' && outcome !== 'incomplete') return { status: 'error', message: WORDS[outcome] ?? `Refused: ${outcome.replace(/_/g, ' ')}.` };
    revalidatePath(`/projects/${projectId}`);
    return { status: 'success', message: outcome === 'ready' ? 'Intake refreshed: every gate passes.' : 'Intake refreshed: it still has blockers, listed below.' };
  }

  const door = Object.prototype.hasOwnProperty.call(DOORS, name) ? DOORS[name] : undefined;
  if (!door) return { status: 'error', message: 'Unknown action.' };

  const built = door.args(formData);
  // a malformed id or date is refused here with a word, never sent to the database to fail as a type error
  for (const [key, value] of Object.entries(built)) {
    if (typeof value === 'string' && value !== '' && /^(p_.*_id|p_assignee|p_owner)$/.test(key) && !UUID.test(value)) return { status: 'error', message: 'A selected record is not valid.' };
    if (typeof value === 'string' && value !== '' && /^p_(warranty_(starts|ends)_on|deadline|due_on)$/.test(key) && !isDate(value)) return { status: 'error', message: 'A date is not valid (use year-month-day).' };
  }
  if (name === 'set_setting' && built.p_value === null) return { status: 'error', message: 'Enter a whole number.' };
  if (name === 'recovery_update' && !built.p_deadline) return { status: 'error', message: WORDS.incomplete! };
  if (name === 'opp_record') {
    const evidence = (built.p_evidence as { type: string; id: string }[])[0];
    if (!evidence || !evidence.type || !UUID.test(evidence.id)) return { status: 'error', message: WORDS.bad_evidence! };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema(door.schema).rpc(door.rpc as never, built as never);
  if (error) return { status: 'error', message: 'The database did not answer; nothing was recorded.' };
  const row = ((Array.isArray(data) ? data[0] : data) ?? {}) as { outcome?: string | null };
  const outcome = String(row.outcome ?? 'no answer');
  if (!door.ok.includes(outcome)) return { status: 'error', message: WORDS[outcome] ?? `Refused: ${outcome.replace(/_/g, ' ')}.` };
  revalidatePath(`/projects/${projectId}`);
  revalidatePath('/projects/customer-success');
  return { status: 'success', message: WORDS[outcome] ?? 'Done.' };
}
