import type { Metadata } from 'next';
import Link from 'next/link';

import { agencyClock } from '@/lib/admin/agency-clock';
import { listOverrideKinds, listOverrides, overrideKindLabel } from '@/lib/admin/overrides';
import { requireInternal } from '@/lib/auth/session';
import { can, hasRole } from '@/lib/authz/permissions';
import { listKillSwitches } from '@/lib/observability/kill-switches';
import { Badge, Card, CardHeader, EmptyState, FilterBar, FilterChips, IconAlert, IconLock, PageHeader, PermissionDenied, Stat, StatGrid, type FilterChipOption } from '@/ui';

import { KillSwitchPanel } from '../../operations/kill-switch-panel';
import { ManualOverrideForm } from './manual-override-form';

export const metadata: Metadata = { title: 'Overrides & emergency controls' };

/**
 * The override centre and the emergency controls — SCR-068.
 *
 * Every domain override lands in `core.overrides` by a trigger on the audit
 * trail, in the transaction that took it: a project started before it was
 * ready (`projects.start_project` with a reason), a scope baseline unfrozen
 * (`projects.unfreeze_scope_version`), a release signed off over an unpaid
 * invoice (stream F-E's door, when present). This page reads that record —
 * it is not a second form for those — and adds the one write no domain door
 * covers: an exception recorded with a reason, owner only.
 *
 * Beneath it the three emergency controls (`core.kill_switches`), owner
 * only with a reason, honoured where work is claimed and where every send
 * passes. The same panel the Operations page shows read-only.
 *
 * Gated on `audit.read` (owner, ops_admin): the record of who set a rule
 * aside is the same class of information as the audit trail.
 */
export default async function OverrideCentrePage({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  const context = await requireInternal('/governance/overrides');
  if (!can(context, 'audit.read')) return <PermissionDenied />;
  const clock = await agencyClock();
  const isOwner = hasRole(context, 'owner');

  const { kind } = await searchParams;
  const [overrides, kinds, switches] = await Promise.all([listOverrides({ kind: kind || undefined }), listOverrideKinds(), listKillSwitches()]);
  const engaged = switches.filter((s) => s.active).length;
  const now = Date.now();
  const inForce = overrides.filter((o) => !o.expiresAt || Date.parse(o.expiresAt) > now).length;

  const chips: FilterChipOption[] = [
    { key: 'all', label: 'All kinds', href: '/governance/overrides', active: !kind },
    ...kinds.map((k) => ({ key: k, label: overrideKindLabel(k), href: `/governance/overrides?kind=${encodeURIComponent(k)}`, active: kind === k })),
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Overrides & emergency controls"
        description="Every time a person set a rule aside, with the reason they gave — recorded in the same transaction as the override itself — and the three switches that stop the system in an emergency."
        meta={
          <Badge tone={engaged > 0 ? 'danger' : 'success'} dot>
            {engaged > 0 ? `${engaged} emergency control${engaged === 1 ? '' : 's'} engaged` : 'No emergency control engaged'}
          </Badge>
        }
      />

      <StatGrid>
        <Stat label="Overrides on record" value={String(overrides.length)} caption={kind ? `Of kind ${overrideKindLabel(kind)}` : 'Most recent 200'} tone="brand" icon={<IconLock size={16} />} />
        <Stat label="In force" value={String(inForce)} caption="Not expired" tone={inForce > 0 ? 'warning' : 'neutral'} icon={<IconLock size={16} />} />
        <Stat label="Emergency controls" value={`${engaged}/${switches.length}`} caption={engaged > 0 ? 'engaged' : 'all released'} tone={engaged > 0 ? 'danger' : 'success'} icon={<IconAlert size={16} />} href="#emergency" />
        <Stat label="Kinds seen" value={String(kinds.length)} caption="Distinct kinds on record" tone="info" icon={<IconLock size={16} />} />
      </StatGrid>

      <Card id="emergency">
        <CardHeader
          title="Emergency controls"
          description={isOwner ? 'Engage or release with a reason. Each is honoured by the runner and the send chokepoint from the next tick, and audited.' : 'The owner engages or releases these with a reason; shown read-only for your role.'}
        />
        <KillSwitchPanel switches={switches.map((s) => ({ ...s, setAtLabel: s.setAt ? clock.dateTime(s.setAt) : null }))} editable={isOwner} />
      </Card>

      <Card>
        <CardHeader title="Record an exception" description={isOwner ? 'For a rule set aside that no domain door records on its own. Owner only, reason required, audited.' : 'Recording an exception is the owner’s alone.'} />
        {isOwner ? <ManualOverrideForm /> : null}
      </Card>

      {kinds.length > 0 ? (
        <FilterBar>
          <FilterChips options={chips} />
        </FilterBar>
      ) : null}

      <Card>
        <CardHeader title="Override record" description="Newest first. A domain override links to the record it was taken on." />
        {overrides.length === 0 ? (
          <div className="px-4 pb-4 sm:px-5">
            <EmptyState icon={<IconLock size={20} />} title={kind ? 'No override of that kind' : 'No override has been recorded'} description="A project started before it was ready, a scope baseline unfrozen or an exception recorded above appears here the moment it happens." />
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {overrides.map((o) => {
              const expired = o.expiresAt ? Date.parse(o.expiresAt) <= now : false;
              const href = o.subjectType === 'project' && o.subjectId ? `/projects/${o.subjectId}` : o.subjectType === 'scope_version' && o.subjectId ? `/audit?subject=scope_version` : null;
              return (
                <li key={o.id} className="flex flex-col gap-1 px-4 py-3 text-[13px] sm:px-5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex flex-wrap items-center gap-2">
                      <Badge tone={o.kind.startsWith('manual.') ? 'info' : 'warning'}>{overrideKindLabel(o.kind)}</Badge>
                      <span className="text-muted">
                        {o.subjectType}
                        {o.subjectId ? (
                          href ? (
                            <Link href={href} className="ml-1 font-mono text-xs underline-offset-2 hover:underline">
                              {o.subjectId.slice(0, 8)}
                            </Link>
                          ) : (
                            <span className="ml-1 font-mono text-xs">{o.subjectId.slice(0, 8)}</span>
                          )
                        ) : null}
                      </span>
                      {expired ? <Badge tone="neutral">expired</Badge> : o.expiresAt ? <Badge tone="warning">until {clock.dateTime(o.expiresAt)}</Badge> : null}
                    </span>
                    <span className="text-xs text-muted">
                      {o.actorName ?? 'system'} · {clock.dateTime(o.createdAt)}
                    </span>
                  </div>
                  <p className="break-words text-muted">“{o.reason}”</p>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <p className="text-xs leading-relaxed text-muted">
        Scoped to your organisation (RLS). The domain overrides themselves are taken on their own pages — a project&apos;s start, a scope
        baseline, a release — and appear here because the audit trail records them; nothing here edits one.
      </p>
    </div>
  );
}
