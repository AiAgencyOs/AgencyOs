import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { getSecurityPosture } from '@/lib/admin/security';
import { isClean, securityChecks } from '@/lib/admin/security-eval';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';

export const metadata: Metadata = { title: 'Security · AgencyOS' };

/**
 * Security Center — the deployment's structural invariants, shown as evidence,
 * not a score. Each check is a live catalogue scan (the same three CI enforces
 * on every migration): every cross-tenant FK is guarded, every org-scoped table
 * freezes its tenant, no write path is silently broken by RLS. Green means the
 * scan found zero violations; a red check names exactly what regressed. There is
 * no invented "security score" here. Gated on `audit.read` (owner + ops_admin);
 * the RPC re-checks the same authority in the database.
 *
 * The event trail (who changed what, when) lives on the Audit page, linked below.
 */
export default async function SecurityPage() {
  const context = await requireInternal('/security');
  if (!can(context.role, 'audit.read')) redirect('/dashboard');

  const posture = await getSecurityPosture();
  const checks = securityChecks(posture);
  const clean = isClean(posture);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Security</h1>
        <p className="text-sm text-muted">
          The deployment&rsquo;s structural invariants, from a live catalogue scan — the same checks enforced on every
          migration. Evidence, not a score: a check is green only when the scan finds zero violations.
        </p>
      </div>

      <div
        className={`rounded-lg border px-4 py-3 text-sm ${
          clean ? 'border-green-500/30 text-green-700 dark:text-green-400' : 'border-red-500/30 text-red-700 dark:text-red-400'
        }`}
      >
        {clean
          ? 'Every structural security invariant holds — no violations found in the live scan.'
          : `${checks.filter((c) => !c.ok).length} invariant(s) regressed — details below.`}
      </div>

      <ul className="flex flex-col gap-3">
        {checks.map((c) => (
          <li key={c.id} className="rounded-lg border border-black/10 px-4 py-3 dark:border-white/15">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="flex items-center gap-2 text-sm font-medium">
                <span className={`inline-block h-2 w-2 rounded-full ${c.ok ? 'bg-green-500' : 'bg-red-500'}`} aria-hidden />
                {c.title}
              </span>
              <span className={`text-xs ${c.ok ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                {c.ok ? 'holds' : `${c.count} violation${c.count === 1 ? '' : 's'}`}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted">{c.meaning}</p>
            {!c.ok ? (
              <ul className="mt-2 flex flex-col gap-1">
                {c.offenders.map((o) => (
                  <li key={o} className="font-mono text-xs text-red-600 dark:text-red-400">
                    {o}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>

      <p className="text-xs text-muted">
        Tenant isolation and consent enforcement are also proven continuously by the live verification suite
        (`db:verify:*`) on every change. For the record of who changed what and when, see the{' '}
        <a href="/audit" className="underline hover:text-foreground">
          Audit log
        </a>
        .
      </p>
    </div>
  );
}
