import type { Metadata } from 'next';
import Link from 'next/link';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { listFollowUpReminders } from '@/lib/admin/dashboard-reminders';
import {
  getActiveProjectsSummary,
  getMessagesSentThisMonth,
  getProjectCountsByStatus,
  getRecentLeads,
  getRevenueThisMonth,
  getTotalLeadsCount,
} from '@/lib/admin/dashboard';
import { OVERVIEW_WINDOWS, overviewWindow } from '@/lib/admin/dashboard-window';
import { listUnpaidMilestoneInvoices } from '@/lib/admin/finance-gate';
import { getOverview } from '@/lib/admin/overview';
import { isAvailable, levelLabel, overallStatus, type Avail } from '@/lib/admin/overview-eval';
import { PROJECT_HEALTH_LABEL, PROJECT_HEALTH_TONE, projectHealth, projectHealthReason } from '@/lib/admin/project-health';
import { getSalesFunnel } from '@/lib/admin/sales-funnel';
import { getAgentUsage } from '@/lib/admin/usage';
import { requireInternal } from '@/lib/auth/session';
import { can, type Capability } from '@/lib/authz/permissions';
import { LiveRefresh } from '@/lib/realtime';
import {
  ActivityFeed,
  Avatar,
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
  IconCheck,
  IconChevronRight,
  IconClock,
  IconInbox,
  IconInvoices,
  IconMessage,
  IconOperations,
  IconProjects,
  IconRefresh,
  IconSettings,
  IconSparkle,
  IconTarget,
  IconUsers,
  PipelineStrip,
  ProgressBar,
  Stat,
  StatGrid,
  StatusBadge,
  StatusList,
  ViewAll,
  type Column,
  type PipelineStage,
  type StatusRow,
  type Tone,
  FilterChips,
  buttonClass,
} from '@/ui';

import { listPendingPaymentClaims } from '@/modules/finance/queries';
import { listMyTasks, listPhaseFourEscalations } from '@/modules/projects/queries';

import { categoryOf } from '../notifications/action-items';
import { listAnnotatedActionItems } from '../notifications/annotated-items';
import { EscalateControl } from '../notifications/escalate-form';
import { QuickActionsRow } from './quick-actions-row';

export const metadata: Metadata = { title: 'Command Center' };

/**
 * The Command Center — the front door of the Admin control plane, laid out
 * as the reference deck's first screen: a greeting, five business KPIs, the
 * pipeline strip, recent leads and active projects on the left, and the
 * rail on the right — Tasks & Approvals, System Status, Usage & Cost.
 *
 * Every figure is a fresh read for this request from the SAME authoritative
 * readers the detail pages use; nothing here is cached, estimated or
 * hard-coded. A signal that could not be READ shows DATA UNAVAILABLE, never
 * 0 — a monitor that invents zeros manufactures false calm — and a quiet
 * organisation shows quiet numbers rather than the deck's always-busy demo
 * data. Each card links to the page that owns the detail and is shown only
 * to a role that may open that page.
 *
 * Bucket F (stream F-A) finished SCR-001's list: the Today card carries the
 * follow-up reminders; the project table carries a health column on the
 * SAME at-risk rule the projects list uses (`project-health.ts`); a finance
 * gate queue lists the unpaid milestone invoices holding a phase and the
 * claims awaiting a decision; a quick-actions row opens the same create
 * forms the header does; every KPI tile links to the list filtered to
 * exactly that number; and the Tasks & approvals feed carries the recorded
 * escalate / acknowledge door (`core.escalations`).
 */

const TONE: Record<string, Tone> = { good: 'success', warn: 'warning', bad: 'danger', muted: 'neutral' };

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
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(minor / 100);
}

function compact(n: number): string {
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(n);
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

export default async function OverviewPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const context = await requireInternal('/dashboard');
  const show = (cap: Capability) => can(context, cap);

  // SCR-001's global date range. The funnel strip and the four "happened
  // over time" counts honour it (see dashboard-window.ts); "this month" and
  // "right now" tiles have no window to honour and say so in their captions.
  const { days } = await searchParams;
  const sinceDays = overviewWindow(days);

  const [o, clock] = await Promise.all([getOverview({ sinceDays }), agencyClock()]);
  const status = overallStatus({ backlog: o.backlog, cronAgeSeconds: o.cronAgeSeconds, failedDeliveries: o.failedDeliveries });
  const label = levelLabel(status.level);

  const canSeeLeads = show('lead.read');
  const canSeeProjects = show('project.read');
  const canSeeRevenue = show('invoice.read');
  const canSeeUsage = show('audit.read');

  const canCreateInvoice = show('invoice.create');
  const canVerifyClaims = show('invoice.issue');
  const todayWindow = clock.today();

  const [recentLeads, activeProjects, revenue, messagesSent, totalLeads, usage, funnel, projectCounts, actionItems, escalations, myTasks, reminders, gateInvoices, gateClaims] =
    await Promise.all([
      canSeeLeads ? getRecentLeads(5) : Promise.resolve([]),
      canSeeProjects ? getActiveProjectsSummary(5) : Promise.resolve([]),
      canSeeRevenue ? getRevenueThisMonth() : Promise.resolve([]),
      canSeeLeads ? getMessagesSentThisMonth() : Promise.resolve(null),
      canSeeLeads ? getTotalLeadsCount() : Promise.resolve(null),
      canSeeUsage ? getAgentUsage() : Promise.resolve(null),
      canSeeLeads ? getSalesFunnel(sinceDays) : Promise.resolve(null),
      canSeeProjects ? getProjectCountsByStatus() : Promise.resolve(null),
      listAnnotatedActionItems(context, clock),
      canSeeProjects ? listPhaseFourEscalations() : Promise.resolve([]),
      listMyTasks(context.userId),
      canSeeLeads ? listFollowUpReminders(todayWindow) : Promise.resolve([]),
      canSeeRevenue ? listUnpaidMilestoneInvoices() : Promise.resolve([]),
      canVerifyClaims ? listPendingPaymentClaims() : Promise.resolve([]),
    ]);

  const now = new Date();
  const todayKey = clock.dayKey(now);
  const dueToday = myTasks.filter((t) => t.dueOn === todayKey);
  const overdueMine = myTasks.filter((t) => t.dueOn !== null && t.dueOn < todayKey);
  const firstName = context.fullName?.split(' ')[0] ?? context.email.split('@')[0];
  // Every KPI tile opens the list filtered to exactly its number (bucket F).
  const windowFrom = clock.dayKey(new Date(now.getTime() - sinceDays * 24 * 60 * 60 * 1000));
  const escalatedProjectIds = new Set(escalations.map((e) => e.projectId));
  const openProjects = projectCounts ? ['planning', 'onboarding', 'active', 'on_hold'].reduce((n, st) => n + (projectCounts[st] ?? 0), 0) : null;
  const canAnswerEscalations = show('audit.read');

  const pipeline: PipelineStage[] = [
    ...(funnel
      ? ([
          { label: 'Leads', count: funnel.counts.leads, tone: 'info', href: '/leads' },
          { label: 'Qualified', count: funnel.counts.qualified, tone: 'brand', href: '/leads?status=qualified' },
          { label: 'Quoted', count: funnel.counts.quoted, tone: 'accent', href: '/quotations' },
          { label: 'Won', count: funnel.counts.won, tone: 'success', href: '/sales-funnel' },
        ] satisfies PipelineStage[])
      : []),
    ...(projectCounts
      ? ([
          { label: 'Planning', count: projectCounts.planning ?? 0, tone: 'neutral', href: '/projects?status=planning' },
          { label: 'Onboarding', count: projectCounts.onboarding ?? 0, tone: 'warning', href: '/projects?status=onboarding' },
          { label: 'In progress', count: projectCounts.active ?? 0, tone: 'info', href: '/projects?status=active' },
          { label: 'On hold', count: projectCounts.on_hold ?? 0, tone: 'danger', href: '/projects?status=on_hold' },
          { label: 'Completed', count: projectCounts.completed ?? 0, tone: 'success', href: '/projects?status=completed' },
        ] satisfies PipelineStage[])
      : []),
  ];

  const leadColumns: Column<(typeof recentLeads)[number]>[] = [
    {
      key: 'title',
      header: 'Name',
      primary: true,
      cell: (l) => (
        <span className="flex items-center gap-2.5">
          <Avatar name={l.title} size="sm" />
          <span className="min-w-0">
            <span className="block truncate font-medium">{l.title}</span>
            {l.contactPhone ? <span className="block font-mono text-[11px] text-muted lg:hidden">{l.contactPhone}</span> : null}
          </span>
        </span>
      ),
    },
    { key: 'phone', header: 'Phone', desktopOnly: true, cellClassName: 'font-mono text-xs text-muted', cell: (l) => l.contactPhone ?? '—' },
    { key: 'source', header: 'Source', desktopOnly: true, cellClassName: 'text-muted', cell: (l) => humanize(l.source) },
    {
      key: 'status',
      header: 'Status',
      badge: true,
      cell: (l) => (
        <span className="flex items-center gap-2">
          <StatusBadge status={l.status} dot={false} />
          {l.assignedEmail ? <span className="hidden text-xs text-muted 2xl:inline">{l.assignedEmail.split('@')[0]}</span> : null}
        </span>
      ),
    },
    { key: 'activity', header: 'Last activity', align: 'right', cellClassName: 'text-muted whitespace-nowrap', cell: (l) => clock.dateTime(l.lastActivityAt) },
  ];

  const projectColumns: Column<(typeof activeProjects)[number]>[] = [
    {
      key: 'name',
      header: 'Project name',
      primary: true,
      cell: (p) => (
        <span className="flex items-center gap-2.5">
          <Avatar name={p.name} size="sm" square tone="neutral" className="bg-sidebar-bg text-sidebar-fg ring-0" />
          <span className="truncate font-medium">{p.name}</span>
        </span>
      ),
    },
    { key: 'client', header: 'Client', desktopOnly: true, cellClassName: 'text-muted', cell: (p) => p.clientName ?? 'Internal' },
    { key: 'status', header: 'Stage', badge: true, cell: (p) => <StatusBadge status={p.status} dot={false} /> },
    {
      // SCR-001 "Project health table" — the projects list's own at-risk rule.
      key: 'health',
      header: 'Health',
      cell: (p) => {
        const input = { status: p.status, endsOn: p.endsOn, escalated: escalatedProjectIds.has(p.id), todayKey };
        const health = projectHealth(input);
        const reason = projectHealthReason(input);
        return (
          <span className="flex items-center gap-1.5">
            <Badge tone={PROJECT_HEALTH_TONE[health]} dot>
              {PROJECT_HEALTH_LABEL[health]}
            </Badge>
            {reason ? <span className="hidden text-xs text-muted 2xl:inline">{reason}</span> : null}
          </span>
        );
      },
    },
    {
      key: 'progress',
      header: 'Progress',
      width: '11rem',
      cell: (p) =>
        p.milestonesTotal > 0 ? (
          <ProgressBar value={(p.milestonesMet / p.milestonesTotal) * 100} label={`${p.name} milestones met`} />
        ) : (
          <span className="text-xs text-muted">No plan yet</span>
        ),
    },
    { key: 'due', header: 'Due date', align: 'right', cellClassName: 'text-muted whitespace-nowrap', cell: (p) => (p.endsOn ? clock.date(p.endsOn) : '—') },
  ];

  const cronText =
    o.cronAgeSeconds === null
      ? { text: 'Unknown', tone: 'muted' as const }
      : o.cronAgeSeconds > 15 * 60
        ? { text: `${o.cronAgeSeconds > 3600 ? `${Math.floor(o.cronAgeSeconds / 3600)}h` : `${Math.floor(o.cronAgeSeconds / 60)}m`} ago — may be stopped`, tone: 'bad' as const }
        : { text: 'Running', tone: 'good' as const };

  const systemRows: StatusRow[] = [
    {
      label: 'Database (Supabase)',
      icon: <IconOperations size={13} />,
      ...(isAvailable(o.backlog) ? { state: 'Connected', tone: 'success' } : { state: 'DATA UNAVAILABLE', tone: 'danger' }),
    },
    {
      label: 'AI provider',
      icon: <IconSparkle size={13} />,
      ...(isAvailable(o.ai)
        ? o.ai.value.providerConfigured
          ? { state: 'Configured', tone: 'success' as Tone }
          : { state: 'Not configured', tone: 'warning' as Tone }
        : { state: 'DATA UNAVAILABLE', tone: 'danger' as Tone }),
    },
    {
      label: 'WhatsApp (Meta)',
      icon: <IconMessage size={13} />,
      ...(!isAvailable(o.whatsapp.numberConfigured)
        ? { state: 'DATA UNAVAILABLE', tone: 'danger' as Tone }
        : o.whatsapp.tokenConfigured && o.whatsapp.numberConfigured.value
          ? { state: 'Configured · verify', tone: 'warning' as Tone }
          : { state: 'Not configured', tone: 'warning' as Tone }),
    },
    { label: 'Scheduler (Cron)', icon: <IconClock size={13} />, state: cronText.text, tone: TONE[cronText.tone] ?? 'neutral' },
    {
      label: 'Operational alerts',
      icon: <IconAlert size={13} />,
      ...(isAvailable(o.failedDeliveries)
        ? o.failedDeliveries.value > 0
          ? { state: `${o.failedDeliveries.value} failed`, tone: 'danger' as Tone }
          : { state: 'Clear', tone: 'success' as Tone }
        : { state: 'DATA UNAVAILABLE', tone: 'danger' as Tone }),
    },
  ];

  const destinations = (
    [
      ['Production readiness', 'Is it safe to go live?', '/production-readiness', 'organization.settings'],
      ['Integrations', 'Every dependency & its lifecycle', '/integrations', 'organization.settings'],
      ['Security', 'Structural invariants, live', '/security', 'audit.read'],
      ['Operations', 'Jobs, outbox, failed deliveries', '/operations', 'audit.read'],
      ['Agents', 'Registry & provider posture', '/agents', 'audit.read'],
      ['Audit log', 'Who changed what', '/audit', 'audit.read'],
      ['Import', 'Historical-lead review desk', '/import', 'organization.settings'],
      ['Settings', 'Configuration & reactivation', '/settings', 'organization.settings'],
    ] as [string, string, string, Capability | null][]
  ).filter(([, , , cap]) => cap === null || show(cap));

  const urgentCount = actionItems.filter((i) => i.urgent && i.attention).length;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <p className="text-[13px] text-muted">{clock.day(now)}</p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-[28px]">
            {greeting(clock, now)}, {firstName}! <span aria-hidden>👋</span>
          </h1>
          <p className="mt-1 text-[13px] text-muted sm:text-sm">
            Here&apos;s what&apos;s happening with your agency today.
            {o.environment.looksLocal ? (
              <>
                {' '}
                · <span className="font-mono">{o.environment.nodeEnv}</span> · local
              </>
            ) : null}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <Badge tone={TONE[label.tone] ?? 'neutral'} dot className="px-3 py-1.5 text-[13px]">
            {label.text}
          </Badge>
          <LiveRefresh topics={['approvals', 'finance', 'jobs', 'leads', 'projects', 'agents']} />
        </div>
      </header>

      {/* SCR-001 — the window selector and what happened inside it. Counts
          of rows with a timestamp in the range; nothing is projected. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">Date range</span>
          <FilterChips
            options={OVERVIEW_WINDOWS.map((d) => ({
              key: String(d),
              label: `Last ${d} days`,
              href: d === 30 ? '/dashboard' : `/dashboard?days=${d}`,
              active: sinceDays === d,
            }))}
          />
        </div>
        {canSeeProjects ? (
          <Link href="/reports" className={buttonClass('secondary', 'sm')}>
            Generate report
          </Link>
        ) : null}
      </div>

      {/* SCR-001 "Quick actions" — the header's own create forms, and the queue. */}
      <QuickActionsRow canCreateLead={show('lead.write')} canCreateProject={show('project.write')} canCreateInvoice={canCreateInvoice} pendingApprovals={isAvailable(o.approvals) ? o.approvals.value.pending : null} />

      <StatGrid cols={4}>
        <Stat label="Leads created" href={canSeeLeads ? `/leads?createdFrom=${windowFrom}` : undefined} value={<Value value={num(o.window, (w) => String(w.leadsCreated))} />} caption={`in the last ${sinceDays} days`} />
        <Stat label="Deals won" href={canSeeLeads ? `/sales-funnel?days=${sinceDays}` : undefined} value={<Value value={num(o.window, (w) => String(w.dealsWon))} />} caption={`closed won in the last ${sinceDays} days`} />
        <Stat label="Invoices issued" href={canSeeRevenue ? `/invoices?issuedFrom=${windowFrom}` : undefined} value={<Value value={num(o.window, (w) => String(w.invoicesIssued))} />} caption={`issued in the last ${sinceDays} days`} />
        <Stat label="Meetings completed" href={canSeeLeads ? '/meetings?window=past&status=completed' : undefined} value={<Value value={num(o.window, (w) => String(w.meetingsCompleted))} />} caption={`completed in the last ${sinceDays} days`} />
      </StatGrid>

      {status.level !== 'operational' ? (
        <Callout tone={label.tone === 'bad' ? 'danger' : 'warning'} icon={<IconAlert size={16} />}>
          {status.reason}
        </Callout>
      ) : null}

      {/* ── Business snapshot ─────────────────────────────────────────── */}
      {canSeeLeads || canSeeProjects || canSeeRevenue || canSeeUsage ? (
        <StatGrid cols={5}>
          {canSeeLeads ? (
            <Stat label="Total leads" href="/leads" value={String(totalLeads ?? 0)} caption="All time" tone="brand" icon={<IconUsers size={16} />} />
          ) : null}
          {canSeeProjects ? (
            <Stat
              label="Active projects"
              href="/projects?status=open"
              value={openProjects === null ? 'DATA UNAVAILABLE' : String(openProjects)}
              caption={projectCounts ? `${projectCounts.active ?? 0} in development · planning to on hold` : undefined}
              tone="info"
              icon={<IconProjects size={16} />}
            />
          ) : null}
          {canSeeRevenue ? (
            <Stat
              label="Revenue (this month)"
              href="/finance"
              value={revenue.length === 0 ? money(0, 'INR') : revenue.map((r) => money(r.paidMinor, r.currency)).join(' + ')}
              caption="Payments recorded"
              tone="success"
              icon={<IconInvoices size={16} />}
            />
          ) : null}
          {canSeeUsage ? (
            <Stat
              label="AI agent runs"
              href="/usage"
              value={compact(usage?.totals.runs ?? 0)}
              caption={isAvailable(o.ai) ? `${o.ai.value.agentsRunnable}/${o.ai.value.agentsTotal} agents runnable` : undefined}
              tone="accent"
              icon={<IconAgents size={16} />}
            />
          ) : null}
          {canSeeLeads ? (
            <Stat label="Messages sent" href="/communication" value={compact(messagesSent ?? 0)} caption="This month" tone="warning" icon={<IconMessage size={16} />} />
          ) : null}
        </StatGrid>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(20rem,1fr)]">
        {/* ── Left column ──────────────────────────────────────────── */}
        <div className="flex min-w-0 flex-col gap-4">
          {pipeline.length > 0 ? (
            <Card>
              <CardHeader title="Project pipeline" description={`Last ${sinceDays} days of sales, and every project by stage.`} actions={<ViewAll href={`/sales-funnel?days=${sinceDays}`} />} />
              <div className="p-4 sm:p-5">
                <PipelineStrip stages={pipeline} />
              </div>
            </Card>
          ) : null}

          {canSeeLeads ? (
            <Card>
              <CardHeader title="Recent leads" actions={<ViewAll href="/leads" />} />
              <div className="px-4 pb-4 sm:px-5">
                {recentLeads.length === 0 ? (
                  <EmptyState icon={<IconUsers size={22} />} title="No leads yet" description="Leads arrive from WhatsApp, referrals and the website — or are entered by hand." action={<Link href="/leads" className={buttonClass('secondary', 'sm')}>Open leads</Link>} />
                ) : (
                  <DataTable dense rows={recentLeads} columns={leadColumns} getKey={(l) => l.id} href={(l) => `/leads/${l.id}`} />
                )}
              </div>
            </Card>
          ) : null}

          {canSeeProjects ? (
            <Card>
              <CardHeader title="Active projects" actions={<ViewAll href="/projects" />} />
              <div className="px-4 pb-4 sm:px-5">
                {activeProjects.length === 0 ? (
                  <EmptyState icon={<IconProjects size={22} />} title="No active projects" description="A project starts from a won deal, a template, or by hand from the header's Create." action={<Link href="/projects" className={buttonClass('secondary', 'sm')}>Open projects</Link>} />
                ) : (
                  <DataTable dense rows={activeProjects} columns={projectColumns} getKey={(p) => p.id} href={(p) => `/projects/${p.id}`} />
                )}
              </div>
            </Card>
          ) : null}

          {/* SCR-001 "Finance gate queue" — the unpaid milestone invoices holding
              a phase (finance-gate.ts) and the claims awaiting a decision, from
              the same readers /invoices and /invoices/verify use. */}
          {canSeeRevenue || canVerifyClaims ? (
            <Card>
              <CardHeader
                title="Finance gate queue"
                description="Milestone invoices unpaid — each one holds the phase behind it — and payment claims waiting for a decision."
                actions={<ViewAll href={canVerifyClaims ? '/invoices/verify' : '/invoices?status=unpaid'} />}
              />
              {gateInvoices.length === 0 && gateClaims.length === 0 ? (
                <EmptyState
                  icon={<IconInvoices size={22} />}
                  title="Nothing at the gate"
                  description="No milestone invoice is unpaid and no claim is waiting."
                  action={canSeeRevenue ? <Link href="/invoices" className={buttonClass('secondary', 'sm')}>Open invoices</Link> : undefined}
                />
              ) : (
                <ul className="divide-y divide-line">
                  {gateInvoices.map((g) => (
                    <li key={g.invoiceId}>
                      <Link href={`/invoices/${g.invoiceId}`} className="flex items-center gap-3 px-4 py-2.5 text-[13px] transition-colors hover:bg-surface-hover sm:px-5">
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-warning-soft text-warning"><IconInvoices size={13} /></span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium text-foreground">
                            {g.number} · {g.projectName ?? 'no project'}
                          </span>
                          <span className="block truncate text-xs text-muted">
                            {g.milestonePosition !== null ? `M${g.milestonePosition} ` : ''}{g.milestoneName ?? 'milestone'} · {money(g.totalMinor - g.paidMinor, g.currency)} outstanding
                            {g.dueAt ? ` · due ${clock.date(g.dueAt)}` : ''}
                          </span>
                        </span>
                        <StatusBadge status={g.status} dot={false} />
                      </Link>
                    </li>
                  ))}
                  {gateClaims.slice(0, 5).map((c) => (
                    <li key={c.id}>
                      <Link href="/invoices/verify" className="flex items-center gap-3 px-4 py-2.5 text-[13px] transition-colors hover:bg-surface-hover sm:px-5">
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-info-soft text-info"><IconCheck size={13} /></span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium text-foreground">Claim on {c.invoiceNumber} · {c.clientName ?? 'unknown client'}</span>
                          <span className="block truncate text-xs text-muted">claimed {clock.dateTime(c.submitted_at)} · awaiting verification</span>
                        </span>
                        <Badge tone={c.status === 'mismatch' ? 'danger' : 'warning'} dot={false}>{humanize(c.status)}</Badge>
                      </Link>
                    </li>
                  ))}
                  {gateClaims.length > 5 ? (
                    <li className="px-4 py-2 text-xs text-muted sm:px-5">{gateClaims.length - 5} more claim{gateClaims.length - 5 === 1 ? '' : 's'} on /invoices/verify.</li>
                  ) : null}
                </ul>
              )}
            </Card>
          ) : null}

          {/* Operational KPI tiles — real reads only, each linking to its detail page. */}
          <StatGrid cols={4}>
            {canSeeProjects ? (
              <Stat label="Blocked projects" href="/projects/escalations" value={String(escalations.length)} caption="Phase 4 escalations" tone={escalations.length > 0 ? 'danger' : 'neutral'} icon={<IconAlert size={16} />} />
            ) : null}
            {show('audit.read') ? (
              <Stat label="Failed deliveries" href="/operations#failed-deliveries" value={<Value value={num(o.failedDeliveries, String)} />} tone={isAvailable(o.failedDeliveries) && o.failedDeliveries.value > 0 ? 'danger' : 'neutral'} icon={<IconMessage size={16} />} />
            ) : null}
            {show('audit.read') ? (
              <Stat label="Dead jobs" href="/operations#dead-letters" value={<Value value={num(o.backlog, (b) => String(b.dead_jobs))} />} tone={isAvailable(o.backlog) && o.backlog.value.dead_jobs > 0 ? 'danger' : 'neutral'} icon={<IconOperations size={16} />} />
            ) : null}
            <Stat
              label="Pending approvals"
              href="/approvals"
              value={<Value value={num(o.approvals, (a) => String(a.pending))} />}
              caption={isAvailable(o.approvals) && o.approvals.value.overdue > 0 ? `${o.approvals.value.overdue} overdue` : undefined}
              tone={isAvailable(o.approvals) && o.approvals.value.overdue > 0 ? 'warning' : 'neutral'}
              icon={<IconApprovals size={16} />}
            />
            {show('invoice.read') ? (
              <Stat label="Payments to verify" href="/invoices/verify" value={<Value value={num(o.paymentsPendingVerification, String)} />} tone={isAvailable(o.paymentsPendingVerification) && o.paymentsPendingVerification.value > 0 ? 'warning' : 'neutral'} icon={<IconInvoices size={16} />} />
            ) : null}
            {show('project.read') ? (
              <Stat label="Projects on hold" href="/projects?status=on_hold" value={<Value value={num(o.projectsOnHold, String)} />} tone={isAvailable(o.projectsOnHold) && o.projectsOnHold.value > 0 ? 'warning' : 'neutral'} icon={<IconProjects size={16} />} />
            ) : null}
            {show('organization.settings') ? (
              <Stat label="Reactivation enrolled" href="/import" value={<Value value={num(o.reactivation, (r) => String(r.enrolled))} />} caption={isAvailable(o.reactivation) ? (o.reactivation.value.pilotEnabled ? 'Pilot on' : 'Pilot off') : undefined} icon={<IconRefresh size={16} />} />
            ) : null}
            {show('organization.settings') ? (
              <Stat label="Config problems" href="/settings" value={String(o.environment.productionProblems)} tone={o.environment.productionProblems > 0 ? 'warning' : 'success'} icon={<IconSettings size={16} />} />
            ) : null}
          </StatGrid>
        </div>

        {/* ── Right rail ───────────────────────────────────────────── */}
        <div className="flex min-w-0 flex-col gap-4">
          <ActivityFeed
            title={
              <span className="flex items-center gap-2">
                Tasks &amp; approvals
                {urgentCount > 0 ? (
                  <span className="tabular flex h-5 min-w-5 items-center justify-center rounded-full bg-danger px-1.5 text-[11px] font-semibold text-white">{urgentCount}</span>
                ) : null}
              </span>
            }
            viewAllHref="/notifications"
            items={actionItems
              .filter((i) => i.attention)
              .slice(0, 6)
              .map((i) => ({
                id: i.key,
                title: i.title,
                detail: i.detail,
                when: i.urgent ? 'Urgent' : '',
                tone: i.urgent ? 'danger' : 'brand',
                icon: <IconInbox size={13} />,
                href: i.href,
                // SCR-001 "Acknowledge / escalate an operational item" — the
                // same recorded door the inbox uses (core.escalations).
                action: (
                  <EscalateControl
                    subjectType={categoryOf(i)}
                    subjectKey={i.key}
                    title={i.title}
                    escalation={
                      i.escalation
                        ? {
                            id: i.escalation.id,
                            toRole: i.escalation.toRole,
                            reason: i.escalation.reason,
                            state: i.escalation.state,
                            fromUserName: i.escalation.fromUserName,
                            acknowledgedByName: i.escalation.acknowledgedByName,
                            createdAtLabel: clock.dateTime(i.escalation.createdAt),
                          }
                        : null
                    }
                    canAnswer={canAnswerEscalations}
                    compact
                  />
                ),
              }))}
            emptyTitle="Nothing needs you"
            emptyDescription="No approvals, claims, defects or failures are waiting."
            compact
          />

          <Card>
            <CardHeader
              title="System status"
              actions={
                <span className="flex items-center gap-2">
                  <Badge tone={TONE[label.tone] ?? 'neutral'} dot>
                    {label.text}
                  </Badge>
                  {show('organization.settings') ? <ViewAll href="/production-readiness" /> : null}
                </span>
              }
            />
            <StatusList rows={systemRows} className="py-1" />
          </Card>

          {canSeeUsage ? (
            <Card>
              <CardHeader title="Usage & cost" description="Agent runs recorded in the cost ledger." actions={<ViewAll href="/usage" label="View details" />} />
              <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-4 sm:p-5">
                {[
                  ['Agent runs', compact(usage?.totals.runs ?? 0)],
                  ['Input tokens', compact(usage?.totals.inputTokens ?? 0)],
                  ['Output tokens', compact(usage?.totals.outputTokens ?? 0)],
                  ['Total cost', money(usage?.totals.costMinor ?? 0, 'INR')],
                ].map(([l, v]) => (
                  <div key={l} className="min-w-0">
                    <p className="tabular truncate text-lg font-semibold leading-tight text-foreground">{v}</p>
                    <p className="text-[11px] text-muted">{l}</p>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}

          <Card>
            <CardHeader title="Today" description={clock.day(now)} actions={<ViewAll href="/my-tasks" label="My tasks" />} />
            <ul className="divide-y divide-line">
              {isAvailable(o.today)
                ? o.today.value.map((m) => (
                    <li key={m.id} className="flex items-center gap-3 px-4 py-2.5 text-[13px] sm:px-5">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-info-soft text-info"><IconClock size={13} /></span>
                      <span className="min-w-0 flex-1 truncate text-foreground">{m.title}</span>
                      <span className="shrink-0 text-xs font-medium text-muted">{m.at ? clock.clock(m.at) : 'time TBD'}</span>
                    </li>
                  ))
                : (
                    <li className="px-4 py-2.5 text-[13px] text-danger sm:px-5">Meetings: DATA UNAVAILABLE</li>
                  )}
              {/* SCR-001 "Today: … reminders" — leads whose follow-up is due today or has slipped. */}
              {reminders.map((r) => (
                <li key={r.leadId}>
                  <Link href={`/leads/${r.leadId}`} className="flex items-center gap-3 px-4 py-2.5 text-[13px] transition-colors hover:bg-surface-hover sm:px-5">
                    <span className={cx('flex h-7 w-7 shrink-0 items-center justify-center rounded-full', r.overdue ? 'bg-danger-soft text-danger' : 'bg-accent-soft text-foreground')}><IconTarget size={13} /></span>
                    <span className="min-w-0 flex-1 truncate text-foreground">{r.title}</span>
                    <span className="shrink-0 text-xs text-muted">{r.overdue ? `Follow-up slipped · ${clock.date(r.dueAt)}` : `Follow-up · ${clock.clock(r.dueAt)}`}</span>
                  </Link>
                </li>
              ))}
              {dueToday.map((t) => (
                <li key={t.id}>
                  <Link href={`/projects/${t.projectId}/board`} className="flex items-center gap-3 px-4 py-2.5 text-[13px] transition-colors hover:bg-surface-hover sm:px-5">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand"><IconCheck size={13} /></span>
                    <span className="min-w-0 flex-1 truncate text-foreground">{t.title}</span>
                    <span className="shrink-0 text-xs text-muted">Task due · {t.projectName}</span>
                  </Link>
                </li>
              ))}
              {overdueMine.length > 0 ? (
                <li>
                  <Link href="/my-tasks" className="flex items-center gap-3 px-4 py-2.5 text-[13px] transition-colors hover:bg-surface-hover sm:px-5">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-danger-soft text-danger"><IconAlert size={13} /></span>
                    <span className="min-w-0 flex-1 text-foreground">{overdueMine.length} of your task{overdueMine.length === 1 ? '' : 's'} overdue</span>
                  </Link>
                </li>
              ) : null}
              {show('invoice.read') && isAvailable(o.paymentsPendingVerification) && o.paymentsPendingVerification.value > 0 ? (
                <li>
                  <Link href="/invoices/verify" className="flex items-center gap-3 px-4 py-2.5 text-[13px] transition-colors hover:bg-surface-hover sm:px-5">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-warning-soft text-warning"><IconInvoices size={13} /></span>
                    <span className="min-w-0 flex-1 text-foreground">{o.paymentsPendingVerification.value} payment{o.paymentsPendingVerification.value === 1 ? '' : 's'} to verify</span>
                  </Link>
                </li>
              ) : null}
              {(!isAvailable(o.today) || o.today.value.length === 0) && reminders.length === 0 && dueToday.length === 0 && overdueMine.length === 0 && !(show('invoice.read') && isAvailable(o.paymentsPendingVerification) && o.paymentsPendingVerification.value > 0) ? (
                <li className="px-4 py-3 text-[13px] text-muted sm:px-5">Nothing on the calendar, no follow-up due, nothing of yours due, nothing to verify.</li>
              ) : null}
            </ul>
          </Card>

          {destinations.length > 0 ? (
            <Card>
              <CardHeader title="Control plane" />
              <ul className="divide-y divide-line">
                {destinations.map(([name, blurb, href]) => (
                  <li key={href}>
                    <Link href={href} className="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface-hover sm:px-5">
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] font-medium text-foreground">{name}</span>
                        <span className="block text-xs text-muted">{blurb}</span>
                      </span>
                      <IconChevronRight size={16} className={cx('shrink-0 text-faint transition-transform group-hover:translate-x-0.5')} />
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
