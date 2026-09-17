'use client';

import { useActionState } from 'react';

import { recordKickoffAction } from '@/modules/projects/actions';
import { describeBlockers } from '@/modules/projects/kickoff-blockers';
import type { PhaseTwoView } from '@/modules/projects/queries';
import { IDLE_STATE } from '@/modules/identity/types';
import { Badge, buttonClass, type Tone } from '@/ui';

/**
 * Phase 2, and the kickoff — Master §5.10, §5.11; G-263.
 *
 * G-250 through G-262 built the phase, the plan, four registers and a kickoff
 * gate, and left every one of them **unreachable**: internal-only tables that
 * nothing rendered, behind doors nothing called. G-254 was the same shape for
 * the group card, and the same argument applies — a door with no surface is a
 * feature only somebody with database access has.
 *
 * Two things this panel refuses to do.
 *
 * **It does not predict the gate.** The blockers it lists come back from
 * `pre_kickoff_readiness`; nothing here re-derives them. A client-side copy of
 * "the advance is not verified" goes stale the moment an Admin verifies it,
 * and would tell somebody their project cannot start when it can.
 *
 * **It does not pretend the kickoff was sent.** There is no channel on this
 * deployment (BLK-003, BLK-007), so the form asks for the reference of a
 * message a person sent themselves. The button says so.
 */

const STATE_TONE: Record<string, Tone> = {
  context_loading: 'info',
  waiting_client: 'warning',
  waiting_admin: 'warning',
  waiting_finance: 'warning',
  waiting_planning: 'warning',
  pre_kickoff_check: 'info',
  kickoff_ready: 'success',
  kickoff_sent: 'success',
  completed: 'success',
  blocked: 'danger',
};

function KickoffForm({ projectId }: { projectId: string }) {
  const [state, action, pending] = useActionState(recordKickoffAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <label className="flex flex-col gap-1 text-[13px]">
        <span className="text-xs text-muted">
          The reference of the kickoff message you sent — a WhatsApp message id, an email id, or
          whatever your channel gives you
        </span>
        <input
          name="evidenceRef"
          required
          placeholder="wamid.…"
          className="rounded-md border border-line bg-surface px-2 py-1"
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className={buttonClass('primary')} disabled={pending}>
          {pending ? 'Recording…' : 'I have sent the kickoff — complete Phase 2'}
        </button>
        {state.status === 'error' ? (
          <span className="text-[13px] text-danger">{state.message}</span>
        ) : null}
        {state.status === 'success' ? (
          <span className="text-[13px] text-muted">{state.message}</span>
        ) : null}
      </div>
    </form>
  );
}

export function PhaseTwoPanel({ view, projectId }: { view: PhaseTwoView; projectId: string }) {
  const { phase, readiness, plan } = view;

  // A project whose Phase 2 never started — every project converted before
  // G-250 — gets nothing rather than a panel full of zeroes claiming a phase
  // exists.
  if (!phase) return null;

  const done = phase.state === 'completed';

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[13px] font-semibold tracking-tight">Phase 2 — onboarding to kickoff</h2>
        <Badge tone={STATE_TONE[phase.state] ?? 'neutral'}>{phase.state.replace(/_/g, ' ')}</Badge>
      </div>

      {plan ? (
        <div className="flex flex-col gap-1 rounded-md border border-line p-3 text-[13px]">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="font-medium">Operational plan v{plan.version}</span>
            <Badge tone={plan.status === 'active' ? 'success' : 'neutral'}>{plan.status}</Badge>
          </div>
          {plan.objective ? <p className="text-muted">{plan.objective}</p> : null}
          <p className="text-muted">
            {plan.deliverables} deliverable{plan.deliverables === 1 ? '' : 's'} ·{' '}
            {plan.milestones} milestone{plan.milestones === 1 ? '' : 's'} ·{' '}
            {plan.dependencies} dependenc{plan.dependencies === 1 ? 'y' : 'ies'}
            {plan.openQuestions > 0 ? (
              <>
                {' '}· <span className="text-fg">{plan.openQuestions} open question{plan.openQuestions === 1 ? '' : 's'}</span>
              </>
            ) : null}
          </p>
        </div>
      ) : (
        <p className="text-[13px] text-muted">
          No operational plan is live for this project yet.
        </p>
      )}

      {done ? (
        <p className="text-[13px] text-muted">
          Phase 2 completed{phase.completedAt ? ` on ${phase.completedAt.slice(0, 10)}` : ''}. The
          project is active and Phase 3 has been handed the work.
        </p>
      ) : readiness?.ready ? (
        <>
          <p className="text-[13px]">
            Every gate is met. AgencyOS cannot send the kickoff message — there is no channel
            configured — so send it yourself and record it here.
          </p>
          <KickoffForm projectId={projectId} />
        </>
      ) : (
        <div className="flex flex-col gap-1">
          <p className="text-[13px] text-muted">Not ready for kickoff yet:</p>
          {/*
            The list comes back from the gate. Nothing here decides what is
            blocking — a client-side copy would tell somebody their project
            cannot start a minute after it can.
          */}
          <ul className="flex flex-col gap-1 text-[13px]">
            {describeBlockers(readiness?.unmet ?? []).map((blocker) => (
              <li key={blocker} className="flex gap-2">
                <span aria-hidden className="text-muted">
                  ·
                </span>
                <span>{blocker}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
