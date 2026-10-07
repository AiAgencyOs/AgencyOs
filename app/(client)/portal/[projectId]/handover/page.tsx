import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireClient } from '@/lib/auth/session';
import { readClientProject } from '@/modules/portal/queries';
import { readClientHandover } from '@/modules/portal/handover-queries';
import { logHandoverAccess } from '@/modules/portal/handover-service';
import { buttonClass, IconArrowLeft } from '@/ui';

import { openHandoverItemAction } from './actions';
import { HandoverRequestForm } from './request-form';

export const metadata: Metadata = { title: 'Handover' };

const humanize = (s: string) => s.replace(/_/g, ' ');

/**
 * The delivered handover package, as the client sees it (P707, P708, P711).
 *
 * Shown: the delivered version, what it contains, how each system was handed over (a receipt: no password, key or reference value is ever shown here), the
 * support and warranty terms, and where acceptance stands.
 *
 * NOT here, by design: an accept button that accepts. The client asks; a person at the agency confirms it with you and records the acceptance against this exact
 * version, with evidence (ADM-08d). The page says so. Opening the package and each item is logged. After the project is completed and archived the page is
 * read-only, and after any expiry the agency set it stops being readable.
 */
export default async function PortalHandoverPage({ params }: { params: Promise<{ projectId: string }> }) {
  await requireClient();
  const clock = await agencyClock();
  const { projectId } = await params;
  const project = await readClientProject(projectId);
  if (!project) notFound();

  const { overview, items, receipts, state } = await readClientHandover(projectId);
  // viewing the package is logged where it is shown (a database that cannot log it does not show it)
  if (overview) await logHandoverAccess(overview.packageId, 'viewed');
  const readOnly = overview?.portalAccess === 'read_only' || state?.portalAccess === 'read_only';
  const canAsk = overview && !overview.projectCompleted && !readOnly && (overview.acceptanceState === 'awaiting' || overview.acceptanceState === 'changes_requested');

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <div className="flex flex-col gap-1">
        <Link href={`/portal/${projectId}`} className="flex w-fit items-center gap-1.5 text-[13px] text-muted hover:text-foreground">
          <IconArrowLeft size={14} />
          {project.name}
        </Link>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Handover</h1>
        {state && state.lifecycle !== 'in_progress' ? (
          <p className="text-sm text-muted">
            This project was completed{state.completedAt ? ` on ${clock.date(state.completedAt)}` : ''}
            {state.acceptedVersion ? `; version ${state.acceptedVersion} of the handover was accepted` : ''}
            {state.lifecycle === 'archived' ? '. It is now archived.' : '.'}
            {readOnly ? ' This page is read-only.' : ''}{' '}
            {/* P7-ARC-01: the completion certificate, as a download behind your session (it is built once from the completion record and is not signed). */}
            <a href={`/api/p789/certificate/${projectId}`} className="font-medium text-brand hover:underline">
              Download the completion certificate
            </a>
          </p>
        ) : null}
      </div>

      {!overview ? (
        <p className="text-sm text-muted">
          {state?.portalAccess === 'expired' ? 'Access to this handover has ended.' : 'Your handover package has not been delivered to you yet. You will be told when it is.'}
        </p>
      ) : (
        <>
          <section className="flex flex-col gap-2 rounded-lg border border-line bg-surface px-4 py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-[15px] font-medium">Version {overview.version}</h2>
              <span className="text-[12px] text-muted">{overview.deliveredAt ? `Delivered ${clock.date(overview.deliveredAt)}` : ''}</span>
            </div>
            <p className="text-sm">
              Acceptance: <strong>{humanize(overview.acceptanceState)}</strong>
              {overview.decisionRecordedAt ? ` (recorded ${clock.date(overview.decisionRecordedAt)})` : ''}
              {overview.requestState === 'awaiting_confirmation' ? '. Your request has been sent; your project contact will confirm it with you.' : ''}
            </p>
            {overview.productionUrl ? <p className="text-sm">Live at: {overview.productionUrl}</p> : null}
            {overview.supportTerms ? <p className="whitespace-pre-wrap text-sm">Support and warranty: {overview.supportTerms}</p> : null}
            {overview.warrantyEndsOn ? <p className="text-sm">Warranty ends: {clock.date(overview.warrantyEndsOn)}</p> : null}
            {overview.emergencyContacts ? <p className="whitespace-pre-wrap text-sm">Emergency contacts: {overview.emergencyContacts}</p> : null}
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="text-[15px] font-medium">What is in this version</h2>
            {items.length === 0 ? (
              <p className="text-sm text-muted">Nothing is listed.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {items.map((item) => (
                  <li key={item.kind} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface px-4 py-2">
                    <span className="text-sm">{item.label}</span>
                    {item.artifactRef && /^https?:\/\//i.test(item.artifactRef) ? (
                      <form action={openHandoverItemAction}>
                        <input type="hidden" name="projectId" value={projectId} />
                        <input type="hidden" name="packageId" value={overview.packageId} />
                        <input type="hidden" name="kind" value={item.kind} />
                        <button type="submit" className={buttonClass('secondary', 'sm')}>
                          Open
                        </button>
                      </form>
                    ) : (
                      <span className="text-[13px] text-muted">{item.artifactRef ?? 'Provided'}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="text-[15px] font-medium">How access was handed over</h2>
            <p className="text-sm text-muted">These are receipts. No password or key is ever shown here: they are handed over through the secure method named.</p>
            {receipts.length === 0 ? (
              <p className="text-sm text-muted">No access transfer is recorded.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {receipts.map((r) => (
                  <li key={r.systemName} className="rounded-lg border border-line bg-surface px-4 py-2 text-sm">
                    <span className="font-medium">{r.systemName}</span>: {humanize(r.status)} by {humanize(r.method)}
                    {r.credentialsRotated ? '; temporary credentials rotated' : ''}
                    {r.supportAccessRetained ? '; the agency keeps support access you authorized' : ''}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {canAsk ? (
            <section className="flex flex-col gap-2">
              <h2 className="text-[15px] font-medium">Your decision</h2>
              <p className="text-sm text-muted">
                Review the version above. When you ask to accept, your project contact confirms it with you and records the acceptance against this exact version. Nothing
                is accepted until they have.
              </p>
              <HandoverRequestForm projectId={projectId} packageId={overview.packageId} version={overview.version} />
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
