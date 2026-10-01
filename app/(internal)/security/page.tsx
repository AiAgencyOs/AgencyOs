import type { Metadata } from 'next';
import Link from 'next/link';

import { agencyClock } from '@/lib/admin/agency-clock';
import { getSecurityPosture } from '@/lib/admin/security';
import { isClean, securityChecks } from '@/lib/admin/security-eval';
import { countAuditEntries } from '@/lib/audit/count-queries';
import { actorNames, readAuditPage } from '@/lib/audit/queries';
import { PRIVILEGED_ACTIONS } from '@/lib/audit/links';
import { attachReasons, CHANGE_REASON_ACTION } from '@/lib/audit/privileged';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { countOpenIncidents } from '@/modules/identity/incidents-queries';
import { listInternalRosterWithRoles } from '@/modules/projects/queries';
import { Badge, Callout, Card, CardHeader, cx, IconAlert, IconCheck, PageHeader, Stat, StatGrid, TONE_DOT, PermissionDenied } from '@/ui';

import { PermissionMatrix } from './permission-matrix';

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
  if (!can(context, 'audit.read')) return <PermissionDenied />;

  const clock = await agencyClock();
  // SCR-069: users / roles / audit-count KPIs and the recent privileged
  // changes, each from a read that already exists (the roster, the audit
  // trail under its `membership.` actions, the trail's own count). The
  // roster read is admin-scoped by RLS; a non-admin sees the posture alone.
  const isAdmin = can(context, 'organization.settings');
  const [posture, roster, auditCount, privileged, reasonEntries, openIncidents] = await Promise.all([
    getSecurityPosture(),
    isAdmin ? listInternalRosterWithRoles() : Promise.resolve([]),
    countAuditEntries(),
    readAuditPage({ actions: PRIVILEGED_ACTIONS, pageSize: 20 }).then((r) => r.entries),
    // The reason each author gave, appended beside the change (the doors themselves take none).
    readAuditPage({ actions: [CHANGE_REASON_ACTION], pageSize: 100, withCount: false }).then((r) => r.entries),
    // SCR-069: incidents a person opened and has not resolved.
    countOpenIncidents(),
  ]);
  // Actor and subject as people: the actor by name, the subject membership by its holder's name.
  const actorLabel = await actorNames(privileged.map((e) => e.actorId));
  const memberName = new Map(roster.map((m) => [m.membershipId, m.fullName]));
  const reasonOf = attachReasons(privileged, reasonEntries);
  const checks = securityChecks(posture);
  const clean = isClean(posture);
  const failing = checks.filter((c) => !c.ok).length;
  const rolesHeld = new Set<string>();
  for (const m of roster) {
    rolesHeld.add(m.role);
    for (const r of m.secondaryRoles ?? []) rolesHeld.add(r);
  }

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

      <StatGrid>
        <Stat label="Users" value={isAdmin ? String(roster.length) : '—'} caption={isAdmin ? 'Internal memberships' : 'Admin only'} tone="brand" href="/security/users" />
        <Stat label="Roles held" value={isAdmin ? String(rolesHeld.size) : '—'} caption={isAdmin ? [...rolesHeld].map((r) => r.replace('_', ' ')).join(' · ') || 'None' : 'Admin only'} tone="info" href="/security/users" />
        <Stat label="Audit entries" value={String(auditCount)} caption="Appended, never edited" tone="neutral" href="/audit" />
        <Stat label="Invariants" value={`${checks.length - failing}/${checks.length}`} caption={clean ? 'All hold' : `${failing} regressed`} tone={clean ? 'success' : 'danger'} />
        <Stat label="Open incidents" value={String(openIncidents)} caption="Security incidents awaiting resolution" tone={openIncidents > 0 ? 'danger' : 'success'} href="/security/incidents" />
      </StatGrid>

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
                  {c.offenders.map((o, i) => (
                    <li key={`${i}-${o}`} className="font-mono text-xs break-all text-danger">
                      {o}
                    </li>
                  ))}
                </ul>
              ) : null}
            </Card>
          </li>
        ))}
      </ul>

      <Card>
        <CardHeader
          title="Recent privileged changes"
          description="Who was suspended, reinstated, or had a second role added or removed — by whom, the change itself, and the reason when one was recorded. Department edits are not listed here."
          actions={
            <Link href="/audit?action=membership." className="text-[13px] font-medium text-brand underline-offset-2 hover:underline">
              Full trail
            </Link>
          }
        />
        {privileged.length === 0 ? (
          <p className="px-4 py-4 text-[13px] text-muted sm:px-5">No membership or role change has been recorded.</p>
        ) : (
          <ul className="divide-y divide-line">
            {privileged.map((e) => {
              const reason = reasonOf.get(e.id) ?? null;
              const who = e.subjectId ? (memberName.get(e.subjectId) ?? `membership ${e.subjectId.slice(0, 8)}`) : 'a member';
              const change =
                e.action === 'membership.status_changed'
                  ? `${String(e.before?.status ?? '—')} → ${String(e.after?.status ?? '—')}`
                  : e.action === 'membership.secondary_role_granted'
                    ? `role added: ${String(e.after?.role ?? '—').replace('_', ' ')}`
                    : e.action === 'membership.secondary_role_revoked'
                      ? `role removed: ${String(e.before?.role ?? e.after?.role ?? '—').replace('_', ' ')}`
                      : e.action;
              return (
                <li key={e.id} className="flex flex-wrap items-start justify-between gap-2 px-4 py-2.5 text-[13px] sm:px-5">
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{who}</span>
                      <Badge tone="info">{change}</Badge>
                    </span>
                    <span className="text-xs text-muted">{reason ? `Reason: ${reason}` : 'No reason recorded'}</span>
                  </span>
                  <span className="flex flex-wrap items-center gap-2 text-xs text-muted">
                    by {e.actorId ? (actorLabel.get(e.actorId) ?? `${e.actorId.slice(0, 8)} (account removed)`) : (e.actorType ?? 'the system')} · {clock.dateTime(e.createdAt)}
                    {/* SCR-069: investigate a security event — open an incident with this entry as evidence. */}
                    <Link href={`/security/incidents?audit=${e.id}&evidence=${encodeURIComponent(`Audit #${e.id}: ${e.action} on ${e.subjectType ?? 'unknown'} ${e.subjectId ?? ''}`)}`} className="font-medium text-brand underline-offset-2 hover:underline">
                      Investigate
                    </Link>
                    <Link href={`/audit?q=${encodeURIComponent(e.action)}`} className="font-medium text-brand underline-offset-2 hover:underline">
                      In the audit log
                    </Link>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Permission matrix"
          description="Which role holds which capability, from the same table every page and service checks. Read-only — a change is a code review."
        />
        <PermissionMatrix />
      </Card>

      <p className="text-xs leading-relaxed text-muted">
        Tenant isolation and consent enforcement are also proven continuously by the live
        verification suite (<code className="font-mono">db:verify:*</code>) on every change. For the
        record of who changed what and when, see the{' '}
        <Link href="/audit" className="font-medium text-brand underline-offset-2 hover:underline">
          Audit log
        </Link>
        . To see or change who holds which role, see{' '}
        <Link href="/security/users" className="font-medium text-brand underline-offset-2 hover:underline">
          Users &amp; roles
        </Link>
        .
      </p>
    </div>
  );
}
