import type { Metadata } from 'next';
import Link from 'next/link';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listOpenMeetingFlags, readSchedulerMetrics } from '@/modules/crm/p1o-scheduling-service';
import { Badge, Card, CardBody, CardHeader, EmptyState, PageHeader, PermissionDenied, buttonClass, type Tone } from '@/ui';

import { HandleFlagForm } from './flag-form';

export const metadata: Metadata = { title: 'Meetings that need a person' };

const LABEL: Record<string, string> = {
  reschedule_request: 'Client wants to move it',
  cancel_request: 'Client wants to cancel',
  availability_question: 'Asks about availability',
  reminder_question: 'Asks about a reminder',
  ambiguous_cancel: 'Which meeting? (cancel)',
  ambiguous_reschedule: 'Which meeting? (move)',
  provider_conflict: 'Calendar and AgencyOS disagree',
  slot_busy: 'The time became busy',
  timezone_ambiguous: 'Timezone unclear',
  needs_escalation: 'Needs a decision',
  proposal_expired: 'Offered times expired',
};
const TONE: Record<string, Tone> = { provider_conflict: 'danger', slot_busy: 'danger', needs_escalation: 'danger', proposal_expired: 'warning' };

const pct = (v: number | null) => (v === null ? 'n/a' : `${Math.round(v * 100)}%`);

/**
 * What the Scheduler hands back to a person (P1-SCHED-006/041/068/069). A client's reschedule or cancel request, an ambiguous request, a conflict with the
 * calendar, an offer that expired: each is a flag here. Nothing on this page moves a meeting; it points to the meeting and records what the person did.
 */
export default async function MeetingAttentionPage() {
  const context = await requireInternal('/meetings/attention');
  if (!can(context, 'lead.read')) return <PermissionDenied />;
  const [flags, metrics] = await Promise.all([listOpenMeetingFlags(), readSchedulerMetrics()]);
  const canHandle = can(context, 'lead.write');

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Meetings that need a person"
        description="The Scheduler flags what it must not decide: a request to move or cancel, a message that fits more than one meeting, an offer that lapsed. Moving or cancelling uses the meeting's own controls."
        actions={
          <>
            <Link href="/meetings" className={buttonClass('secondary', 'sm')}>All meetings</Link>
            <Link href="/meetings/policy" className={buttonClass('secondary', 'sm')}>Scheduling policy</Link>
          </>
        }
      />

      {metrics ? (
        <Card>
          <CardHeader title="Last 30 days" description="Counted from the meeting rows." />
          <CardBody>
            <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <div><dt className="text-muted">Requests</dt><dd className="font-semibold">{metrics.requests} ({metrics.calls} calls, {metrics.videoMeetings} video, {metrics.inPerson} in person)</dd></div>
              <div><dt className="text-muted">Booked</dt><dd className="font-semibold">{metrics.bookedEver} ({pct(metrics.bookingRate)})</dd></div>
              <div><dt className="text-muted">Median hours to book</dt><dd className="font-semibold">{metrics.medianHoursRequestToBooking === null ? 'n/a' : metrics.medianHoursRequestToBooking}</dd></div>
              <div><dt className="text-muted">Rescheduled</dt><dd className="font-semibold">{metrics.rescheduled} ({pct(metrics.rescheduleRate)})</dd></div>
              <div><dt className="text-muted">Cancelled</dt><dd className="font-semibold">{metrics.cancelled} ({pct(metrics.cancelRate)})</dd></div>
              <div><dt className="text-muted">No-show</dt><dd className="font-semibold">{metrics.noShow} ({pct(metrics.noShowRate)})</dd></div>
              <div><dt className="text-muted">Offers that expired</dt><dd className="font-semibold">{metrics.proposalsExpired}</dd></div>
              <div><dt className="text-muted">Flags open / handled</dt><dd className="font-semibold">{metrics.flagsOpen} / {metrics.flagsHandled}</dd></div>
            </dl>
            <p className="mt-3 text-xs text-muted">Reminder delivery, provider failures and calendar sync conflicts are not measured here: delivery receipts of reminders and a sync-back job are not built.</p>
          </CardBody>
        </Card>
      ) : null}

      {flags.length === 0 ? (
        <EmptyState title="Nothing needs a person" description="No request is waiting for an answer." />
      ) : (
        <ul className="flex flex-col gap-3">
          {flags.map((f) => (
            <li key={f.flagId}>
              <Card>
                <CardBody>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={TONE[f.kind] ?? 'info'} dot>{LABEL[f.kind] ?? f.kind}</Badge>
                    <span className="text-xs text-muted">
                      raised {f.ageMinutes < 60 ? `${f.ageMinutes} min` : `${Math.round(f.ageMinutes / 60)} h`} ago · meeting is {f.meetingStatus}
                      {f.confirmedStartAt ? ` · ${new Date(f.confirmedStartAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}` : ''}
                    </span>
                    <Link href={`/meetings/${f.meetingId}`} className="text-sm underline">Open the meeting</Link>
                  </div>
                  <p className="mt-2 text-sm">{f.note}</p>
                  {f.candidateMeetingIds.length > 0 ? (
                    <p className="mt-1 text-xs text-muted">
                      It could mean any of:{' '}
                      {f.candidateMeetingIds.map((id) => (
                        <Link key={id} href={`/meetings/${id}`} className="mr-2 underline">{id.slice(0, 8)}</Link>
                      ))}
                    </p>
                  ) : null}
                  {canHandle ? <div className="mt-3"><HandleFlagForm flagId={f.flagId} /></div> : null}
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
