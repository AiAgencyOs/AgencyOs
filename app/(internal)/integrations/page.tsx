import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { getIntegrations } from '@/lib/admin/integrations';
import type { Lifecycle } from '@/lib/admin/integrations-eval';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { PageHeader } from '@/ui';

export const metadata: Metadata = { title: 'Integrations' };

/**
 * The integration registry — every external dependency in one place, each with
 * its real lifecycle state. The rule the spec insists on is enforced by the
 * evaluator, not the copy: CONFIGURED is never VERIFIED. Only the database and
 * scheduler — which a live signal actually exercised — can read VERIFIED;
 * WhatsApp and the AI provider are CONFIGURED at most, and the row links to the
 * page where a person can verify them. Gated on `organization.settings` (owner).
 */

const STYLE: Record<Lifecycle, { dot: string; text: string }> = {
  VERIFIED: {dot: 'bg-success', text: 'text-success'},
  CONFIGURED: {dot: 'bg-warning', text: 'text-warning'},
  DEGRADED: {dot: 'bg-warning', text: 'text-warning'},
  NOT_CONFIGURED: { dot: 'bg-neutral-400', text: 'text-muted' },
  FAILED: {dot: 'bg-danger', text: 'text-danger'},
  DISABLED: { dot: 'bg-neutral-400', text: 'text-muted' },
};

export default async function IntegrationsPage() {
  const context = await requireInternal('/integrations');
  if (!can(context.role, 'organization.settings')) redirect('/dashboard');

  const { integrations, summary } = await getIntegrations();

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={<>Integrations</>}
        description={
          <>
        Every external dependency and its real lifecycle. <span className="font-medium">Configured is not verified</span> —
        only the database and scheduler, which a live signal exercised, read VERIFIED; WhatsApp and the AI provider are
        configured at most until a person verifies them.
          </>
        }
      />

      <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
        {(['VERIFIED', 'CONFIGURED', 'DEGRADED', 'NOT_CONFIGURED', 'FAILED', 'DISABLED'] as Lifecycle[]).map((lc) => (
          <div key={lc} className="rounded-lg border border-line bg-surface px-3 py-2">
            <div className={`text-lg font-semibold tabular ${STYLE[lc].text}`}>{summary[lc] ?? 0}</div>
            <div className="text-[10px] uppercase tracking-wide text-muted">{lc.replace('_', ' ')}</div>
          </div>
        ))}
      </div>

      <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface">
        {integrations.map((i) => (
          <li key={i.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-4 py-3 text-sm">
            <div className="flex flex-col">
              <a href={i.href} className="flex items-center gap-2 font-medium hover:underline">
                <span className={`inline-block h-2 w-2 rounded-full ${STYLE[i.lifecycle].dot}`} aria-hidden />
                {i.name}
              </a>
              <span className="text-xs text-muted">
                {i.category} · {i.detail}
              </span>
            </div>
            <span className="flex items-center gap-2 text-xs">
              <span className={STYLE[i.lifecycle].text}>{i.lifecycle.replace('_', ' ')}</span>
              {i.external ? (
                <span className="rounded border border-line bg-surface px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                  external
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>

      <p className="text-xs text-muted">
        A failed row means a live read did not succeed (DATA UNAVAILABLE) — not that the integration is definitely broken,
        but that this page could not confirm it. Verify from the linked page.
      </p>
    </div>
  );
}
