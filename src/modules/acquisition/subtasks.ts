import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';
import type { Json } from '@/lib/db/types';

import type { ConversationOwner } from './identity';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Subtasks (20261017100000): how an acquisition agent asks the Scheduler for a meeting or the Quotation Master for a quotation
 * (spec §44). The agent that asks must be the CONVERSATION OWNER; the assignee owns only the subtask; the result returns to the
 * owner at the time it ends. A request may not carry a price, and a quotation names the CONFIRMED requirement version it is built
 * from. Everything is enforced in the database - this file is a typed door.
 */

export type MeetingRequestInput = {
  mode: 'call' | 'video_meeting' | 'in_person_meeting' | 'other';
  timezone: string;
  purpose?: string;
  requestedStartAt?: string;
  requestedWindowEnd?: string;
  durationMinutes?: number;
};

export type SubtaskRefusal =
  | 'forbidden' | 'invalid' | 'pricing_not_allowed' | 'unknown_lead' | 'closed' | 'no_owner' | 'not_owner' | 'exists_open'
  | 'requirements_not_confirmed' | `meeting_${string}`;

export type RequestedSubtask =
  | { ok: true; outcome: 'created' | 'exists'; subtaskId: string; meetingId: string | null }
  | { ok: false; refusal: SubtaskRefusal; existingId?: string };

async function request(
  admin: Admin,
  input: { organizationId: string; leadId: string; kind: 'schedule_meeting' | 'prepare_quotation'; requestingAgent: ConversationOwner; objective: string; payload: Record<string, unknown>; idempotencyKey: string; priority?: number; correlationId?: string },
): Promise<RequestedSubtask> {
  const { data, error } = await admin.schema('crm').rpc('request_subtask', {
    p_organization_id: input.organizationId, p_lead: input.leadId, p_kind: input.kind, p_requesting_agent: input.requestingAgent,
    p_objective: input.objective, p_input: input.payload as unknown as Json, p_idempotency_key: input.idempotencyKey,
    p_priority: input.priority, p_correlation_id: input.correlationId,
  });
  if (error) throw new Error(`requestSubtask failed: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; subtask_id?: string | null; meeting_id?: string | null } | undefined;
  if ((row?.outcome === 'created' || row?.outcome === 'exists') && row.subtask_id) return { ok: true, outcome: row.outcome, subtaskId: row.subtask_id, meetingId: row.meeting_id ?? null };
  return { ok: false, refusal: (row?.outcome ?? 'invalid') as SubtaskRefusal, existingId: row?.subtask_id ?? undefined };
}

/** Ask for a meeting. The idempotency key makes a replayed job ask once. */
export function requestMeeting(admin: Admin, input: { organizationId: string; leadId: string; requestingAgent: ConversationOwner; objective: string; meeting: MeetingRequestInput; idempotencyKey: string; correlationId?: string }) {
  const m = input.meeting;
  return request(admin, {
    organizationId: input.organizationId, leadId: input.leadId, kind: 'schedule_meeting', requestingAgent: input.requestingAgent, objective: input.objective,
    payload: { mode: m.mode, timezone: m.timezone, purpose: m.purpose, requested_start_at: m.requestedStartAt, requested_window_end: m.requestedWindowEnd, duration_minutes: m.durationMinutes },
    idempotencyKey: input.idempotencyKey, correlationId: input.correlationId,
  });
}

/** Ask for a quotation built from the lead's CONFIRMED requirements. There is deliberately nowhere to put a price. */
export function requestQuotation(admin: Admin, input: { organizationId: string; leadId: string; requestingAgent: ConversationOwner; objective: string; requirementVersionId: string; notes?: string; idempotencyKey: string; correlationId?: string }) {
  return request(admin, {
    organizationId: input.organizationId, leadId: input.leadId, kind: 'prepare_quotation', requestingAgent: input.requestingAgent, objective: input.objective,
    payload: { requirement_version_id: input.requirementVersionId, notes: input.notes }, idempotencyKey: input.idempotencyKey, correlationId: input.correlationId,
  });
}

export async function acceptSubtask(admin: Admin, input: { organizationId: string; subtaskId: string; assignee: 'scheduler' | 'quotation_master' | 'human' }): Promise<string> {
  const { data, error } = await admin.schema('crm').rpc('accept_subtask', { p_organization_id: input.organizationId, p_subtask: input.subtaskId, p_assignee: input.assignee });
  if (error) throw new Error(`acceptSubtask failed: ${error.message}`);
  return ((Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined)?.outcome ?? 'invalid';
}

/** Attach the proposal that was built. Refused unless it was built from the requirement version the request named. */
export async function linkSubtaskProposal(admin: Admin, input: { organizationId: string; subtaskId: string; proposalId: string }): Promise<string> {
  const { data, error } = await admin.schema('crm').rpc('link_subtask_proposal', { p_organization_id: input.organizationId, p_subtask: input.subtaskId, p_proposal: input.proposalId });
  if (error) throw new Error(`linkSubtaskProposal failed: ${error.message}`);
  return ((Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined)?.outcome ?? 'invalid';
}
