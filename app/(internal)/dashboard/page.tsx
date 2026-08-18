import type { Metadata } from 'next';

import { getOverview } from '@/lib/admin/overview';
import { isAvailable, levelLabel, overallStatus, type Avail } from '@/lib/admin/overview-eval';
import { requireInternal } from '@/lib/auth/session';
import { can, type Capability } from '@/lib/authz/permissions';

export const metadata: Metadata = { title: 'Overview · AgencyOS' };

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
 */

const TONE: Record<string, string> = {
  good: 'text-green-600 dark:text-green-400',
  warn: 'text-amber-600 dark:text-amber-400',
  bad: 'text-red-600 dark:text-red-400',
  muted: 'text-muted',
};

function Tile({
  label,
  value,
  sub,
  href,
  tone = 'muted',
}: {
  label: string;
  value: string;
  sub?: string;
  href?: string;
  tone?: 'good' | 'warn' | 'bad' | 'muted';
}) {
  const body = (
    <>
      <div className={`text-2xl font-semibold tabular-nums ${value === 'DATA UNAVAILABLE' ? 'text-sm font-normal text-red-600 dark:text-red-400' : ''}`}>
        {value}
      </div>
      <div className="mt-0.5 text-xs text-muted">{label}</div>
      {sub ? <div className={`mt-0.5 text-xs ${TONE[tone]}`}>{sub}</div> : null}
    </>
  );
  const className = 'block rounded-lg border border-black/10 px-4 py-3 dark:border-white/15';
  return href ? (
    <a href={href} className={`${className} transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.03]`}>
      {body}
    </a>
  ) : (
    <div className={className}>{body}</div>
  );
}

/** A value tile that honours the read: number when read, DATA UNAVAILABLE when not. */
function num<T>(a: Avail<T>, pick: (v: T) => string): string {
  return isAvailable(a) ? pick(a.value) : 'DATA UNAVAILABLE';
}

function HealthRow({ label, state }: { label: string; state: { text: string; tone: 'good' | 'warn' | 'bad' | 'muted' } }) {
  return (
    <li className="flex items-center justify-between px-4 py-2.5 text-sm">
      <span>{label}</span>
      <span className={`text-xs ${TONE[state.tone]}`}>{state.text}</span>
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
        ? { text: `${o.cronAgeSeconds > 3600 ? `${Math.floor(o.cronAgeSeconds / 3600)}h` : `${Math.floor(o.cronAgeSeconds / 60)}m`} ago — may be stopped`, tone: 'bad' as const }
        : { text: 'ticking', tone: 'good' as const };

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight">Overview</h1>
          <p className="text-sm text-muted">
            Signed in as {context.email} · environment <span className="font-mono">{o.environment.nodeEnv}</span>
            {o.environment.looksLocal ? ' · local' : ''}
          </p>
        </div>
        <span className={`rounded-full border px-3 py-1 text-xs font-medium ${TONE[label.tone]} border-current/30`}>
          ● {label.text}
        </span>
      </div>

      {/* Operational KPI tiles — real reads only, each linking to its detail page. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {show('audit.read') ? (
          <Tile
            label="Dead jobs"
            href="/operations"
            value={num(o.backlog, (b) => String(b.dead_jobs))}
            tone={isAvailable(o.backlog) && o.backlog.value.dead_jobs > 0 ? 'bad' : 'muted'}
          />
        ) : null}
        {show('audit.read') ? (
          <Tile
            label="Failed deliveries"
            href="/operations"
            value={num(o.failedDeliveries, String)}
            tone={isAvailable(o.failedDeliveries) && o.failedDeliveries.value > 0 ? 'bad' : 'muted'}
          />
        ) : null}
        <Tile
          label="Pending approvals"
          href="/approvals"
          value={num(o.approvals, (a) => String(a.pending))}
          sub={isAvailable(o.approvals) && o.approvals.value.overdue > 0 ? `${o.approvals.value.overdue} overdue` : undefined}
          tone={isAvailable(o.approvals) && o.approvals.value.overdue > 0 ? 'warn' : 'muted'}
        />
        {show('audit.read') ? (
          <Tile label="Agents runnable" href="/agents" value={num(o.ai, (a) => `${a.agentsRunnable}/${a.agentsTotal}`)} />
        ) : null}
        {show('organization.settings') ? (
          <Tile
            label="Reactivation enrolled"
            href="/import"
            value={num(o.reactivation, (r) => String(r.enrolled))}
            sub={isAvailable(o.reactivation) ? (o.reactivation.value.pilotEnabled ? 'pilot on' : 'pilot off') : undefined}
            tone={isAvailable(o.reactivation) && o.reactivation.value.pilotEnabled ? 'good' : 'muted'}
          />
        ) : null}
        {show('organization.settings') ? (
          <Tile
            label="Config problems"
            href="/settings"
            value={String(o.environment.productionProblems)}
            tone={o.environment.productionProblems > 0 ? 'warn' : 'good'}
          />
        ) : null}
      </div>

      {status.level !== 'operational' ? (
        <div className={`rounded-lg border border-current/30 px-4 py-3 text-sm ${TONE[label.tone]}`}>{status.reason}</div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* System health — each row reflects a real read, or admits it can't. */}
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">System health</h2>
          <ul className="divide-y divide-black/5 rounded-lg border border-black/10 dark:divide-white/5 dark:border-white/15">
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
          <p className="text-xs text-muted">
            Configured is not verified. Confirm WhatsApp and the AI provider from their pages before relying on them.
          </p>
        </section>

        {/* Where to go next — capability-gated links into the control plane. */}
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">Control plane</h2>
          <ul className="divide-y divide-black/5 rounded-lg border border-black/10 dark:divide-white/5 dark:border-white/15">
            {(
              [
                ['Production readiness — is it safe to go live?', '/production-readiness', 'organization.settings'],
                ['Integrations — every dependency & its lifecycle', '/integrations', 'organization.settings'],
                ['Security — structural invariants, live', '/security', 'audit.read'],
                ['Operations — jobs, outbox, failed deliveries', '/operations', 'audit.read'],
                ['Approvals — what needs a decision', '/approvals', null],
                ['Agents — registry & provider posture', '/agents', 'audit.read'],
                ['Usage & costs — what the agents consumed', '/usage', 'audit.read'],
                ['Audit log — who changed what', '/audit', 'audit.read'],
                ['Import — historical-lead review desk', '/import', 'organization.settings'],
                ['Settings — configuration & reactivation', '/settings', 'organization.settings'],
              ] as [string, string, Capability | null][]
            )
              .filter(([, , cap]) => cap === null || show(cap))
              .map(([text, href]) => (
                <li key={href}>
                  <a href={href} className="flex items-center justify-between px-4 py-2.5 text-sm hover:bg-black/[0.03] dark:hover:bg-white/[0.03]">
                    <span>{text}</span>
                    <span className="text-muted">→</span>
                  </a>
                </li>
              ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
