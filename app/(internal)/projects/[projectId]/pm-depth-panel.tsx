import { readPmDepth } from '@/modules/projects/pm-depth-queries';

import { RecordRevisionForm, ResolveEscalationForm, ShareBuildForm, ShareDeliveryForm } from './pm-depth-forms';

const ORIGIN_LABEL: Record<string, string> = {
  client: 'Client',
  admin: 'Admin',
  qa_correction: 'QA correction',
  approved_change_request: 'Approved Change Request',
};

/**
 * Client review shares, revision rounds and the allowance (Phase 5 PM spec sections 15 and 16). Read as stored: the count comes from the
 * database function, the QA and Admin states of each revised build are the build's own, and nothing here decides a gate.
 */
export async function PmDepthPanel({ projectId, features }: { projectId: string; features: { id: string; name: string }[] }) {
  const depth = await readPmDepth(projectId);
  return (
    <section className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4" aria-label="Client review builds and revisions">
      <h2 className="text-[15px] font-semibold">Client review builds and revisions</h2>

      {depth.openEscalations.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-md border border-danger/40 px-3 py-2">
          <h3 className="text-[13px] font-medium">Waiting for a decision</h3>
          {depth.openEscalations.map((e) => (
            <div key={e.id} className="flex flex-col gap-1">
              <p className="text-[13px]">The client asked for another revision after {e.roundsUsed} of {e.roundLimit} included rounds: {e.requestedReason}</p>
              <ResolveEscalationForm projectId={projectId} escalationId={e.id} />
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex flex-col gap-1">
        <h3 className="text-[13px] font-medium">Review shares</h3>
        {depth.shares.length === 0 ? (
          <p className="text-[13px] text-muted">No build has been shared for client testing yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {depth.shares.map((s) => (
              <li key={s.id} className="flex flex-col gap-1 text-[13px]">
                <span>
                  Build {s.version ?? '?'} on {s.reviewPlatform}, commit {s.commitRef.slice(0, 12)}: {s.deliveryState === 'relayed' ? 'relayed to the client' : s.deliveryState === 'failed' ? 'did not reach the client' : 'not yet relayed'}
                  {s.deliveryNote ? ` (${s.deliveryNote})` : ''}
                </span>
                {s.deliveryState !== 'relayed' ? <ShareDeliveryForm projectId={projectId} shareId={s.id} /> : null}
              </li>
            ))}
          </ul>
        )}
        <details className="mt-1">
          <summary className="cursor-pointer text-[13px] text-muted">Share a build for client testing</summary>
          <ShareBuildForm projectId={projectId} builds={depth.builds} />
        </details>
      </div>

      <div className="flex flex-col gap-1">
        <h3 className="text-[13px] font-medium">
          Revision rounds
          {depth.allowance ? ` - ${depth.allowance.roundsUsed} of ${depth.allowance.roundLimit} included client rounds used` : ''}
        </h3>
        {depth.rounds.length === 0 ? (
          <p className="text-[13px] text-muted">No revision has been recorded.</p>
        ) : (
          <ol className="flex flex-col gap-1">
            {depth.rounds.map((r) => (
              <li key={r.revisionId} className="text-[13px]">
                Round {r.roundNumber}: v{r.fromVersion} to v{r.toVersion}, {ORIGIN_LABEL[r.origin] ?? r.origin}, {r.consumesAllowance ? 'spends the allowance' : 'spends nothing'}; QA {r.qaStatus ?? 'not reviewed'}, Admin {r.adminStatus ?? 'pending'}. {r.reason}
              </li>
            ))}
          </ol>
        )}
        <details className="mt-1">
          <summary className="cursor-pointer text-[13px] text-muted">Record a revision round</summary>
          <RecordRevisionForm projectId={projectId} builds={depth.builds} features={features} />
        </details>
      </div>
    </section>
  );
}
