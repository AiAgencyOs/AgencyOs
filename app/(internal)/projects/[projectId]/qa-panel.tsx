'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { markProductionReadyAction, raiseDefectAction, settleDefectAction } from '@/modules/qa/actions';
import { DEFECT_SEVERITIES, DEFECT_TRANSITIONS, type DefectStatus } from '@/modules/qa/schema';
import type { Defect } from '@/modules/qa/types';
import { FormMessage, buttonClass, inputClass, labelClass, selectClass } from '@/ui';

/**
 * The defect register, and the sign-off that reads it — ARCHITECTURE.md §4.8,
 * ADM-19; G-306.
 *
 * The QA module had **no surface at all**. Five functions, all tested, and a
 * caller sweep found nothing calling any of them.
 *
 * **The gate was live and the register behind it was not writable.**
 * `submit_deliverable` refuses while an open blocker or major exists, and
 * `mark_production_ready` reads the same counts — so a delivery could be
 * blocked by a defect nobody could raise, and a project could not be signed
 * off by anybody using the product.
 *
 * ── what this panel refuses to do ─────────────────────────────────────
 *
 * **It does not decide what blocks.** `blocksDelivery` is the module's rule
 * and the database holds it; this renders what the counts say. A second copy
 * would disagree the moment somebody settled a defect in another tab.
 *
 * **It offers only the moves the state machine has.** `DEFECT_TRANSITIONS` is
 * the same table `defects_guard` enforces — `verified` and `wontfix` are
 * terminal, and `fixed → open` exists because a failed verification is the
 * same bug still being wrong, not a new one.
 *
 * **It does not let a defect be closed by silence.** Anything but `open`
 * requires a resolution, which is the schema's rule, and the field is
 * `required` for exactly the moves that need it.
 */

const input = inputClass;
const label = labelClass;

function Status({ state }: { state: { status: string; message?: string } }) {
  return <FormMessage status={state.status} message={state.message} />;
}

export function RaiseDefectForm({
  projectId,
  deliverables,
}: {
  projectId: string;
  deliverables: { id: string; kind: string; version: number; title: string }[];
}) {
  const [state, action, pending] = useActionState(raiseDefectAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />

      <div className="flex flex-wrap gap-2">
        <div className="flex min-w-48 flex-1 flex-col gap-1">
          <label className={label} htmlFor="defect-title">
            What is wrong
          </label>
          <input id="defect-title" name="title" required maxLength={200} className={input} />
        </div>
        <div className="flex flex-col gap-1">
          <label className={label} htmlFor="defect-severity">
            Severity
          </label>
          <select id="defect-severity" name="severity" required defaultValue="major" className={selectClass}>
            {DEFECT_SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className={label} htmlFor="defect-deliverable">
            Against
          </label>
          {/*
            Blank means project-wide, and that is the schema's own wording: a
            defect with no version blocks EVERY submission rather than one.
          */}
          <select id="defect-deliverable" name="deliverableId" defaultValue="" className={selectClass}>
            <option value="">the project as a whole</option>
            {deliverables.map((d) => (
              <option key={d.id} value={d.id}>
                {d.kind} v{d.version} — {d.title}
              </option>
            ))}
          </select>
        </div>
      </div>

      <label className={label} htmlFor="defect-reproduction">
        How to make it happen
      </label>
      {/*
        Required, and not out of formality: a bug nobody can reproduce is a
        rumour, and the cost of writing the steps down is paid once by whoever
        found it rather than repeatedly by whoever picks it up.
      */}
      <textarea id="defect-reproduction" name="reproduction" required rows={3} maxLength={4000} className={input} />

      <div className="flex flex-wrap gap-2">
        <input name="expected" maxLength={2000} placeholder="What should happen" aria-label="Expected" className={`${input} min-w-40 flex-1`} />
        <input name="actual" maxLength={2000} placeholder="What happens instead" aria-label="Actual" className={`${input} min-w-40 flex-1`} />
      </div>
      <div className="flex flex-wrap gap-2">
        <input name="environment" maxLength={500} placeholder="Where — browser, device, build" aria-label="Environment" className={`${input} min-w-40 flex-1`} />
        <input name="evidenceUrl" type="url" placeholder="Link to a screenshot or recording" aria-label="Evidence link" className={`${input} min-w-40 flex-1`} />
      </div>

      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Raising…' : 'Raise the defect'}
      </button>
      <Status state={state} />
    </form>
  );
}

export function SettleDefectForm({ projectId, defect }: { projectId: string; defect: Defect }) {
  const [state, action, pending] = useActionState(settleDefectAction, IDLE_STATE);
  // The same table `defects_guard` enforces. A terminal defect renders no
  // control at all, rather than one whose only outcome is a refusal.
  const moves = DEFECT_TRANSITIONS[defect.status as DefectStatus] ?? [];

  if (moves.length === 0) return null;

  return (
    <form action={action} className="mt-2 flex flex-wrap items-end gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="defectId" value={defect.id} />

      <div className="flex flex-col gap-1">
        <label className={label} htmlFor={`defect-move-${defect.id}`}>
          Move it to
        </label>
        <select id={`defect-move-${defect.id}`} name="status" required defaultValue={moves[0]} className={selectClass}>
          {moves.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>

      {/*
        Required here because every move this control offers leaves `open` —
        `open → fixed`, `open → wontfix`, `fixed → verified`, `fixed → open` —
        and the schema refuses all of them without a resolution. What stops a
        bug being closed by silence.
      */}
      <div className="flex min-w-48 flex-1 flex-col gap-1">
        <label className={label} htmlFor={`defect-resolution-${defect.id}`}>
          What happened to it
        </label>
        <input id={`defect-resolution-${defect.id}`} name="resolution" required maxLength={2000} className={input} />
      </div>

      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Recording…' : 'Record it'}
      </button>
      <Status state={state} />
    </form>
  );
}

export function ProductionReadyForm({ projectId }: { projectId: string }) {
  const [state, action, pending] = useActionState(markProductionReadyAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Signing off…' : 'Sign off as production ready'}
        </button>
        {/*
          Nothing here predicts the gate. `mark_production_ready` checks the
          build's approval, the open blockers and the rest under the project's
          lock, and names what is missing in its refusal — a client-side copy
          would go stale the moment somebody verified a defect elsewhere.
        */}
        <Status state={state} />
      </div>
    </form>
  );
}
