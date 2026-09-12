import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { agencyClock, clockFor, getAgencyTimeZone } from '@/lib/admin/agency-clock';
import { readAuditLog } from '@/lib/audit/queries';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import {
  analysisState,
  availabilityState,
  blockedControls,
  completionState,
  evidenceTone,
  pickNewest,
  providerState,
  reminderState,
  timezonePair,
  whenOf,
} from '@/modules/crm/meetings-view';
import {
  getMeeting,
  listMeetingChain,
  listMeetingEvidence,
  listMeetingJobs,
  listRequirementVersions,
} from '@/modules/crm/queries';
import { requirementPayloadSchema, type MeetingStatus } from '@/modules/crm/schema';
import { Badge, Callout, Card, CardBody, CardHeader, IconArrowLeft, IconLock, StatusBadge, cx, humanize } from '@/ui';

export const metadata: Metadata = { title: 'Meeting' };

/**
 * A09 — the meeting record and its evidence (Admin Panel Blueprint p6–7).
 *
 * Eight things the Blueprint lists, each from the row that holds it, and
 * two rules: "Time passing alone does not mean completion" (held at the row
 * by `meetings_completion_is_authorized`, and never inferred here) and
 * "Evidence access is role-controlled" (every internal role may read the
 * rows today; the audit trail is the one section that is not, and it says
 * so rather than showing an empty list).
 *
 * Read-only. Every control the Blueprint asks for is rendered BLOCKED with
 * the missing command or blocker named (§8, §11), because no command exists
 * yet and a Server Action writing `crm.meetings` directly is the shortcut §7
 * forbids.
 */

const Said = ({ text, tone }: { text: string; tone: string }) => (
  <p className={cx('text-[13px] leading-relaxed', tone === 'warning' ? 'text-warning' : tone === 'danger' ? 'text-danger' : tone === 'success' ? 'text-success' : 'text-muted')}>
    {text}
  </p>
);

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
    <dt className="w-40 shrink-0 text-[12px] font-medium text-faint">{label}</dt>
    <dd className="min-w-0 text-[13px]">{children}</dd>
  </div>
);

export default async function MeetingPage({ params }: { params: Promise<{ meetingId: string }> }) {
  const { meetingId } = await params;
  const context = await requireInternal(`/meetings/${meetingId}`);
  if (!can(context.role, 'lead.read')) redirect('/dashboard');

  const m = await getMeeting(meetingId);
  if (!m) notFound();

  const [evidence, jobs, chain, versions] = await Promise.all([
    listMeetingEvidence(m.id),
    listMeetingJobs(m.id),
    listMeetingChain(m.supersedes_id),
    m.conversation_id ? listRequirementVersions(m.conversation_id) : Promise.resolve([]),
  ]);
  const mayReadAudit = can(context.role, 'audit.read');
  const audit = mayReadAudit ? await readAuditLog({ subjectId: m.id, limit: 20 }) : [];

  const now = new Date();
  const agencyZone = await getAgencyTimeZone();
  const agencyClockNow = await agencyClock();
  const zones = timezonePair(m.timezone, agencyZone);
  const local = clockFor(zones.primary);
  const when = whenOf(m);
  const reminderJob = pickNewest(jobs.filter((j) => j.kind === 'meeting.reminder'));
  const analysisJob = pickNewest(jobs.filter((j) => j.kind === 'meeting.analysis'));
  const controls = blockedControls(m.status as MeetingStatus);
  const provider = providerState(m);
  const availability = availabilityState(m);
  const completion = completionState(m, now);
  const reminder = reminderState(reminderJob, m);
  const analysis = analysisState(analysisJob, m, evidence.length);

  const at = (iso: string | null | undefined) => (iso ? `${local.dateTime(iso)} ${zones.primary}` : '—');

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex items-center gap-2 text-[13px] text-muted">
        <Link href="/meetings" className="flex items-center gap-1.5 hover:text-foreground">
          <IconArrowLeft size={15} />
          Meetings
        </Link>
        <span className="text-faint">/</span>
        <span className="truncate font-medium text-foreground">{m.contact?.full_name ?? m.lead?.title ?? 'Meeting'}</span>
      </div>

      <Card>
        <CardHeader
          title={m.contact?.full_name ?? m.lead?.title ?? 'Meeting'}
          description={m.purpose ?? 'No purpose recorded'}
          actions={
            <>
              <StatusBadge status={m.status} />
              <Badge tone="neutral">{humanize(m.booked_mode ?? m.requested_mode)}{m.booked_mode ? '' : ' (requested)'}</Badge>
            </>
          }
        />
        <CardBody>
          <dl className="flex flex-col gap-2">
            <Row label="Lead">
              {m.lead ? (
                <Link href={`/leads/${m.lead_id}`} className="underline underline-offset-2 hover:text-foreground">
                  {m.lead.title}
                </Link>
              ) : (
                'Lead not readable'
              )}
              {m.lead?.assigned_to ? <span className="ml-2 text-muted">lead owner {m.lead.assigned_to.slice(0, 8)}</span> : <span className="ml-2 text-faint">no lead owner recorded</span>}
            </Row>
            <Row label="Requested">
              {m.requested_start_at ? `${at(m.requested_start_at)}${m.requested_window_end ? ` – ${local.clock(m.requested_window_end)}` : ''}` : 'No time requested'} · {humanize(m.requested_mode)}
            </Row>
            <Row label="Agreed">
              {when.kind === 'confirmed' ? (
                <>
                  <span className="tabular">{at(when.start)}{when.end ? ` – ${local.clock(when.end)}` : ''}</span>
                  {zones.secondary ? <span className="ml-2 text-faint">= {clockFor(zones.secondary).dateTime(when.start)} {zones.secondary}</span> : null}
                  {m.booked_mode ? <span className="ml-2 text-muted">· {humanize(m.booked_mode)}</span> : null}
                </>
              ) : (
                <span className="text-muted">Nothing agreed yet — a proposal and a confirmation are separate facts (§6.2)</span>
              )}
            </Row>
            <Row label="Timezone">
              <span className="font-mono text-[12px]">{zones.primary}</span>
              {zones.unrecognised !== null ? (
                <Badge tone="danger" dot className="ml-2">the row's zone “{zones.unrecognised}” is not recognised — times shown in the agency's</Badge>
              ) : zones.secondary ? <span className="ml-2 text-faint">agency: <span className="font-mono text-[12px]">{zones.secondary}</span></span> : <span className="ml-2 text-faint">(the agency&rsquo;s own)</span>}
            </Row>
            {m.duration_minutes ? <Row label="Duration">{m.duration_minutes} minutes</Row> : null}
          </dl>
        </CardBody>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Scheduling" description="Provider event, availability, and the booking that made it" />
          <CardBody className="flex flex-col gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-faint">Provider event / link</p>
              <Said {...provider} />
              {m.meeting_url ? (
                <a href={m.meeting_url} target="_blank" rel="noreferrer" className="text-[13px] underline underline-offset-2">Meeting link</a>
              ) : null}
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-faint">Availability</p>
              <Said {...availability} />
            </div>
            <dl className="flex flex-col gap-1.5">
              <Row label="Booked at">{at(m.booked_at)}</Row>
              <Row label="Booking key">{m.booking_key ? <span className="font-mono text-[12px]">{m.booking_key}</span> : 'none — never booked'}</Row>
            </dl>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Completion" description="From the row only. A clock does not conclude a meeting happened." />
          <CardBody className="flex flex-col gap-3">
            <Said {...completion} />
            {m.cancelled_at ? (
              <Callout tone="info">Cancelled {at(m.cancelled_at)}{m.cancellation_reason ? ` — ${m.cancellation_reason}` : ' — no reason recorded'}</Callout>
            ) : null}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Controls"
          icon={<IconLock size={15} />}
          description="Rendered, not hidden: a hidden control is not enforcement (Blueprint §11). Each is blocked, and says on what."
        />
        <CardBody>
          {controls.length === 0 ? (
            <p className="text-[13px] text-muted">This meeting is settled; nothing more can happen to it.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {controls.map((c) => (
                <li key={`${c.action}-${c.target ?? 'none'}`} className="flex flex-col gap-0.5 rounded-lg border border-dashed border-line-strong px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium">{c.action}</span>
                    <Badge tone="warning" dot>Blocked</Badge>
                  </div>
                  <p className="text-[12.5px] text-muted">{c.reason}. Owner: {c.owner}.</p>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Reminders" description="core.jobs rows that name this meeting" />
          <CardBody className="flex flex-col gap-2">
            <Said {...reminder} />
            {jobs.filter((j) => j.kind === 'meeting.reminder').map((j) => (
              <p key={j.id} className="font-mono text-[11.5px] text-faint">
                {j.status} · run at {j.run_at ? `${local.dateTime(j.run_at)} ${zones.primary}` : '—'} · {j.attempts} attempt{j.attempts === 1 ? '' : 's'}
              </p>
            ))}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="AI analysis" description="Never a summary here. Any output would be inference, born proposed (G-229)." />
          <CardBody>
            <Said {...analysis} />
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Evidence"
          actions={<Badge tone="neutral">{evidence.length}</Badge>}
          description="References, never links: no store has been chosen to sign one (G-229 §9.2)."
        />
        <CardBody className="flex flex-col gap-3">
          {evidence.length === 0 ? (
            <p className="text-[13px] text-muted">No evidence is attached.</p>
          ) : (
            <ol className="flex flex-col divide-y divide-line">
              {evidence.map((e) => (
                <li key={e.id} className="flex flex-col gap-1 py-2 first:pt-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge mono>{e.kind}</Badge>
                    <Badge tone={evidenceTone(e.visibility)}>{humanize(e.visibility)}</Badge>
                    {e.media_type ? <span className="text-[11px] text-faint">{e.media_type}</span> : null}
                    {e.byte_size !== null ? <span className="text-[11px] text-faint">{Math.round(e.byte_size / 1024)} KB</span> : null}
                    <span className="ml-auto text-[11px] text-faint">
                      {agencyClockNow.dateTime(e.uploaded_at)} · by {e.uploaded_by ? e.uploaded_by.slice(0, 8) : 'unnamed'}
                    </span>
                  </div>
                  {e.artifact_ref ? <p className="font-mono text-[11.5px] text-muted">reference recorded: {e.artifact_ref}</p> : null}
                  {e.body ? <p className="text-[13px] leading-relaxed">{e.body}</p> : null}
                </li>
              ))}
            </ol>
          )}
        </CardBody>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="History" description="A reschedule mints a new row; the earlier ones are the chain (§8)." />
          <CardBody>
            {chain.links.length === 0 ? (
              <p className="text-[13px] text-muted">No earlier booking — this row was not rescheduled from another.</p>
            ) : (
              <ol className="flex flex-col gap-1.5">
                {chain.links.map((link) => (
                  <li key={link.id} className="text-[13px]">
                    <Link href={`/meetings/${link.id}`} className="underline underline-offset-2">{link.id.slice(0, 8)}</Link>
                    <span className="ml-2"><StatusBadge status={link.status} dot={false} /></span>
                    <span className="ml-2 text-muted">{at(link.confirmed_start_at ?? link.requested_start_at)}</span>
                    {link.cancellation_reason ? <span className="ml-2 text-faint">— {link.cancellation_reason}</span> : null}
                  </li>
                ))}
                {chain.truncated ? <li className="text-[12px] text-faint">…and earlier rows beyond the ten shown.</li> : null}
              </ol>
            )}
            <p className="mt-3 text-[12px] text-faint">Only <code className="font-mono">meeting.booked</code> is audited today; cancellation and completion leave no audit row yet.</p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Known requirements" description="Versions extracted from the thread this meeting belongs to" />
          <CardBody>
            {!m.conversation_id ? (
              <p className="text-[13px] text-muted">This meeting is not linked to a conversation, so no requirements are known through it.</p>
            ) : versions.length === 0 ? (
              <p className="text-[13px] text-muted">No requirement version has been recorded for this thread.</p>
            ) : (
              <ol className="flex flex-col gap-1.5">
                {versions.map((v) => {
                  const parsed = requirementPayloadSchema.safeParse(v.payload);
                  return (
                    <li key={v.id} className="text-[13px]">
                      <span className="mr-1.5 font-mono text-xs">v{v.version}</span>
                      <StatusBadge status={v.status} dot={false} />
                      {parsed.success ? <span className="ml-2 text-muted">{parsed.data.summary}</span> : null}
                    </li>
                  );
                })}
              </ol>
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="Audit" description="What the audit log holds for this meeting" />
        <CardBody>
          {!mayReadAudit ? (
            <p className="text-[13px] text-muted">Audit entries are visible to the owner and ops admins. Your role can read this meeting but not its audit trail.</p>
          ) : audit.length === 0 ? (
            <p className="text-[13px] text-muted">No audit entry names this meeting.</p>
          ) : (
            <ol className="flex flex-col gap-1">
              {audit.map((entry) => (
                <li key={entry.id} className="text-[13px]">
                  <Badge mono>{entry.action}</Badge>
                  <span className="ml-2 text-faint">{agencyClockNow.dateTime(entry.createdAt)}</span>
                </li>
              ))}
            </ol>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
