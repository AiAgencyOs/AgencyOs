import type { Metadata } from 'next';

import { agencyClock } from '@/lib/admin/agency-clock';
import { getIntegrations } from '@/lib/admin/integrations';
import { getProductionReadiness } from '@/lib/admin/production-readiness';
import { lastAlertTest } from '@/lib/observability/alert-destination';
import { readinessSentence, type ReadinessStatus } from '@/lib/admin/production-readiness-eval';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { Card, CardHeader, IntegrationState, PageHeader, PermissionDenied } from '@/ui';

import { RunVerificationForm, TestAlertDestinationForm } from './verification-forms';

export const metadata: Metadata = { title: 'Production readiness' };

/**
 * Is production actually ready? — answered from evidence, not from configuration
 * existing. Each check carries what was observed and how to fix it, and is GREEN
 * only when the evidence supports it: a configured-but-unverified WhatsApp or AI
 * provider is YELLOW, and a signal that could not be read is UNKNOWN — never
 * green. Gated on `organization.settings` (owner), like the rest of the config
 * surface.
 */

const DOT: Record<ReadinessStatus, { color: string; label: string }> = {
  green: { color: 'bg-success', label: 'Ready' },
  yellow: { color: 'bg-warning', label: 'Needs verification' },
  red: { color: 'bg-danger', label: 'Not ready' },
  unknown: { color: 'bg-neutral-400', label: 'Unavailable' },
};

const TEXT: Record<ReadinessStatus, string> = {
  green: 'text-success',
  yellow: 'text-warning',
  red: 'text-danger',
  unknown: 'text-muted',
};

const BANNER = {
  danger: 'border-danger/30 text-danger',
  warning: 'border-warning/30 text-warning',
  success: 'border-success/30 text-success',
} as const;

export default async function ProductionReadinessPage() {
  const context = await requireInternal('/production-readiness');
  if (!can(context, 'organization.settings')) return <PermissionDenied />;

  const [{ checks, summary }, { integrations, lastVerifiedAt }, alertTest, clock] = await Promise.all([getProductionReadiness(), getIntegrations(), lastAlertTest(), agencyClock()]);
  // "Last live checks": the moment each live check last answered, from the moments the verify actions recorded.
  const liveChecks = integrations.filter((i) => ['whatsapp', 'ai-provider', 'calendar', 'figma'].includes(i.id));
  const sentence = readinessSentence(summary);
  const order: ReadinessStatus[] = ['red', 'unknown', 'yellow', 'green'];
  const sorted = [...checks].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={<>Production readiness</>}
        description={
          <>
        Each item is green only when the evidence supports it. Configured is not verified — WhatsApp and the AI
        provider stay amber until a person confirms them against the real provider.
          </>
        }
      />

      <div className={`rounded-lg border px-4 py-3 text-sm ${BANNER[sentence.tone]}`}>{sentence.text}</div>

      {/* SCR-067: run every live check the panel can run, and say when each last answered. */}
      <Card>
        <CardHeader
          title="Live Checks"
          description={lastVerifiedAt ? `Last live check answered ${clock.dateTime(lastVerifiedAt)}.` : 'No live check has a recorded answer yet. Configured is not verified.'}
        />
        <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
          <RunVerificationForm />
          <ul className="flex flex-col gap-1 text-[13px]">
            {liveChecks.map((i) => (
              <li key={i.id} className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">{i.name}</span>
                <span className="text-xs text-muted">{i.lastVerifiedAt ? `last answered ${clock.dateTime(i.lastVerifiedAt)}` : `never verified — ${i.lifecycle === 'NOT_CONFIGURED' ? 'not configured' : 'configured, unproven'}`}</span>
              </li>
            ))}
          </ul>
          <div className="flex flex-col gap-1 border-t border-line pt-3">
            <span className="text-[13px] font-medium">Alert destination</span>
            <TestAlertDestinationForm last={alertTest ? `last test ${clock.dateTime(alertTest.at)} — ${alertTest.ok ? 'delivered' : (alertTest.reason ?? 'not delivered')}` : 'never tested'} />
          </div>
        </div>
      </Card>

      {/* The shared IntegrationState callout (bucket F) for every external
          dependency that is not green — the same component Integrations
          uses, so an unverified WhatsApp reads the same on both pages. */}
      {sorted.filter((c) => c.external && c.status !== 'green').length > 0 ? (
        <div className="flex flex-col gap-2">
          {sorted
            .filter((c) => c.external && c.status !== 'green')
            .map((c) => (
              <IntegrationState
                key={c.id}
                name={c.title}
                lifecycle={c.status === 'unknown' ? 'UNKNOWN' : c.status === 'red' ? 'NOT_CONFIGURED' : 'CONFIGURED'}
                detail={`${c.evidence} Fix: ${c.remediation}`}
                href="/integrations"
                actionLabel="Open integrations"
              />
            ))}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(['red', 'unknown', 'yellow', 'green'] as ReadinessStatus[]).map((st) => (
          <div key={st} className="rounded-lg border border-line bg-surface px-3 py-2">
            <div className={`text-lg font-semibold tabular ${TEXT[st]}`}>{summary[st === 'unknown' ? 'unknown' : st]}</div>
            <div className="text-xs text-muted">{DOT[st].label}</div>
          </div>
        ))}
      </div>

      <ul className="flex flex-col gap-3">
        {sorted.map((c) => (
          <li key={c.id} className="rounded-lg border border-line bg-surface px-4 py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="flex items-center gap-2 text-sm font-medium">
                <span className={`inline-block h-2 w-2 rounded-full ${DOT[c.status].color}`} aria-hidden />
                {c.title}
              </span>
              <span className="flex items-center gap-2 text-xs">
                <span className={TEXT[c.status]}>{DOT[c.status].label}</span>
                {c.external ? (
                  <span className="rounded border border-line bg-surface px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                    external
                  </span>
                ) : null}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted">
              <span className="font-medium">Evidence:</span> {c.evidence}
            </p>
            {c.status !== 'green' ? (
              <p className="mt-0.5 text-xs text-muted">
                <span className="font-medium">Fix:</span> {c.remediation}
              </p>
            ) : null}
          </li>
        ))}
      </ul>

      <p className="text-xs text-muted">
        Never marked ready because a setting exists. A real go-live also needs the external verifications (Meta/WhatsApp,
        AI provider, a real test send to a configured internal recipient) that this page can flag but not perform.
      </p>
    </div>
  );
}
