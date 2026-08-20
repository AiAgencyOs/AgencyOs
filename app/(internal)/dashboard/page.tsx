import type { Metadata } from 'next';
import Link from 'next/link';

import { getOverview } from '@/lib/admin/overview';
import { isAvailable, levelLabel, overallStatus, type Avail } from '@/lib/admin/overview-eval';
import { requireInternal } from '@/lib/auth/session';
import { can, type Capability } from '@/lib/authz/permissions';
import {
  Badge,
  Callout,
  Card,
  CardHeader,
  cx,
  IconAlert,
  IconChevronRight,
  Stat,
  TONE_DOT,
  TONE_TEXT,
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

  const o = await getOverview();
  const status = overallStatus({ backlog: o.backlog, cronAgeSeconds: o.cronAgeSeconds, failedDeliveries: o.failedDeliveries });
  const label = levelLabel(status.level);

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
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Overview</h1>
          <p className="mt-1.5 text-[13px] text-muted">
            Signed in as {context.email} · environment{' '}
            <span className="font-mono">{o.environment.nodeEnv}</span>
            {o.environment.looksLocal ? ' · local' : ''}
          </p>
        </div>
        <Badge tone={TONE[label.tone] ?? 'neutral'} dot className="px-2.5 py-1 text-[13px]">
          {label.text}
        </Badge>
      </header>

      {status.level !== 'operational' ? (
        <Callout tone={label.tone === 'bad' ? 'danger' : 'warning'} icon={<IconAlert size={16} />}>
          {status.reason}
        </Callout>
      ) : null}

      {/* Operational KPI tiles — real reads only, each linking to its detail page. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        {show('audit.read') ? (
          <Stat
            label="Dead jobs"
            href="/operations"
            value={<Value value={num(o.backlog, (b) => String(b.dead_jobs))} />}
            tone={isAvailable(o.backlog) && o.backlog.value.dead_jobs > 0 ? 'danger' : 'neutral'}
          />
        ) : null}
        {show('audit.read') ? (
          <Stat
            label="Failed deliveries"
            href="/operations"
            value={<Value value={num(o.failedDeliveries, String)} />}
            tone={isAvailable(o.failedDeliveries) && o.failedDeliveries.value > 0 ? 'danger' : 'neutral'}
          />
        ) : null}
        <Stat
          label="Pending approvals"
          href="/approvals"
          value={<Value value={num(o.approvals, (a) => String(a.pending))} />}
          caption={isAvailable(o.approvals) && o.approvals.value.overdue > 0 ? `${o.approvals.value.overdue} overdue` : undefined}
          tone={isAvailable(o.approvals) && o.approvals.value.overdue > 0 ? 'warning' : 'neutral'}
        />
        {show('audit.read') ? (
          <Stat
            label="Agents runnable"
            href="/agents"
            value={<Value value={num(o.ai, (a) => `${a.agentsRunnable}/${a.agentsTotal}`)} />}
          />
        ) : null}
        {show('organization.settings') ? (
          <Stat
            label="Reactivation enrolled"
            href="/import"
            value={<Value value={num(o.reactivation, (r) => String(r.enrolled))} />}
            caption={isAvailable(o.reactivation) ? (o.reactivation.value.pilotEnabled ? 'pilot on' : 'pilot off') : undefined}
            tone={isAvailable(o.reactivation) && o.reactivation.value.pilotEnabled ? 'success' : 'neutral'}
          />
        ) : null}
        {show('organization.settings') ? (
          <Stat
            label="Config problems"
            href="/settings"
            value={String(o.environment.productionProblems)}
            tone={o.environment.productionProblems > 0 ? 'warning' : 'success'}
          />
        ) : null}
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
