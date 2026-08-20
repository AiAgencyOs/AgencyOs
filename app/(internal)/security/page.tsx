import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { getSecurityPosture } from '@/lib/admin/security';
import { isClean, securityChecks } from '@/lib/admin/security-eval';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { Badge, Callout, Card, cx, IconAlert, IconCheck, PageHeader, TONE_DOT } from '@/ui';

export const metadata: Metadata = { title: 'Security' };

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
  const failing = checks.filter((c) => !c.ok).length;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Security"
        description="The deployment’s structural invariants, from a live catalogue scan — the same checks enforced on every migration. Evidence, not a score: a check is green only when the scan finds zero violations."
        meta={
          <Badge tone={clean ? 'success' : 'danger'} dot>
            {clean ? 'All invariants hold' : `${failing} regressed`}
          </Badge>
        }
      />

      <Callout
        tone={clean ? 'success' : 'danger'}
        icon={clean ? <IconCheck size={16} /> : <IconAlert size={16} />}
      >
        {clean
          ? 'Every structural security invariant holds — no violations found in the live scan.'
          : `${failing} invariant(s) regressed — details below.`}
      </Callout>

      <ul className="flex flex-col gap-3">
        {checks.map((c) => (
          <li key={c.id}>
            <Card className="p-4 sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <span className="flex items-center gap-2.5 text-sm font-semibold">
                  <span
                    className={cx(
                      'inline-block h-2 w-2 shrink-0 rounded-full',
                      c.ok ? TONE_DOT.success : TONE_DOT.danger,
                    )}
                    aria-hidden
                  />
                  {c.title}
                </span>
                <Badge tone={c.ok ? 'success' : 'danger'}>
                  {c.ok ? 'holds' : `${c.count} violation${c.count === 1 ? '' : 's'}`}
                </Badge>
              </div>
              <p className="mt-1.5 pl-[18px] text-[13px] leading-relaxed text-muted">{c.meaning}</p>
              {!c.ok ? (
                <ul className="mt-3 flex flex-col gap-1 rounded-lg bg-danger-soft p-3">
                  {c.offenders.map((o) => (
                    <li key={o} className="font-mono text-xs break-all text-danger">
                      {o}
                    </li>
                  ))}
                </ul>
              ) : null}
            </Card>
          </li>
        ))}
      </ul>

      <p className="text-xs leading-relaxed text-muted">
        Tenant isolation and consent enforcement are also proven continuously by the live
        verification suite (<code className="font-mono">db:verify:*</code>) on every change. For the
        record of who changed what and when, see the{' '}
        <Link href="/audit" className="font-medium text-brand underline-offset-2 hover:underline">
          Audit log
        </Link>
        .
      </p>
    </div>
  );
}
