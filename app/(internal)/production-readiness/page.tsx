import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { getProductionReadiness } from '@/lib/admin/production-readiness';
import type { ReadinessStatus } from '@/lib/admin/production-readiness-eval';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { PageHeader } from '@/ui';

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

export default async function ProductionReadinessPage() {
  const context = await requireInternal('/production-readiness');
  if (!can(context.role, 'organization.settings')) redirect('/dashboard');

  const { checks, summary } = await getProductionReadiness();
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

      <div
        className={`rounded-lg border px-4 py-3 text-sm ${summary.ready ? 'border-warning/30 text-warning' : 'border-danger/30 text-danger'}`}
      >
        {summary.red > 0 || summary.unknown > 0
          ? `NOT production ready — ${summary.red} blocking, ${summary.unknown} unknown, ${summary.yellow} awaiting verification.`
          : `No hard blockers, but ${summary.yellow} item(s) still need verification before go-live. Configured is not proven.`}
      </div>

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
