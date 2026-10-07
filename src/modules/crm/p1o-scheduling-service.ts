import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { asRows, firstRow, text, userRpc, whole } from '@/lib/db/p1o-rpc';
import { policyFromRow, type SchedulingPolicy } from '@/lib/scheduling/p1o-policy';
import { err, ok, unreadable, type Result } from '@/lib/result';

/**
 * The Scheduler's policy, the things that need a person, and the numbers (P1-SCHED-018/020/026/065/068/069).
 * Reads are database functions scoped to the caller's organisation; a read that fails is `unreadable`. Writing the policy is an administrator's act and the
 * database says who may; flagging and handling a flag move nothing: they ask a person to act through the existing meeting doors.
 */

export async function readSchedulingPolicy(organizationId: string): Promise<SchedulingPolicy> {
  const rpc = await userRpc('crm');
  const { data, error } = await rpc('p1o_scheduling_policy_for', { p_organization_id: organizationId });
  if (error) unreadable('readSchedulingPolicy', error);
  return policyFromRow(firstRow(data));
}

export type MeetingFlag = {
  flagId: string;
  meetingId: string;
  leadId: string;
  kind: string;
  note: string;
  candidateMeetingIds: string[];
  raisedAt: string;
  ageMinutes: number;
  meetingStatus: string;
  confirmedStartAt: string | null;
};

export async function listOpenMeetingFlags(): Promise<MeetingFlag[]> {
  const rpc = await userRpc('crm');
  const { data, error } = await rpc('p1o_open_meeting_flags', { p_limit: 100 });
  if (error) unreadable('listOpenMeetingFlags', error);
  return asRows(data).map((r) => ({
    flagId: String(r.flag_id),
    meetingId: String(r.meeting_id),
    leadId: String(r.lead_id),
    kind: String(r.kind),
    note: String(r.note),
    candidateMeetingIds: Array.isArray(r.candidate_meeting_ids) ? (r.candidate_meeting_ids as string[]) : [],
    raisedAt: String(r.raised_at),
    ageMinutes: whole(r.age_minutes),
    meetingStatus: String(r.meeting_status),
    confirmedStartAt: text(r.confirmed_start_at),
  }));
}

export type SchedulerMetrics = {
  requests: number; calls: number; videoMeetings: number; inPerson: number; otherMode: number; bookedEver: number; bookingRate: number | null;
  medianHoursRequestToBooking: number | null; rescheduled: number; cancelled: number; completed: number; noShow: number;
  rescheduleRate: number | null; cancelRate: number | null; noShowRate: number | null; proposalsExpired: number; flagsOpen: number; flagsHandled: number;
};

export async function readSchedulerMetrics(): Promise<SchedulerMetrics | null> {
  const rpc = await userRpc('crm');
  const { data, error } = await rpc('p1o_scheduler_metrics', {});
  if (error) unreadable('readSchedulerMetrics', error);
  const r = firstRow(data);
  if (!r) return null;
  const f = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    requests: whole(r.requests), calls: whole(r.calls), videoMeetings: whole(r.video_meetings), inPerson: whole(r.in_person), otherMode: whole(r.other_mode), bookedEver: whole(r.booked_ever),
    bookingRate: f(r.booking_rate), medianHoursRequestToBooking: f(r.median_hours_request_to_booking), rescheduled: whole(r.rescheduled), cancelled: whole(r.cancelled),
    completed: whole(r.completed), noShow: whole(r.no_show), rescheduleRate: f(r.reschedule_rate), cancelRate: f(r.cancel_rate), noShowRate: f(r.no_show_rate),
    proposalsExpired: whole(r.proposals_expired), flagsOpen: whole(r.flags_open), flagsHandled: whole(r.flags_handled),
  };
}

const SAY: Record<string, string> = {
  forbidden: 'Only an administrator of this organisation can do that.',
  refused: 'The policy was not accepted: check the hours (end after start), the zone, and that enforcement has hours to enforce.',
  bad_policy: 'The policy could not be read.',
  missing_note: 'A note is required.',
  already_handled: 'That flag was already handled.',
  unknown_flag: 'That flag no longer exists.',
};

export type PolicyPatch = {
  timezone?: string;
  working_hours?: Record<string, Array<{ start: string; end: string }>> | null;
  earliest_local_time?: string | null;
  latest_local_time?: string | null;
  min_notice_minutes?: number;
  buffer_minutes?: number;
  durations?: number[];
  proposal_ttl_hours?: number;
  enforce_working_hours?: boolean;
};

export async function saveSchedulingPolicy(patch: PolicyPatch): Promise<Result<string>> {
  const context = await requireInternal();
  if (!can(context, 'organization.settings') || !context.organizationId) return err('FORBIDDEN', 'Only an owner or ops admin can change the scheduling policy.');
  const rpc = await userRpc('crm');
  const { data, error } = await rpc('p1o_set_scheduling_policy', { p_organization_id: context.organizationId, p_policy: patch });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'saveSchedulingPolicy', detail: error.message }));
    return err('INTERNAL', 'Could not save the policy.');
  }
  const outcome = String(firstRow(data)?.outcome ?? '');
  return outcome === 'set' ? ok('Saved. It applies to the next offer and booking.') : err(outcome === 'forbidden' ? 'FORBIDDEN' : 'VALIDATION', SAY[outcome] ?? 'The database refused that.');
}

export async function handleMeetingFlag(flagId: string, note: string): Promise<Result<string>> {
  const context = await requireInternal();
  if (!can(context, 'lead.write')) return err('FORBIDDEN', 'Your role cannot handle a scheduling flag.');
  const rpc = await userRpc('crm');
  const { data, error } = await rpc('p1o_handle_meeting_flag', { p_flag_id: flagId, p_note: note });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'handleMeetingFlag', detail: error.message }));
    return err('INTERNAL', 'Could not record that.');
  }
  const outcome = String(firstRow(data)?.outcome ?? '');
  return outcome === 'handled' ? ok('Marked handled. The meeting itself is unchanged: use its own controls to move or cancel it.') : err('VALIDATION', SAY[outcome] ?? 'The database refused that.');
}
