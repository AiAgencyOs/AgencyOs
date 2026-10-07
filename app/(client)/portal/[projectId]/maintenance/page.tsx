import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireClient } from '@/lib/auth/session';
import { readClientMaintenance } from '@/modules/portal/maintenance-queries';
import { readClientProject } from '@/modules/portal/queries';
import { IconArrowLeft } from '@/ui';

export const metadata: Metadata = { title: 'Your maintenance plan' };

const left = (entitled: number | null, used: number | null) => (entitled === null ? null : Math.max(entitled - (used ?? 0), 0));

/**
 * Your maintenance plan: what is included each period, what has been used, and what is beyond it. This page shows facts only. It does not quote, bill or
 * renew anything: your project contact does that with you, and nothing changes without your agreement.
 */
export default async function PortalMaintenancePage({ params }: { params: Promise<{ projectId: string }> }) {
  await requireClient();
  const clock = await agencyClock();
  const { projectId } = await params;
  const project = await readClientProject(projectId);
  if (!project) notFound();
  const plans = await readClientMaintenance(projectId);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <div className="flex flex-col gap-1">
        <Link href={`/portal/${projectId}`} className="flex w-fit items-center gap-1.5 text-[13px] text-muted hover:text-foreground">
          <IconArrowLeft size={14} />
          {project.name}
        </Link>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Your maintenance plan</h1>
        <p className="text-sm text-muted">What is included, what has been used, and anything beyond it. Your project contact discusses any change with you first.</p>
      </div>
      {plans.length === 0 ? (
        <p className="text-sm text-muted">There is no maintenance plan on this project yet.</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {plans.map((p) => (
            <li key={p.planId} className="flex flex-col gap-2 rounded-lg border border-line bg-surface px-4 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-[15px] font-medium">{p.name}</h2>
                <span className="text-[12px] text-muted">{p.statusLabel}</span>
              </div>
              {p.cycleStartsOn && p.cycleEndsOn ? <p className="text-sm">Current period: {clock.date(p.cycleStartsOn)} to {clock.date(p.cycleEndsOn)}</p> : null}
              {p.entitledHours !== null ? <p className="text-sm">Hours: {p.usedHours ?? 0} used of {p.entitledHours} included ({left(p.entitledHours, p.usedHours)} left){p.hoursBeyondIncluded ? `; ${p.hoursBeyondIncluded} beyond what is included` : ''}</p> : null}
              {p.entitledRequests !== null ? <p className="text-sm">Requests: {p.usedRequests ?? 0} used of {p.entitledRequests} included ({left(p.entitledRequests, p.usedRequests)} left){p.requestsBeyondIncluded ? `; ${p.requestsBeyondIncluded} beyond what is included` : ''}</p> : null}
              {p.usage.length > 0 ? (
                <ul className="text-[13px] text-muted">
                  {p.usage.slice(0, 20).map((u, i) => (
                    <li key={`${p.planId}-${u.occurredOn}-${i}`}>{clock.date(u.occurredOn)}: {u.type === 'reversal' ? 'corrected, -' : ''}{u.quantity} {u.kind === 'hours' ? 'hours' : 'request(s)'}</li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
