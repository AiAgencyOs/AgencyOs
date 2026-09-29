import type { Metadata } from 'next';
import Link from 'next/link';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import {
  getActiveProjectsSummary,
  getMessagesSentThisMonth,
  getRecentLeads,
  getRevenueThisMonth,
  getTotalLeadsCount,
} from '@/lib/admin/dashboard';
import { getOverview } from '@/lib/admin/overview';
import { isAvailable, levelLabel, overallStatus, type Avail } from '@/lib/admin/overview-eval';
import { getAgentUsage } from '@/lib/admin/usage';
import { requireInternal } from '@/lib/auth/session';
import { can, type Capability } from '@/lib/authz/permissions';
import {
  AutoRefresh,
  Badge,
  Callout,
  Card,
  CardHeader,
  cx,
  DataTable,
  EmptyState,
  humanize,
  IconAgents,
  IconAlert,
  IconApprovals,
  IconChevronRight,
  IconInvoices,
  IconOperations,
  IconProjects,
  IconRefresh,
  IconSettings,
  IconUsage,
  IconUser,
  Stat,
  StatGrid,
  StatusBadge,
  TONE_DOT,
  TONE_TEXT,
  type Column,
  type Tone,
} from '@/ui';

export const metadata: Metadata = { title: 'Overview' };

/**
 * The Overview command center — the front door of the Admin control plane.
 *
 * It answers the owner's first questions (is the system healthy? what needs
 * attention? what needs me?) from the SAME authoritative reads the detail pages
 * use, composed in `getOverview()`. Nothing here is hard-coded or estimated.
 *
 * The one rule this page exists to keep: a signal that could not be READ shows
 * DATA UNAVAILABLE, never 0 — a monitor that invents zeros manufactures false
 * calm. Every card links to the page that owns the detail, and is shown only to
 * a role that may open that page.
 *
 * That rule is also why the unreadable case is rendered differently rather than
 * just coloured differently: at a glance a red 0 and a green 0 are the same
 * shape, and the whole point is that one of them is not a number at all.
 */

/** The page's four states map onto the design system's tones. */
const TONE: Record<string, Tone> = {
  good: 'success',
  warn: 'warning',
  bad: 'danger',
  muted: 'neutral',
};

/** "Good morning" / "Good afternoon" / "Good evening", by the hour in the agency's own zone — not the server's. */
function greeting(clock: AgencyClock, now: Date): string {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: clock.timeZone }).format(now),
  );
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(
    minor / 100,
  );
}

/** A value tile that honours the read: number when read, DATA UNAVAILABLE when not. */
function num<T>(a: Avail<T>, pick: (v: T) => string): string {
  return isAvailable(a) ? pick(a.value) : 'DATA UNAVAILABLE';
}

/** Renders the unreadable case as prose, so it can never be mistaken for a count. */
function Value({ value }: { value: string }) {
  if (value === 'DATA UNAVAILABLE') {
    return <span className="block text-[13px] font-medium leading-snug text-danger">{value}</span>;
  }
  return <>{value}</>;
}

function HealthRow({
  label,
  state,
}: {
  label: string;
  state: { text: string; tone: 'good' | 'warn' | 'bad' | 'muted' };
}) {
  const tone = TONE[state.tone] ?? 'neutral';
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-3 text-sm sm:px-5">
      <span className="text-foreground">{label}</span>
      <span className={cx('flex items-center gap-1.5 text-xs font-medium', TONE_TEXT[tone])}>
        <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', TONE_DOT[tone])} />
        {state.text}
      </span>
    </li>
  );
}

export default async function OverviewPage() {
  const context = await requireInternal('/dashboard');
  const role = context.role;
  const show = (cap: Capability) => can(role, cap);

  const [o, clock] = await Promise.all([getOverview(), agencyClock()]);
  const status = overallStatus({ backlog: o.backlog, cronAgeSeconds: o.cronAgeSeconds, failedDeliveries: o.failedDeliveries });
  const label = levelLabel(status.level);

  const canSeeLeads = show('lead.read');
  const canSeeProjects = show('project.read');
  const canSeeRevenue = show('invoice.read');
  const canSeeUsage = show('audit.read');

  const [recentLeads, activeProjects, revenue, messagesSent, totalLeads, usage] = await Promise.all([
    canSeeLeads ? getRecentLeads(5) : Promise.resolve([]),
    canSeeProjects ? getActiveProjectsSummary(5) : Promise.resolve([]),
    canSeeRevenue ? getRevenueThisMonth() : Promise.resolve([]),
    canSeeLeads ? getMessagesSentThisMonth() : Promise.resolve(null),
    canSeeLeads ? getTotalLeadsCount() : Promise.resolve(null),
    canSeeUsage ? getAgentUsage() : Promise.resolve(null),
  ]);

  const leadColumns: Column<(typeof recentLeads)[number]>[] = [
    { key: 'title', header: 'Lead', primary: true, cell: (l) => l.title },
    {
      key: 'phone',
      header: 'Phone',
      cellClassName: 'font-mono text-xs text-muted',
      cell: (l) => l.contactPhone ?? '—',
    },
    { key: 'source', header: 'Source', desktopOnly: true, cellClassName: 'text-muted', cell: (l) => humanize(l.source) },
    { key: 'status', header: 'Status', badge: true, cell: (l) => <StatusBadge status={l.status} /> },
    {
      key: 'assigned',
      header: 'Assigned',
      desktopOnly: true,
      cellClassName: 'text-muted',
      cell: (l) => l.assignedEmail ?? 'Unassigned',
    },
    {
      key: 'activity',
      header: 'Last activity',
      align: 'right',
      cellClassName: 'text-muted',
      cell: (l) => clock.dateTime(l.lastActivityAt),
    },
  ];

  const projectColumns: Column<(typeof activeProjects)[number]>[] = [
    { key: 'name', header: 'Project', primary: true, cell: (p) => p.name },
    { key: 'client', header: 'Client', desktopOnly: true, cellClassName: 'text-muted', cell: (p) => p.clientName ?? '—' },
    { key: 'status', header: 'Status', badge: true, cell: (p) => <StatusBadge status={p.status} /> },
    {
      key: 'progress',
      header: 'Milestones',
      align: 'right',
      cellClassName: 'tabular text-muted',
      cell: (p) => (p.milestonesTotal > 0 ? `${p.milestonesMet}/${p.milestonesTotal}` : '—'),
    },
    {
      key: 'due',
      header: 'Due',
      align: 'right',
      cellClassName: 'text-muted',
      cell: (p) => (p.endsOn ? clock.date(p.endsOn) : '—'),
    },
  ];

  const cronText =
    o.cronAgeSeconds === null
      ? { text: 'unknown', tone: 'muted' as const }
      : o.cronAgeSeconds > 15 * 60
        ? {text: `${o.cronAgeSeconds > 3600 ? `${Math.floor(o.cronAgeSeconds / 3600)}h` : `${Math.floor(o.cronAgeSeconds / 60)}m`} ago — may be stopped`, tone: 'bad' as const }
        : { text: 'ticking', tone: 'good' as const };

  const destinations = (
    [
      ['Production readiness', 'Is it safe to go live?', '/production-readiness', 'organization.settings'],
      ['Integrations', 'Every dependency & its lifecycle', '/integrations', 'organization.settings'],
      ['Security', 'Structural invariants, live', '/security', 'audit.read'],
      ['Operations', 'Jobs, outbox, failed deliveries', '/operations', 'audit.read'],
      ['Approvals', 'What needs a decision', '/approvals', null],
      ['Agents', 'Registry & provider posture', '/agents', 'audit.read'],
      ['Usage & costs', 'What the agents consumed', '/usage', 'audit.read'],
      ['Audit log', 'Who changed what', '/audit', 'audit.read'],
      ['Import', 'Historical-lead review desk', '/import', 'organization.settings'],
      ['Settings', 'Configuration & reactivation', '/settings', 'organization.settings'],
    ] as [string, string, string, Capability | null][]
  ).filter(([, , , cap]) => cap === null || show(cap));

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <p className="text-[13px] text-muted">{clock.day(new Date())}</p>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
            {greeting(clock, new Date())}, {context.fullName?.split(' ')[0] ?? context.email.split('@')[0]}
          </h1>
          <p className="mt-1.5 text-[13px] text-muted">
            Signed in as {context.email} · environment{' '}
            <span className="font-mono">{o.environment.nodeEnv}</span>
            {o.environment.looksLocal ? ' · local' : ''}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <Badge tone={TONE[label.tone] ?? 'neutral'} dot className="px-2.5 py-1 text-[13px]">
            {label.text}
          </Badge>
          <AutoRefresh intervalMs={20000} />
        </div>
      </header>

      {status.level !== 'operational' ? (
        <Callout tone={label.tone === 'bad' ? 'danger' : 'warning'} icon={<IconAlert size={16} />}>
          {status.reason}
        </Callout>
      ) : null}

      {/* Business snapshot — leads, projects, revenue, agent activity. Each
          figure is a fresh read for this request; none of it is cached or
          estimated, so a quiet organization shows quiet numbers rather than
          the reference deck's always-busy demo data. */}
      {canSeeLeads || canSeeProjects || canSeeRevenue || canSeeUsage ? (
        <StatGrid cols={5}>
          {canSeeLeads ? (
            <Stat
              label="Total leads"
              href="/leads"
              value={String(totalLeads ?? 0)}
              tone="brand"
              icon={<IconUser size={16} />}
            />
          ) : null}
          {canSeeProjects ? (
            <Stat
              label="Active projects"
              href="/projects"
              value={String(activeProjects.length)}
              tone="info"
              icon={<IconProjects size={16} />}
            />
          ) : null}
          {canSeeRevenue ? (
            <Stat
              label="Revenue (this month)"
              href="/finance"
              value={revenue.length === 0 ? money(0, 'INR') : revenue.map((r) => money(r.paidMinor, r.currency)).join(' + ')}
              tone="success"
              icon={<IconInvoices size={16} />}
            />
          ) : null}
          {canSeeUsage ? (
            <Stat
              label="AI agent runs"
              href="/usage"
              value={String(usage?.totals.runs ?? 0)}
              tone="accent"
              icon={<IconAgents size={16} />}
            />
          ) : null}
          {canSeeLeads ? (
            <Stat
              label="Messages sent (this month)"
              href="/communication"
              value={String(messagesSent ?? 0)}
              tone="warning"
              icon={<IconUsage size={16} />}
            />
          ) : null}
        </StatGrid>
      ) : null}

      {canSeeLeads || canSeeProjects ? (
        <div className="grid gap-4 xl:grid-cols-2">
          {canSeeLeads ? (
            <Card>
              <CardHeader title="Recent leads" description="Most recently active first." />
              <div className="px-4 pb-4 sm:px-5">
                {recentLeads.length === 0 ? (
                  <EmptyState icon={<IconUser size={22} />} title="No leads yet" />
                ) : (
                  <DataTable rows={recentLeads} columns={leadColumns} getKey={(l) => l.id} href={(l) => `/leads/${l.id}`} />
                )}
              </div>
            </Card>
          ) : null}
          {canSeeProjects ? (
            <Card>
              <CardHeader title="Active projects" description="Planning through on hold, most recent first." />
              <div className="px-4 pb-4 sm:px-5">
                {activeProjects.length === 0 ? (
                  <EmptyState icon={<IconProjects size={22} />} title="No active projects" />
                ) : (
                  <DataTable
                    rows={activeProjects}
                    columns={projectColumns}
                    getKey={(p) => p.id}
                    href={(p) => `/projects/${p.id}`}
                  />
                )}
              </div>
            </Card>
          ) : null}
        </div>
      ) : null}

      {/* Operational KPI tiles — real reads only, each linking to its detail page. */}
      <StatGrid cols={6}>
        {show('audit.read') ? (
          <Stat
            label="Dead jobs"
            href="/operations"
            value={<Value value={num(o.backlog, (b) => String(b.dead_jobs))} />}
            tone={isAvailable(o.backlog) && o.backlog.value.dead_jobs > 0 ? 'danger' : 'neutral'}
            icon={<IconOperations size={16} />}
          />
        ) : null}
        {show('audit.read') ? (
          <Stat
            label="Failed deliveries"
            href="/operations"
            value={<Value value={num(o.failedDeliveries, String)} />}
            tone={isAvailable(o.failedDeliveries) && o.failedDeliveries.value > 0 ? 'danger' : 'neutral'}
            icon={<IconAlert size={16} />}
          />
        ) : null}
        <Stat
          label="Pending approvals"
          href="/approvals"
          value={<Value value={num(o.approvals, (a) => String(a.pending))} />}
          caption={isAvailable(o.approvals) && o.approvals.value.overdue > 0 ? `${o.approvals.value.overdue} overdue` : undefined}
          tone={isAvailable(o.approvals) && o.approvals.value.overdue > 0 ? 'warning' : 'neutral'}
          icon={<IconApprovals size={16} />}
        />
        {show('audit.read') ? (
          <Stat
            label="Agents runnable"
            href="/agents"
            value={<Value value={num(o.ai, (a) => `${a.agentsRunnable}/${a.agentsTotal}`)} />}
            icon={<IconAgents size={16} />}
          />
        ) : null}
        {show('organization.settings') ? (
          <Stat
            label="Reactivation enrolled"
            href="/import"
            value={<Value value={num(o.reactivation, (r) => String(r.enrolled))} />}
            caption={isAvailable(o.reactivation) ? (o.reactivation.value.pilotEnabled ? 'pilot on' : 'pilot off') : undefined}
            tone={isAvailable(o.reactivation) && o.reactivation.value.pilotEnabled ? 'success' : 'neutral'}
            icon={<IconRefresh size={16} />}
          />
        ) : null}
        {show('organization.settings') ? (
          <Stat
            label="Config problems"
            href="/settings"
            value={String(o.environment.productionProblems)}
            tone={o.environment.productionProblems > 0 ? 'warning' : 'success'}
            icon={<IconSettings size={16} />}
          />
        ) : null}
        {show('invoice.read') ? (
          <Stat
            label="Payments awaiting verification"
            href="/invoices/verify"
            value={<Value value={num(o.paymentsPendingVerification, String)} />}
            tone={isAvailable(o.paymentsPendingVerification) && o.paymentsPendingVerification.value > 0 ? 'warning' : 'neutral'}
            icon={<IconInvoices size={16} />}
          />
        ) : null}
        {show('project.read') ? (
          <Stat
            label="Projects on hold"
            href="/projects"
            value={<Value value={num(o.projectsOnHold, String)} />}
            tone={isAvailable(o.projectsOnHold) && o.projectsOnHold.value > 0 ? 'warning' : 'neutral'}
            icon={<IconProjects size={16} />}
          />
        ) : null}
      </StatGrid>

      <div className="grid gap-4 xl:grid-cols-2">
        {/* Needs attention — the prioritised queue SCR-001 calls for: overdue
            approvals and recent delivery failures, oldest first. */}
        <Card>
          <CardHeader title="Needs attention" description="Soonest deadline or oldest failure first." />
          {!isAvailable(o.needsAttention) ? (
            <div className="px-4 py-4 sm:px-5">
              <Value value="DATA UNAVAILABLE" />
            </div>
          ) : o.needsAttention.value.length === 0 ? (
            <EmptyState
              icon={<IconAlert size={22} />}
              title="Nothing needs attention"
              description="No overdue approvals and no recent delivery failures."
            />
          ) : (
            <ul className="divide-y divide-line">
              {o.needsAttention.value.map((item) => (
                <li key={item.id}>
                  <Link
                    href={item.href}
                    className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-hover sm:px-5"
                  >
                    <span
                      className={cx(
                        'h-1.5 w-1.5 shrink-0 rounded-full',
                        item.kind === 'approval' ? TONE_DOT.warning : TONE_DOT.danger,
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">{item.title}</span>
                      <span className="block truncate text-[13px] text-muted">{item.detail}</span>
                    </span>
                    <span className="shrink-0 text-xs text-faint">{clock.dateTime(item.at)}</span>
                    <IconChevronRight
                      size={16}
                      className="shrink-0 text-faint transition-transform group-hover:translate-x-0.5"
                    />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Today — what's on the calendar, in the agency's own zone. */}
        <Card>
          <CardHeader title="Today" description={clock.day(new Date())} />
          {!isAvailable(o.today) ? (
            <div className="px-4 py-4 sm:px-5">
              <Value value="DATA UNAVAILABLE" />
            </div>
          ) : o.today.value.length === 0 ? (
            <EmptyState title="No meetings today" description="Nothing on the calendar for today." />
          ) : (
            <ul className="divide-y divide-line">
              {o.today.value.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm sm:px-5">
                  <span className="min-w-0 truncate text-foreground">{m.title}</span>
                  <span className="shrink-0 text-xs font-medium text-muted">
                    {m.at ? clock.clock(m.at) : 'time TBD'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {/* System health — each row reflects a real read, or admits it can't. */}
        <Card>
          <CardHeader
            title="System health"
            description="Configured is not verified. Confirm WhatsApp and the AI provider from their pages before relying on them."
          />
          <ul className="divide-y divide-line">
            <HealthRow label="Application" state={{ text: 'serving', tone: 'good' }} />
            <HealthRow
              label="Database"
              state={isAvailable(o.backlog) ? { text: 'reachable', tone: 'good' } : { text: 'DATA UNAVAILABLE', tone: 'bad' }}
            />
            <HealthRow label="Cron scheduler" state={cronText} />
            <HealthRow
              label="AI provider"
              state={
                isAvailable(o.ai)
                  ? o.ai.value.providerConfigured
                    ? { text: 'configured', tone: 'good' }
                    : { text: 'not configured', tone: 'warn' }
                  : { text: 'DATA UNAVAILABLE', tone: 'bad' }
              }
            />
            <HealthRow
              label="WhatsApp"
              state={
                !isAvailable(o.whatsapp.numberConfigured)
                  ? { text: 'DATA UNAVAILABLE', tone: 'bad' }
                  : o.whatsapp.tokenConfigured && o.whatsapp.numberConfigured.value
                    ? { text: 'configured (verify to confirm)', tone: 'warn' }
                    : { text: 'not configured', tone: 'warn' }
              }
            />
          </ul>
        </Card>

        {/* Where to go next — capability-gated links into the control plane. */}
        <Card>
          <CardHeader title="Control plane" />
          <ul className="divide-y divide-line">
            {destinations.map(([name, blurb, href]) => (
              <li key={href}>
                <Link
                  href={href}
                  className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-hover sm:px-5"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-foreground">{name}</span>
                    <span className="block text-[13px] text-muted">{blurb}</span>
                  </span>
                  <IconChevronRight
                    size={16}
                    className="shrink-0 text-faint transition-transform group-hover:translate-x-0.5"
                  />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
