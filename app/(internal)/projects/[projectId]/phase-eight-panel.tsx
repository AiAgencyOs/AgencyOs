import { readPhaseEight, type CheckInRow, type Member, type OpportunityRow, type PhaseEightView, type PlanRow, type RecoveryPlanRow, type ReplyDraftRow, type TicketRow } from '@/modules/projects/phase-eight-queries';
import { Badge, Card, humanize, type Tone } from '@/ui';

import { DoorForm, type DoorField } from './phase-eight-forms';

/**
 * Phase 8 (post-launch): Customer Success, Support, Upsell and the Sales handoff, for the Admin. INTERNAL: every table behind it is internal-only by
 * policy, so a client sees none of this (a client sees ticket STATUS through projects.client_support_tickets, in the client's words, elsewhere).
 *
 * It renders STORED state or what a database function derives, and never computes a verdict: health comes from customer_health_status with its signals,
 * SLA states from the queue function, eligibility from the eligibility function. Every form calls a door that checks the role and the rules, and its
 * refusal is shown as written. Nothing here sends a message to a client, quotes, prices or discounts: a reply is a draft a person sends elsewhere and
 * then records; an opportunity is handed to Sales, who quote through the existing quotation doors.
 */

const HEALTH_TONE: Record<string, Tone> = { healthy: 'success', stable: 'info', watch: 'warning', at_risk: 'danger', critical: 'danger' };
const LEVEL_TONE: Record<string, Tone> = { ok: 'success', info: 'neutral', watch: 'warning', at_risk: 'danger', critical: 'danger' };
const SLA_TONE: Record<string, Tone> = { running: 'info', met: 'success', met_late: 'warning', breached: 'danger', not_started: 'neutral', not_applicable: 'neutral' };
const TICKET_TONE: Record<string, Tone> = { new: 'warning', classified: 'info', assigned: 'info', in_progress: 'info', in_qa: 'info', release: 'info', client_confirmation: 'warning', closed: 'success', cancelled: 'neutral' };
const OPP_TONE: Record<string, Tone> = { detected: 'info', qualified: 'brand', suppressed: 'warning', handed_off: 'accent', accepted: 'success', lost: 'neutral', closed_no_action: 'neutral' };

const CLASSIFICATIONS: [string, string][] = [
  ['how_to', 'How-to (answer it)'], ['warranty_bug', 'Warranty bug'], ['maintenance', 'Maintenance'], ['minor_change', 'Minor change'], ['change_request', 'Change request (new scope)'], ['new_project', 'New project'], ['disputed', 'Unclear / disputed'],
];
const COVERAGES: [string, string][] = [
  ['included_support', 'Included support'], ['covered_warranty', 'Covered by warranty'], ['covered_maintenance', 'Covered by maintenance plan'], ['not_covered', 'Not covered'], ['needs_review', 'Needs review'],
];
const PRIORITIES: [string, string][] = [['p1', 'P1 urgent'], ['p2', 'P2 high'], ['p3', 'P3 normal'], ['p4', 'P4 low']];
const CHANNELS: [string, string][] = [['whatsapp', 'WhatsApp'], ['email', 'Email'], ['portal', 'Portal'], ['phone', 'Phone']];
const SOURCES: [string, string][] = [['whatsapp', 'WhatsApp'], ['email', 'Email'], ['portal', 'Portal'], ['phone', 'Phone'], ['monitoring', 'Monitoring'], ['internal', 'Internal']];

const memberOptions = (members: Member[]): [string, string][] => members.map((m) => [m.userId, `${m.label} (${humanize(m.role)})`]);
const when = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'n/a');

export async function PhaseEightPanel({ projectId }: { projectId: string }) {
  const view = await readPhaseEight(projectId);
  if (!view) return null;
  if (!view.workspace && view.project.status !== 'completed') return null;
  return view.workspace ? <Workspace view={view} projectId={projectId} /> : <Entry view={view} projectId={projectId} />;
}

function Entry({ view, projectId }: { view: PhaseEightView; projectId: string }) {
  const { intake } = view;
  const warrantyFields: DoorField[] = [
    { kind: 'date', name: 'warrantyStartsOn', label: 'Warranty starts' },
    { kind: 'date', name: 'warrantyEndsOn', label: 'Warranty ends' },
    { kind: 'textarea', name: 'warrantyCoverage', label: 'What the warranty covers' },
    { kind: 'textarea', name: 'warrantyExclusions', label: 'What it excludes' },
    { kind: 'text', name: 'noWarrantyReason', label: 'OR: there is no warranty, because' },
    { kind: 'select', name: 'owner', label: 'Customer Success owner', options: memberOptions(view.members) },
  ];
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-foreground">Phase 8: Customer Success</span>
        <Badge tone={intake?.status === 'ready' ? 'success' : 'warning'}>{intake ? (intake.status === 'ready' ? 'Intake ready' : 'Intake has blockers') : 'No intake yet'}</Badge>
      </div>
      <p className="text-xs text-muted">
        The project is completed. Phase 8 starts from an intake that reads the completion facts (today the completion record; Phase 7&apos;s snapshot replaces the reader later). Completed
        work stays closed: new work is maintenance, a change request or a new project.
      </p>
      {intake ? (
        <ul className="flex flex-col gap-1" aria-label="Start gates">
          {intake.gates.map((g) => (
            <li key={g.id} className="flex flex-wrap items-center gap-2 text-[13px]">
              <Badge tone={g.passed ? (g.waived ? 'warning' : 'success') : g.at === 'start' ? 'neutral' : 'danger'}>{g.passed ? (g.waived ? 'Waived' : 'Pass') : g.at === 'start' ? 'At start' : 'Blocked'}</Badge>
              <span>
                {g.id}: {g.label}. <span className="text-muted">{g.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="grid gap-3 md:grid-cols-2">
        <DoorForm door="refresh_intake" projectId={projectId} submit="Refresh the intake" intro="Reads the completion record, handover, release verification, scope and invoices again." />
        {intake && intake.blockers.length > 0 ? (
          <DoorForm
            door="waive_gate"
            projectId={projectId}
            submit="Waive a gate (owner)"
            intro="An owner-approved exception, with a reason, recorded and shown as waived. Completion and warranty cannot be waived."
            fields={[
              { kind: 'select', name: 'gateId', label: 'Gate', options: intake.blockers.filter((b) => b.id !== 'P8-GATE-001').map((b) => [b.id, `${b.id}: ${b.detail}`]) },
              { kind: 'textarea', name: 'reason', label: 'Reason (at least ten characters)', required: true },
            ]}
          />
        ) : null}
      </div>
      {intake?.status === 'ready' ? (
        <DoorForm door="start" projectId={projectId} tone="primary" submit="Start Phase 8" intro="Define the warranty window with its coverage and exclusions, or record that there is none." fields={warrantyFields} />
      ) : null}
    </Card>
  );
}

function Workspace({ view, projectId }: { view: PhaseEightView; projectId: string }) {
  const w = view.workspace!;
  const owner = view.members.find((m) => m.userId === w.csOwner)?.label ?? w.csOwner ?? 'unassigned';
  return (
    <div className="flex flex-col gap-4" aria-label="Phase 8 Customer Success">
      <Card className="flex flex-col gap-2 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium text-foreground">Phase 8: Customer Success</span>
          <Badge tone={w.state === 'active' ? 'success' : w.state === 'paused' ? 'warning' : 'neutral'}>{humanize(w.state)}</Badge>
        </div>
        <p className="text-xs text-muted">
          Owner: {owner}. {w.warrantyStartsOn && w.warrantyEndsOn ? `Warranty ${w.warrantyStartsOn} to ${w.warrantyEndsOn}. Covers: ${w.warrantyCoverage}. Excludes: ${w.warrantyExclusions}.` : `No warranty: ${w.noWarrantyReason}.`}
          {w.stateReason ? ` State reason: ${w.stateReason}.` : ''}
        </p>
        <details>
          <summary className="cursor-pointer text-[13px] text-muted">Pause, resume or close the workspace (admin)</summary>
          <DoorForm
            door="set_state"
            projectId={projectId}
            submit="Set the state"
            intro="Paused: sweeps and check-ins stop; tickets can still be recorded."
            fields={[{ kind: 'select', name: 'state', label: 'State', options: [['active', 'Active'], ['paused', 'Paused'], ['closed', 'Closed (final)']] }, { kind: 'text', name: 'reason', label: 'Reason' }]}
          />
        </details>
      </Card>
      <Health view={view} projectId={projectId} />
      <Support view={view} projectId={projectId} />
      <CheckIns checkIns={view.checkIns} eligibility={view.eligibility} projectId={projectId} />
      <Plans plans={view.plans} />
      <Opportunities opportunities={view.opportunities} tickets={view.tickets} projectId={projectId} />
      <Card className="p-4">
        <details>
          <summary className="cursor-pointer text-sm font-medium text-foreground">Thresholds (owner or ops admin)</summary>
          <p className="my-2 text-xs text-muted">Defaults apply until set: SLA hours per priority, health thresholds, renewal window and the check-in gap. They are a starting point to confirm, not a business rule.</p>
          <DoorForm
            door="set_setting"
            projectId={projectId}
            submit="Save the value"
            fields={[
              {
                kind: 'select',
                name: 'key',
                label: 'Setting',
                options: [
                  ...['p1', 'p2', 'p3', 'p4'].map((p): [string, string] => [`sla_response_hours_${p}`, `SLA response hours, ${p.toUpperCase()} (default ${{ p1: 4, p2: 8, p3: 24, p4: 72 }[p]})`]),
                  ...['p1', 'p2', 'p3', 'p4'].map((p): [string, string] => [`sla_resolution_hours_${p}`, `SLA resolution hours, ${p.toUpperCase()} (default ${{ p1: 24, p2: 72, p3: 168, p4: 336 }[p]})`]),
                  ['health_open_tickets_watch', 'Open tickets for WATCH (default 3)'], ['health_open_tickets_at_risk', 'Open tickets for AT RISK (default 6)'],
                  ['health_sla_breaches_at_risk', 'SLA breaches in 90 days for AT RISK (default 2)'], ['health_overdue_invoices_at_risk', 'Overdue invoices for AT RISK (default 1)'],
                  ['renewal_window_days', 'Renewal window, days (default 45)'], ['checkin_post_handover_days', 'First check-in after, days (default 7)'], ['checkin_min_gap_days', 'Minimum gap between check-ins, days (default 14)'],
                ],
              },
              { kind: 'number', name: 'value', label: 'Value', required: true },
            ]}
          />
        </details>
      </Card>
    </div>
  );
}

function Health({ view, projectId }: { view: PhaseEightView; projectId: string }) {
  const { health, snapshots, recovery } = view;
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-foreground">Customer health (derived on every read)</span>
        {health ? <Badge tone={HEALTH_TONE[health.status] ?? 'neutral'}>{humanize(health.status)}</Badge> : <Badge tone="neutral">No signals</Badge>}
      </div>
      <p className="text-xs text-muted">There is no score and nothing to type a status into. Each signal below is read from tickets, SLA stamps, invoices, defects and plans; silence is never scored.</p>
      {health ? (
        <ul className="flex flex-col gap-1" aria-label="Health signals">
          {health.signals.map((s) => (
            <li key={s.signal} className="flex flex-wrap items-center gap-2 text-[13px]">
              <Badge tone={LEVEL_TONE[s.level] ?? 'neutral'}>{humanize(s.level)}</Badge>
              <span>
                {humanize(s.signal)}: {s.value}. <span className="text-muted">{s.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {snapshots.length > 0 ? (
        <p className="text-xs text-muted">
          History: {snapshots.map((s) => `${when(s.computedAt)} ${humanize(s.status)}${s.previousStatus ? ` (from ${humanize(s.previousStatus)})` : ''}`).join('; ')}
        </p>
      ) : null}
      <DoorForm door="snapshot" projectId={projectId} submit="Record a health snapshot now" />
      {recovery.map((r) => (
        <RecoveryCard key={r.id} plan={r} members={view.members} projectId={projectId} />
      ))}
    </Card>
  );
}

function RecoveryCard({ plan, members, projectId }: { plan: RecoveryPlanRow; members: Member[]; projectId: string }) {
  const live = plan.status === 'open' || plan.status === 'in_progress';
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line p-3">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <Badge tone={live ? 'warning' : plan.status === 'resolved' ? 'success' : 'neutral'}>Recovery plan: {humanize(plan.status)}</Badge>
        {plan.deadline ? <span>Deadline {plan.deadline}</span> : null}
      </div>
      {plan.rootCause ? <p className="text-[13px]">Root cause: {plan.rootCause}. Actions: {plan.actions}.</p> : <p className="text-[13px] text-muted">Needs an owner, a root cause, actions and a deadline. Normal upsell is suppressed until it is resolved.</p>}
      {plan.outcome ? <p className="text-[13px]">Outcome: {plan.outcome}</p> : null}
      {live ? (
        <div className="grid gap-2 md:grid-cols-3">
          <DoorForm
            door="recovery_update"
            projectId={projectId}
            hidden={{ planId: plan.id }}
            submit="Save the plan"
            fields={[
              { kind: 'select', name: 'owner', label: 'Owner', options: memberOptions(members) },
              { kind: 'textarea', name: 'rootCause', label: 'Root cause', required: true, defaultValue: plan.rootCause ?? '' },
              { kind: 'textarea', name: 'actions', label: 'Actions', required: true, defaultValue: plan.actions ?? '' },
              { kind: 'date', name: 'deadline', label: 'Deadline', required: true, defaultValue: plan.deadline ?? '' },
            ]}
          />
          {plan.status === 'in_progress' ? (
            <DoorForm door="recovery_resolve" projectId={projectId} hidden={{ planId: plan.id }} submit="Resolve on a fresh read" intro="Takes a new health read and refuses while the account is still at risk or critical." fields={[{ kind: 'textarea', name: 'outcome', label: 'Outcome', required: true }]} />
          ) : null}
          <DoorForm door="recovery_abandon" projectId={projectId} hidden={{ planId: plan.id }} submit="Close without recovery (admin)" fields={[{ kind: 'textarea', name: 'reason', label: 'Reason', required: true }]} />
        </div>
      ) : null}
    </div>
  );
}

function Support({ view, projectId }: { view: PhaseEightView; projectId: string }) {
  const draftsByTicket = new Map<string, ReplyDraftRow[]>();
  for (const d of view.drafts) draftsByTicket.set(d.ticketId, [...(draftsByTicket.get(d.ticketId) ?? []), d]);
  return (
    <Card className="flex flex-col gap-3 p-4">
      <span className="text-sm font-medium text-foreground">Support tickets</span>
      <p className="text-xs text-muted">A ticket is classified and covered by a person; clocks run from when it was raised. A technical ticket closes only after QA, any release, and a client confirmation you record with evidence.</p>
      {view.tickets.length === 0 ? <p className="text-[13px] text-muted">No tickets yet.</p> : null}
      {view.tickets.map((t) => (
        <TicketCard key={t.id} ticket={t} drafts={draftsByTicket.get(t.id) ?? []} view={view} projectId={projectId} />
      ))}
      <details>
        <summary className="cursor-pointer text-[13px] text-muted">Record a ticket</summary>
        <DoorForm
          door="open_ticket"
          projectId={projectId}
          submit="Open the ticket"
          intro="Normally tickets arrive from the client's message. Record one here for something that came in by another route."
          fields={[
            { kind: 'text', name: 'title', label: 'Title', required: true },
            { kind: 'textarea', name: 'description', label: 'What the client reported' },
            { kind: 'select', name: 'source', label: 'Where it came from', options: SOURCES },
            { kind: 'text', name: 'sourceRef', label: 'Message id (stops a duplicate)' },
          ]}
        />
      </details>
    </Card>
  );
}

function TicketCard({ ticket: t, drafts, view, projectId }: { ticket: TicketRow; drafts: ReplyDraftRow[]; view: PhaseEightView; projectId: string }) {
  const open = t.status !== 'closed' && t.status !== 'cancelled';
  const hidden = { ticketId: t.id };
  const planOptions: [string, string][] = [['', 'No plan'], ...view.plans.map((p): [string, string] => [p.id, `${p.name} v${p.version} (${humanize(p.status)})`])];
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line p-3">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="font-medium">{t.ref}</span>
        <Badge tone={TICKET_TONE[t.status] ?? 'neutral'}>{humanize(t.status)}</Badge>
        {t.priority ? <Badge tone="neutral">{t.priority.toUpperCase()}</Badge> : null}
        {t.classification ? <Badge tone="info">{humanize(t.classification)}</Badge> : null}
        {t.coverageDecision ? <Badge tone={t.coverageDecision === 'not_covered' ? 'warning' : 'success'}>{humanize(t.coverageDecision)}</Badge> : null}
        {t.escalatedAt ? <Badge tone={t.escalationAckAt ? 'neutral' : 'danger'}>Escalated to {humanize(t.escalatedToRole)}{t.escalationAckAt ? ' (acknowledged)' : ''}</Badge> : null}
      </div>
      <p className="text-[13px]">{t.title}</p>
      {t.coverageReason ? <p className="text-xs text-muted">Coverage reason: {t.coverageReason}</p> : null}
      {t.responseDueAt ? (
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
          Response by {when(t.responseDueAt)} <Badge tone={SLA_TONE[t.responseState] ?? 'neutral'}>{humanize(t.responseState)}</Badge> Resolution by {when(t.resolutionDueAt)}{' '}
          <Badge tone={SLA_TONE[t.resolutionState] ?? 'neutral'}>{humanize(t.resolutionState)}</Badge>
        </p>
      ) : null}
      {t.proposedClassification && t.status === 'new' ? (
        <p className="text-xs text-muted">The Support agent proposed {humanize(t.proposedClassification)}: {t.proposedRationale}. It is a proposal, not a decision.</p>
      ) : null}
      {drafts.map((d) => (
        <div key={d.id} className="flex flex-col gap-1 rounded-md border border-dashed border-line p-2">
          <p className="text-xs text-muted">Draft reply{d.byAgent ? ' by the Support agent' : ''} (nothing was sent):</p>
          <p className="whitespace-pre-wrap text-[13px]">{d.body}</p>
          <div className="grid gap-2 md:grid-cols-2">
            <DoorForm door="reply_sent" projectId={projectId} hidden={{ draftId: d.id }} submit="I sent this: record it" fields={[{ kind: 'select', name: 'channel', label: 'Sent by', options: CHANNELS }]} />
            <DoorForm door="discard_reply" projectId={projectId} hidden={{ draftId: d.id }} submit="Discard the draft" />
          </div>
        </div>
      ))}
      {open ? (
        <details>
          <summary className="cursor-pointer text-[13px] text-muted">Actions</summary>
          <div className="mt-2 grid gap-2 md:grid-cols-2">
            {t.status === 'new' || t.status === 'classified' ? (
              <DoorForm
                door="classify"
                projectId={projectId}
                hidden={hidden}
                submit="Classify and decide coverage"
                intro="Coverage must fit the classification; new scope is never covered."
                fields={[
                  { kind: 'select', name: 'classification', label: 'Classification', options: CLASSIFICATIONS, defaultValue: t.proposedClassification ?? undefined },
                  { kind: 'select', name: 'coverage', label: 'Coverage', options: COVERAGES },
                  { kind: 'select', name: 'planId', label: 'Maintenance plan (for maintenance coverage)', options: planOptions },
                  { kind: 'select', name: 'priority', label: 'Priority', options: PRIORITIES, defaultValue: 'p3' },
                  { kind: 'textarea', name: 'reason', label: 'Why (required)', required: true },
                ]}
              />
            ) : null}
            {t.status !== 'new' ? <DoorForm door="assign" projectId={projectId} hidden={hidden} submit="Assign" fields={[{ kind: 'select', name: 'assignee', label: 'Assignee', options: memberOptions(view.members) }]} /> : null}
            {t.status !== 'new' ? (
              <DoorForm
                door="link"
                projectId={projectId}
                hidden={hidden}
                submit="Link the root cause"
                intro="The defect, change request, maintenance item or opportunity this ticket is about (ids)."
                fields={[
                  { kind: 'text', name: 'defectId', label: 'Defect id' },
                  { kind: 'text', name: 'changeRequestId', label: 'Change request id' },
                  { kind: 'text', name: 'maintenanceItemId', label: 'Maintenance item id' },
                  { kind: 'text', name: 'opportunityId', label: 'Opportunity id' },
                ]}
              />
            ) : null}
            {t.status !== 'new' ? (
              <DoorForm
                door="advance"
                projectId={projectId}
                hidden={hidden}
                submit="Move the ticket on"
                fields={[
                  { kind: 'select', name: 'to', label: 'Move to', options: [['in_progress', 'In progress'], ['in_qa', 'In QA'], ['release', 'Release'], ['client_confirmation', 'Waiting for the client'], ['closed', 'Close'], ['cancelled', 'Cancel']] },
                  { kind: 'textarea', name: 'note', label: 'Note' },
                  { kind: 'text', name: 'evidence', label: 'Evidence (QA, release or knowledge reference)' },
                  { kind: 'check', name: 'releaseNeeded', label: 'A release is needed (when moving to QA)' },
                ]}
              />
            ) : null}
            {t.status === 'client_confirmation' ? (
              <DoorForm
                door="confirm"
                projectId={projectId}
                hidden={hidden}
                submit="Record what the client said"
                intro="Only record what you saw: where and what. Silence is not confirmation."
                fields={[{ kind: 'select', name: 'confirmed', label: 'Outcome', options: [['yes', 'The client confirmed it works'], ['no', 'The client says it is not fixed']] }, { kind: 'textarea', name: 'evidence', label: 'Evidence', required: true }]}
              />
            ) : null}
            <DoorForm door="escalate" projectId={projectId} hidden={hidden} submit="Escalate to a person" fields={[{ kind: 'select', name: 'toRole', label: 'To', options: [['ops_admin', 'Ops admin'], ['owner', 'Owner']] }, { kind: 'textarea', name: 'reason', label: 'Why', required: true }]} />
            {t.escalatedAt && !t.escalationAckAt ? <DoorForm door="acknowledge" projectId={projectId} hidden={hidden} submit="Acknowledge the escalation (admin)" fields={[{ kind: 'text', name: 'note', label: 'Note' }]} /> : null}
            <DoorForm door="draft_reply" projectId={projectId} hidden={hidden} submit="Save a reply draft" intro="A draft only. Send it yourself, then record that you did." fields={[{ kind: 'textarea', name: 'body', label: 'Reply', required: true }, { kind: 'text', name: 'language', label: 'Language code (optional)' }]} />
          </div>
        </details>
      ) : null}
    </div>
  );
}

function CheckIns({ checkIns, eligibility, projectId }: { checkIns: CheckInRow[]; eligibility: { category: string; allowed: boolean; reasons: string[] }[]; projectId: string }) {
  return (
    <Card className="flex flex-col gap-3 p-4">
      <span className="text-sm font-medium text-foreground">Check-ins</span>
      <ul className="flex flex-col gap-1" aria-label="Contact eligibility">
        {eligibility.map((e) => (
          <li key={e.category} className="flex flex-wrap items-center gap-2 text-[13px]">
            <Badge tone={e.allowed ? 'success' : 'warning'}>{humanize(e.category)}: {e.allowed ? 'allowed' : 'held'}</Badge>
            <span className="text-muted">{e.reasons.join('; ')}</span>
          </li>
        ))}
      </ul>
      {checkIns.length === 0 ? <p className="text-[13px] text-muted">No check-ins.</p> : null}
      {checkIns.map((c) => (
        <div key={c.id} className="flex flex-col gap-1 rounded-md border border-line p-2">
          <p className="flex flex-wrap items-center gap-2 text-[13px]">
            <Badge tone={c.status === 'due' ? 'warning' : c.status === 'completed' ? 'success' : 'neutral'}>{humanize(c.status)}</Badge>
            {humanize(c.kind)}, due {c.dueOn}
            {c.engagement ? `, ${humanize(c.engagement)} by ${c.channel}` : ''}
          </p>
          {c.agenda ? <p className="whitespace-pre-wrap text-xs text-muted">Agenda{c.agendaByAgent ? ' (drafted by the Customer Success agent)' : ''}: {c.agenda}</p> : null}
          {c.outcome ? <p className="text-xs">Outcome: {c.outcome}</p> : null}
          {c.status === 'due' ? (
            <div className="grid gap-2 md:grid-cols-2">
              <DoorForm
                door="check_in_complete"
                projectId={projectId}
                hidden={{ checkInId: c.id }}
                submit="Record the check-in"
                intro="Record what happened, by whom you reached them and how. No answer is recorded as no response, which never lowers health."
                fields={[
                  { kind: 'select', name: 'engagement', label: 'Engagement', options: [['responded', 'Responded'], ['no_response', 'No response'], ['declined', 'Declined'], ['not_applicable', 'Not applicable']] },
                  { kind: 'select', name: 'channel', label: 'Channel', options: [['call', 'Call'], ['whatsapp', 'WhatsApp'], ['email', 'Email'], ['portal', 'Portal'], ['meeting', 'Meeting']] },
                  { kind: 'textarea', name: 'outcome', label: 'Outcome (at least ten characters)', required: true },
                ]}
              />
              <DoorForm door="check_in_skip" projectId={projectId} hidden={{ checkInId: c.id }} submit="Skip" fields={[{ kind: 'text', name: 'reason', label: 'Why skip it', required: true }]} />
            </div>
          ) : null}
        </div>
      ))}
      <details>
        <summary className="cursor-pointer text-[13px] text-muted">Add a check-in</summary>
        <DoorForm
          door="check_in_create"
          projectId={projectId}
          submit="Create"
          fields={[
            { kind: 'select', name: 'kind', label: 'Kind', options: [['adoption', 'Adoption'], ['major_release', 'Major release'], ['post_incident', 'Post-incident'], ['scheduled', 'Scheduled'], ['recovery', 'Recovery'], ['renewal', 'Renewal']] },
            { kind: 'text', name: 'periodKey', label: 'Period key (one per kind and period)', required: true },
            { kind: 'date', name: 'dueOn', label: 'Due on', required: true },
            { kind: 'textarea', name: 'agenda', label: 'Agenda' },
          ]}
        />
      </details>
    </Card>
  );
}

function Plans({ plans }: { plans: PlanRow[] }) {
  return (
    <Card className="flex flex-col gap-2 p-4">
      <span className="text-sm font-medium text-foreground">Maintenance plans and renewal</span>
      <p className="text-xs text-muted">The renewal sweep flags a plan inside its window and opens a review; it never renews, extends or re-dates a plan, and nothing is sent. A person proposes the renewal.</p>
      {plans.length === 0 ? <p className="text-[13px] text-muted">No maintenance plan on this project.</p> : null}
      {plans.map((p) => (
        <p key={p.id} className="flex flex-wrap items-center gap-2 text-[13px]">
          <Badge tone={p.status === 'active' || p.status === 'renewed' ? 'success' : p.status === 'renewal_approaching' || p.status === 'at_risk' ? 'warning' : 'neutral'}>{humanize(p.status)}</Badge>
          {p.name} v{p.version}: {p.startsOn ?? '?'} to {p.endsOn ?? 'open'}
        </p>
      ))}
    </Card>
  );
}

function Opportunities({ opportunities, tickets, projectId }: { opportunities: OpportunityRow[]; tickets: TicketRow[]; projectId: string }) {
  const outOfScope = tickets.filter((t) => t.classification === 'change_request' || t.classification === 'new_project');
  return (
    <Card className="flex flex-col gap-3 p-4">
      <span className="text-sm font-medium text-foreground">Expansion opportunities</span>
      <p className="text-xs text-muted">Evidence first. An agent only records; you qualify; handing to Sales opens a deal in discovery with no value. This panel never names a price: Sales quotes through the quotation doors.</p>
      {opportunities.length === 0 ? <p className="text-[13px] text-muted">No opportunities.</p> : null}
      {opportunities.map((o) => (
        <div key={o.id} className="flex flex-col gap-1 rounded-md border border-line p-2">
          <p className="flex flex-wrap items-center gap-2 text-[13px]">
            <Badge tone={OPP_TONE[o.status] ?? 'neutral'}>{humanize(o.status)}</Badge>
            {humanize(o.kind)}, {o.urgency} urgency{o.detectedByAgent ? `, recorded by the ${humanize(o.detectedByAgent)} agent` : ''}
          </p>
          <p className="text-[13px]">{o.need}</p>
          <p className="text-xs text-muted">Evidence: {o.evidence.map((e) => `${humanize(e.type)} ${e.id.slice(0, 8)}`).join(', ')}</p>
          {o.suppressedReason ? <p className="text-xs text-danger">{o.suppressedReason}</p> : null}
          {o.outcomeReason ? <p className="text-xs">Outcome: {o.outcomeReason}</p> : null}
          <div className="grid gap-2 md:grid-cols-3">
            {o.status === 'detected' || o.status === 'suppressed' ? (
              <DoorForm door="opp_qualify" projectId={projectId} hidden={{ opportunityId: o.id }} submit="Decide" fields={[{ kind: 'select', name: 'decision', label: 'Decision', options: [['qualify', 'Qualify'], ['close_no_action', 'Close, no action']] }, { kind: 'textarea', name: 'note', label: 'Note (required)', required: true }]} />
            ) : null}
            {o.status === 'qualified' ? <DoorForm door="opp_handoff" projectId={projectId} hidden={{ opportunityId: o.id }} submit="Hand to Sales" /> : null}
            {o.status === 'handed_off' || o.status === 'qualified' ? (
              <DoorForm
                door="opp_close"
                projectId={projectId}
                hidden={{ opportunityId: o.id }}
                submit="Record the outcome"
                intro="Accepted means a separate change request or project exists: name it."
                fields={[
                  { kind: 'select', name: 'outcome', label: 'Outcome', options: [['accepted', 'Accepted'], ['lost', 'Lost'], ['closed_no_action', 'No action']] },
                  { kind: 'text', name: 'changeRequestId', label: 'Change request id (if accepted as a change request)' },
                  { kind: 'text', name: 'newProjectId', label: 'New project id (if accepted as a new project)' },
                  { kind: 'textarea', name: 'reason', label: 'Reason' },
                ]}
              />
            ) : null}
          </div>
        </div>
      ))}
      <details>
        <summary className="cursor-pointer text-[13px] text-muted">Record an opportunity from evidence</summary>
        <DoorForm
          door="opp_record"
          projectId={projectId}
          submit="Record it"
          intro={outOfScope.length > 0 ? 'Evidence is a ticket you classified as out of scope, a completed check-in or an upsell signal.' : 'Evidence is a ticket you classified as out of scope, a completed check-in or an upsell signal. None exists yet on this project.'}
          fields={[
            { kind: 'select', name: 'kind', label: 'Kind', options: [['change_request', 'Material addition to this product'], ['new_project', 'A separate module, platform or project']] },
            { kind: 'textarea', name: 'need', label: 'The client need, in facts (no price)', required: true },
            { kind: 'select', name: 'evidenceType', label: 'Evidence type', options: [['ticket', 'Ticket'], ['check_in', 'Completed check-in'], ['upsell_signal', 'Upsell signal']] },
            { kind: 'text', name: 'evidenceId', label: 'Evidence record id', required: true, defaultValue: outOfScope[0]?.id ?? '' },
            { kind: 'text', name: 'requestedOutcome', label: 'Requested outcome' },
            { kind: 'select', name: 'urgency', label: 'Urgency', options: [['low', 'Low'], ['normal', 'Normal'], ['high', 'High']], defaultValue: 'normal' },
            { kind: 'text', name: 'stakeholders', label: 'Stakeholders' },
            { kind: 'text', name: 'constraints', label: 'Constraints' },
          ]}
        />
      </details>
    </Card>
  );
}
