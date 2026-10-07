import type { createAdminClient } from '@/lib/db/admin';
import type { ProviderEventAnswer } from '@/lib/scheduling/google';

import type { HandlerResult } from './handlers';

/**
 * Round 4, Scheduler: the provider-to-AgencyOS reconcile (P1-SCHED-041). For each booked meeting that has a provider event and has not been looked at lately, ask
 * the calendar what it says and record the comparison (`crm.p1r_record_provider_check`). Equal: in sync. Different, cancelled or gone: a provider_conflict flag
 * for a person; NOTHING is changed on either side. An unreadable provider is recorded as unreadable, not as a conflict and not as in sync.
 *
 * No calendar configured is an honest environment_missing: the job reports it and records nothing, never a fabricated "in sync". The calendar is a port so a
 * test proves the comparison without Google.
 */
type Admin = ReturnType<typeof createAdminClient>;
type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

export type EventReader = { getEvent(eventId: string): Promise<ProviderEventAnswer> };

export type ReconcileOutcome =
  | { status: 'environment_missing'; detail: string }
  | { status: 'failed'; detail: string }
  | { status: 'done'; checked: number; inSync: number; conflicts: number; unreadable: number };

const rows = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? (v as Array<Record<string, unknown>>) : []);

export async function reconcileProviderEvents(admin: Admin, organizationId: string, resolveCalendar: () => Promise<EventReader | null>, options: { limit?: number } = {}): Promise<ReconcileOutcome> {
  const rpc = (fn: string, args: Record<string, unknown>) => (admin.schema('crm' as never) as unknown as { rpc: Rpc }).rpc(fn, args);

  const due = await rpc('p1r_meetings_to_reconcile', { p_organization_id: organizationId, p_limit: options.limit ?? 20 });
  if (due.error) return { status: 'failed', detail: `could not list the meetings to compare: ${due.error.message}` };

  const out = { checked: 0, inSync: 0, conflicts: 0, unreadable: 0 };
  const list = rows(due.data);
  // The calendar is only resolved when there is something to compare: an idle organisation costs one read and no provider call.
  if (list.length === 0) return { status: 'done', ...out };
  const calendar = await resolveCalendar().catch(() => null);
  if (!calendar) return { status: 'environment_missing', detail: 'no calendar is configured, so nothing was compared with the provider' };
  for (const m of list) {
    const meetingId = String(m.meeting_id);
    const answer = await calendar.getEvent(String(m.provider_event_id)).catch((e: unknown): ProviderEventAnswer => ({ ok: false, permanent: false, message: e instanceof Error ? e.message : 'the provider read threw' }));
    const args: Record<string, unknown> = answer.ok
      ? { p_meeting_id: meetingId, p_provider_state: answer.state, ...(answer.state === 'confirmed' ? { p_provider_start: answer.startAt, p_provider_end: answer.endAt } : {}) }
      : { p_meeting_id: meetingId, p_provider_state: 'unreadable', p_detail: answer.message.slice(0, 500) };
    const recorded = await rpc('p1r_record_provider_check', args);
    if (recorded.error) return { status: 'failed', detail: `could not record the comparison for meeting ${meetingId}: ${recorded.error.message}` };
    const outcome = String(rows(recorded.data)[0]?.outcome ?? '');
    out.checked += 1;
    if (outcome === 'in_sync') out.inSync += 1;
    else if (outcome === 'conflict_flagged') out.conflicts += 1;
    else if (outcome === 'unreadable') out.unreadable += 1;
  }
  return { status: 'done', ...out };
}

/** The job result for the tick: a settled success unless the read or the record failed (retryable), and an honest word when there is no calendar. */
export function reconcileResult(o: ReconcileOutcome): HandlerResult {
  if (o.status === 'failed') return { status: 'failed', permanent: false, detail: o.detail };
  if (o.status === 'environment_missing') return { status: 'succeeded', outcome: 'environment_missing', detail: o.detail };
  return { status: 'succeeded', outcome: o.conflicts > 0 ? 'conflicts_flagged' : 'compared', detail: `${o.checked} compared: ${o.inSync} in sync, ${o.conflicts} flagged for a person, ${o.unreadable} unreadable` };
}
