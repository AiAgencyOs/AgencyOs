'use client';

import { useActionState } from 'react';

import {
  assignDesignReviewerAction,
  finalizeDesignTokenSetAction,
  lockPhaseThreeDirectionAction,
  openDesignRevisionAction,
  recordClientDesignDecisionAction,
  recordDesignTokenSetAction,
  recordRepresentativeScreenAction,
  recordDesignShareAction,
  submitAdminDesignDecisionAction,
  submitInternalDesignReviewAction,
} from '@/modules/projects/actions';
import type { RosterMember } from '@/modules/projects/queries';
import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass } from '@/ui';

/**
 * The two queues §10 asks for — Master §10, §16; Designer §15; PM §7; G-287.
 *
 * G-280 built the gate order; G-286 rendered the trail it produces. These are
 * the forms over the doors between them, which nothing had called.
 *
 * ── they do not decide what is submittable ────────────────────────────
 *
 * A form appears when the option's stored status says the gate is open, and
 * the door checks again — including the two rules no capability can express:
 * the internal gate wants the **assigned reviewer specifically**, and the
 * Admin gate refuses an option internal review has not passed. Nothing here
 * re-derives either. A client-side copy of "this looks ready for Admin" would
 * disagree with the database the moment a review landed, and it would
 * disagree in the direction that offers somebody a button that will fail.
 *
 * ── an edit and a rejection are the same thing ────────────────────────
 *
 * §7.8 gives the Admin CONFIRM and EDIT and no third word. There is no reject
 * button here because there is no reject outcome: an edit with a reason IS the
 * rejection, and it returns the option to the designer *and* to internal
 * review. Offering "reject" would invent a state the gate does not have.
 */

function Message({ state }: { state: { status: string; message?: string } }) {
  if (state.status === 'idle' || !state.message) return null;
  return (
    <p className={`text-[13px] ${state.status === 'error' ? 'text-danger' : 'text-muted'}`} role="status">
      {state.message}
    </p>
  );
}

export function InternalReviewForm({
  projectId,
  themeOptionId,
}: {
  projectId: string;
  themeOptionId: string;
}) {
  const [state, action, pending] = useActionState(submitInternalDesignReviewAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2 border-t border-line pt-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="themeOptionId" value={themeOptionId} />
      <label className="flex flex-col gap-1 text-[13px]">
        <span className="text-xs text-muted">
          What has to change — required when you send it back, so a designer is not left guessing
        </span>
        <textarea
          name="comments"
          rows={2}
          className="rounded-md border border-line bg-surface px-2 py-1"
          placeholder="The header contrast fails at the smallest size…"
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="submit" name="result" value="passed" disabled={pending} className={buttonClass()}>
          Pass
        </button>
        <button
          type="submit"
          name="result"
          value="changes_required"
          disabled={pending}
          className={buttonClass('secondary')}
        >
          Ask for changes
        </button>
      </div>
      <Message state={state} />
    </form>
  );
}

export function AdminDecisionForm({
  projectId,
  themeOptionId,
}: {
  projectId: string;
  themeOptionId: string;
}) {
  const [state, action, pending] = useActionState(submitAdminDesignDecisionAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2 border-t border-line pt-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="themeOptionId" value={themeOptionId} />
      <label className="flex flex-col gap-1 text-[13px]">
        <span className="text-xs text-muted">
          What to change — required for an edit. An edit returns the option to the designer and runs
          internal review again before it comes back to you.
        </span>
        <textarea
          name="reason"
          rows={2}
          className="rounded-md border border-line bg-surface px-2 py-1"
          placeholder="Use the other logo lockup…"
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="submit" name="decision" value="confirm" disabled={pending} className={buttonClass()}>
          Confirm
        </button>
        <button
          type="submit"
          name="decision"
          value="edit"
          disabled={pending}
          className={buttonClass('secondary')}
        >
          Send back for an edit
        </button>
      </div>
      <Message state={state} />
    </form>
  );
}

export function AssignReviewerForm({
  projectId,
  roster,
  current,
}: {
  projectId: string;
  roster: RosterMember[];
  current: string | null;
}) {
  const [state, action, pending] = useActionState(assignDesignReviewerAction, IDLE_STATE);

  if (roster.length === 0) {
    return (
      <p className="text-[13px] text-muted">
        Nobody is on this organisation’s roster yet, so there is no one to appoint.
      </p>
    );
  }

  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <label className="flex flex-col gap-1 text-[13px]">
        <span className="text-xs text-muted">Who holds the internal design gate</span>
        <select
          name="userId"
          defaultValue={current ?? ''}
          className="rounded-md border border-line bg-surface px-2 py-1"
        >
          <option value="" disabled>
            Choose somebody
          </option>
          {roster.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.fullName} — {m.role}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" disabled={pending} className={buttonClass('secondary')}>
        {current ? 'Change reviewer' : 'Appoint reviewer'}
      </button>
      <Message state={state} />
    </form>
  );
}

/**
 * The client loop — Master §7.6, §8; PM §4.4, §4.6, §9; G-288.
 *
 * ── every one of these records; none of them sends ────────────────────
 *
 * There is no channel on this deployment (BLK-003, BLK-007). A button
 * labelled "Send to client" over a door that only writes a row would be the
 * most expensive lie this surface could tell — somebody would tick it and
 * walk away believing a client had been written to. So the verbs are
 * "Record", every form asks for the reference of a message a **person** sent,
 * and the wording says which of the two it is doing.
 */

export function RecordShareForm({
  projectId,
  options,
}: {
  projectId: string;
  options: { id: string; name: string; optionIndex: number }[];
}) {
  const [state, action, pending] = useActionState(recordDesignShareAction, IDLE_STATE);

  if (options.length === 0) {
    return (
      <p className="text-[13px] text-muted">
        Nothing is approved to send yet. Only options Admin has confirmed may reach a client.
      </p>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-2 rounded-md border border-line p-3">
      <p className="text-[13px] text-muted">
        AgencyOS cannot send this — there is no channel configured. Send it yourself, then record
        what you sent.
      </p>
      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs text-muted">Which options you sent</legend>
        {options.map((o) => (
          <label key={o.id} className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" name="themeOptionIds" value={o.id} />
            <span>
              {o.optionIndex}. {o.name}
            </span>
          </label>
        ))}
      </fieldset>
      <input type="hidden" name="projectId" value={projectId} />
      <label className="flex flex-col gap-1 text-[13px]">
        <span className="text-xs text-muted">How you sent it</span>
        <select name="channel" defaultValue="whatsapp" className="rounded-md border border-line bg-surface px-2 py-1">
          <option value="whatsapp">WhatsApp</option>
          <option value="email">Email</option>
          <option value="other">Other</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[13px]">
        <span className="text-xs text-muted">
          The reference of the message you sent — so this record can point at the thing it claims
        </span>
        <input
          name="evidenceRef"
          required
          placeholder="wamid.…"
          className="rounded-md border border-line bg-surface px-2 py-1"
        />
      </label>
      <button type="submit" disabled={pending} className={buttonClass()}>
        Record what was sent
      </button>
      <Message state={state} />
    </form>
  );
}

/**
 * PM §12's six classifications, and no seventh.
 *
 * The theme and colour pickers are offered from the round's own frozen
 * snapshot — not from the options as they stand now. That is the same rule
 * the door enforces (`not_shown`), and offering anything else would build a
 * form whose normal outcome is a refusal.
 */
export function RecordClientReplyForm({
  projectId,
  shareId,
  shown,
}: {
  projectId: string;
  shareId: string;
  shown: { themeOptionId: string; name: string; colors: { id: string; paletteName: string }[] }[];
}) {
  const [state, action, pending] = useActionState(recordClientDesignDecisionAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2 border-t border-line pt-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="shareId" value={shareId} />
      <label className="flex flex-col gap-1 text-[13px]">
        <span className="text-xs text-muted">What the client actually wrote — their words, not a summary</span>
        <textarea
          name="clientWords"
          rows={2}
          required
          className="rounded-md border border-line bg-surface px-2 py-1"
          placeholder="we like the second one but the header feels heavy"
        />
      </label>
      <label className="flex flex-col gap-1 text-[13px]">
        <span className="text-xs text-muted">What that means</span>
        <select name="decision" defaultValue="clarification_required" className="rounded-md border border-line bg-surface px-2 py-1">
          <option value="client_selected">They picked a direction</option>
          <option value="design_change_request">They want a visual change</option>
          <option value="client_reference">They sent something to look at</option>
          <option value="possible_scope_change">They asked for something that is not design</option>
          <option value="clarification_required">Nobody can tell what they meant</option>
          <option value="final_confirmed">They confirmed the final theme and colour</option>
        </select>
      </label>
      <div className="flex flex-wrap gap-2">
        <label className="flex flex-col gap-1 text-[13px]">
          <span className="text-xs text-muted">Which direction (from this round)</span>
          <select name="themeOptionId" defaultValue="" className="rounded-md border border-line bg-surface px-2 py-1">
            <option value="">—</option>
            {shown.map((o) => (
              <option key={o.themeOptionId} value={o.themeOptionId}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[13px]">
          <span className="text-xs text-muted">Which palette</span>
          <select name="colorOptionId" defaultValue="" className="rounded-md border border-line bg-surface px-2 py-1">
            <option value="">—</option>
            {shown.flatMap((o) =>
              o.colors.map((c) => (
                <option key={c.id} value={c.id}>
                  {o.name} — {c.paletteName}
                </option>
              )),
            )}
          </select>
        </label>
      </div>
      <label className="flex flex-col gap-1 text-[13px]">
        <span className="text-xs text-muted">If they sent a reference — a link, or a note about it</span>
        <input name="referenceUrl" placeholder="https://…" className="rounded-md border border-line bg-surface px-2 py-1" />
      </label>
      <label className="flex flex-col gap-1 text-[13px]">
        <span className="text-xs text-muted">The reference of their message, if you have one</span>
        <input name="evidenceRef" placeholder="wamid.…" className="rounded-md border border-line bg-surface px-2 py-1" />
      </label>
      <button type="submit" disabled={pending} className={buttonClass()}>
        Record what they said
      </button>
      <Message state={state} />
    </form>
  );
}

/**
 * PM §9 — the round a change request asks for.
 *
 * Offered only on a `design_change_request` that has not already opened one,
 * because the door's idempotency key is the decision itself. The form carries
 * that id, so asking twice returns the round it already opened rather than
 * spending another against the limit.
 */
export function OpenRevisionForm({
  projectId,
  themeOptionId,
  clientDecisionId,
  clientWords,
}: {
  projectId: string;
  themeOptionId: string;
  clientDecisionId: string;
  clientWords: string;
}) {
  const [state, action, pending] = useActionState(openDesignRevisionAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2 pt-1">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="themeOptionId" value={themeOptionId} />
      <input type="hidden" name="clientDecisionId" value={clientDecisionId} />
      <input type="hidden" name="origin" value="client_revision" />
      <label className="flex flex-col gap-1 text-[13px]">
        <span className="text-xs text-muted">
          What the designer has to change. Their words are above — this is the instruction.
        </span>
        <textarea
          name="requestedChanges"
          rows={2}
          required
          defaultValue={clientWords}
          className="rounded-md border border-line bg-surface px-2 py-1"
        />
      </label>
      <button type="submit" disabled={pending} className={buttonClass('secondary')}>
        Open a revision round
      </button>
      <Message state={state} />
    </form>
  );
}

/**
 * The completion gate — Master §7.11, §7.12; PM §4.10; Designer §4.9; G-289.
 *
 * One button, and it carries no argument about what to lock. The door reads
 * the client's `final_confirmed` decision to learn that, which is why G-285
 * gave it that signature: a form with a theme picker on it could lock
 * something the client never confirmed, and §16's no-silent-overwrite rule
 * would be held by whoever last touched the dropdown.
 *
 * The confirmation the button quotes is the one the door will read. If they
 * ever disagree the door wins, refuses, and says so — this is a label, not a
 * decision.
 */
export function LockDirectionForm({
  projectId,
  phaseThreeId,
  confirmedWords,
  hasFigma,
}: {
  projectId: string;
  phaseThreeId: string;
  confirmedWords: string;
  hasFigma: boolean;
}) {
  const [state, action, pending] = useActionState(lockPhaseThreeDirectionAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2 rounded-md border border-line p-3">
      <p className="text-[13px]">
        The client confirmed: “{confirmedWords}”
      </p>
      {!hasFigma ? (
        <p className="text-[13px] text-muted">
          There is no Figma reference on the confirmed option. Phase 3 will still complete — the
          client did confirm — but the handoff will be marked not Phase 4 ready, and Phase 4 stays
          blocked until the artifact exists.
        </p>
      ) : null}
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="phaseThreeId" value={phaseThreeId} />
      <button type="submit" disabled={pending} className={buttonClass()}>
        Lock the direction and complete Phase 3
      </button>
      <Message state={state} />
    </form>
  );
}

/**
 * A sample screen, and what it stands for — Designer §7, §17; G-293.
 *
 * The screen picker offers only **approved** screens, because that is exactly
 * what the door accepts (§17). A picker showing drafts would make
 * `screen_not_approved` the normal outcome of using it — a form built to fail.
 */
export function RecordSampleForm({
  projectId,
  themeOptionId,
  approvedScreens,
}: {
  projectId: string;
  themeOptionId: string;
  approvedScreens: { id: string; name: string; screenKey: string }[];
}) {
  const [state, action, pending] = useActionState(recordRepresentativeScreenAction, IDLE_STATE);

  if (approvedScreens.length === 0) {
    return (
      <p className="text-[13px] text-muted">
        No screen on this project is approved yet, so there is nothing a sample could stand for.
      </p>
    );
  }

  return (
    <details className="text-[13px]">
      <summary className="cursor-pointer text-muted">Record a sample screen</summary>
      <form action={action} className="flex flex-col gap-2 pt-2">
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="themeOptionId" value={themeOptionId} />
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">Which approved screen it stands for</span>
          <select name="screenId" required className="rounded-md border border-line bg-surface px-2 py-1">
            {approvedScreens.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.screenKey})
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">What it exposes</span>
          <select name="pattern" defaultValue="primary" className="rounded-md border border-line bg-surface px-2 py-1">
            <option value="primary">A primary, home or dashboard-like screen</option>
            <option value="list">A list</option>
            <option value="detail">A detail view</option>
            <option value="form">A form</option>
            <option value="navigation">Navigation context</option>
            <option value="state">An empty, loading or error state</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">Figma node, or a preview URL below — one of the two</span>
          <input name="figmaNodeId" placeholder="1:234" className="rounded-md border border-line bg-surface px-2 py-1" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">Preview URL</span>
          <input name="previewAssetUrl" placeholder="https://…" className="rounded-md border border-line bg-surface px-2 py-1" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">What decision this sample is meant to settle</span>
          <input name="decisionNote" placeholder="whether the dense table reads at this type size" className="rounded-md border border-line bg-surface px-2 py-1" />
        </label>
        <button type="submit" disabled={pending} className={buttonClass('secondary')}>
          Record the sample
        </button>
        <Message state={state} />
      </form>
    </details>
  );
}

/**
 * A direction's Phase 3 primitives — Designer §4.5, §19, §23; G-296.
 *
 * ── the fields carry the current values, and that is load-bearing ─────
 *
 * The door treats a null argument as **unchanged**, so a new version inherits
 * the last finalized one. A form that presented empty boxes would send blanks
 * for everything untouched — harmless at the door, which nullifies them, but
 * it would show somebody an empty set and invite them to retype what is
 * already there. The defaults are what makes the carry-forward visible.
 *
 * ── a final set is shown, not editable ────────────────────────────────
 *
 * §19: Phase 4 inherits these. The door starts a new version rather than
 * reopening one, so a final set renders as a record with a button that says
 * what the next edit will do.
 */

const SELECTS: { name: string; label: string; options: [string, string][] }[] = [
  ['radiusStyle', 'Corners', [['sharp', 'Sharp'], ['soft', 'Soft'], ['rounded', 'Rounded'], ['pill', 'Pill']]],
  ['elevationStyle', 'Depth', [['flat', 'Flat'], ['subtle', 'Subtle'], ['layered', 'Layered']]],
  ['borderStyle', 'Borders', [['none', 'None'], ['hairline', 'Hairline'], ['defined', 'Defined']]],
  ['iconTreatment', 'Icons', [['outline', 'Outline'], ['filled', 'Filled'], ['duotone', 'Duotone'], ['mixed', 'Mixed']]],
  ['navigationStyle', 'Navigation', [['top_bar', 'Top bar'], ['side_nav', 'Side nav'], ['bottom_tabs', 'Bottom tabs'], ['hybrid', 'Hybrid']]],
].map(([name, label, options]) => ({
  name: name as string,
  label: label as string,
  options: options as [string, string][],
}));

export function TokenSetForm({
  projectId,
  themeOptionId,
  current,
}: {
  projectId: string;
  themeOptionId: string;
  current: {
    version: number;
    status: string;
    fontFamilyHeading: string | null;
    fontFamilyBody: string | null;
    typeScaleRatio: string | null;
    baseSpacingPx: number | null;
    radiusStyle: string | null;
    elevationStyle: string | null;
    borderStyle: string | null;
    iconTreatment: string | null;
    navigationStyle: string | null;
    buttonTreatment: string | null;
    cardTreatment: string | null;
    notes: string | null;
  } | null;
}) {
  const [state, action, pending] = useActionState(recordDesignTokenSetAction, IDLE_STATE);
  const [finalState, finalAction, finalPending] = useActionState(
    finalizeDesignTokenSetAction,
    IDLE_STATE,
  );
  const isFinal = current?.status === 'final';
  const values = (current ?? {}) as Record<string, string | number | null>;

  return (
    <details className="text-[13px]">
      <summary className="cursor-pointer text-muted">
        Design primitives
        {current ? ` — v${current.version}, ${current.status}` : ' — none yet'}
      </summary>
      <div className="flex flex-col gap-2 pt-2">
        <p className="text-xs text-muted">
          Only what Phase 3 needs to communicate the direction. Phase 4 inherits these rather than
          recreating them. Anything left blank is unchanged.
        </p>
        <form action={action} className="flex flex-col gap-2">
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="themeOptionId" value={themeOptionId} />
          <div className="flex flex-wrap gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">Heading typeface</span>
              <input
                name="fontFamilyHeading"
                defaultValue={current?.fontFamilyHeading ?? ''}
                className="rounded-md border border-line bg-surface px-2 py-1"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">Body typeface</span>
              <input
                name="fontFamilyBody"
                defaultValue={current?.fontFamilyBody ?? ''}
                className="rounded-md border border-line bg-surface px-2 py-1"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">Type scale (1.000–2.000)</span>
              <input
                name="typeScaleRatio"
                defaultValue={current?.typeScaleRatio ?? ''}
                placeholder="1.250"
                className="rounded-md border border-line bg-surface px-2 py-1"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">Base spacing px (2–16)</span>
              <input
                name="baseSpacingPx"
                defaultValue={current?.baseSpacingPx ?? ''}
                placeholder="8"
                className="rounded-md border border-line bg-surface px-2 py-1"
              />
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            {SELECTS.map((s) => (
              <label key={s.name} className="flex flex-col gap-1">
                <span className="text-xs text-muted">{s.label}</span>
                <select
                  name={s.name}
                  defaultValue={(values[s.name] as string | null) ?? ''}
                  className="rounded-md border border-line bg-surface px-2 py-1"
                >
                  <option value="">—</option>
                  {s.options.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">Buttons — the shape they take, in a sentence</span>
            <input
              name="buttonTreatment"
              defaultValue={current?.buttonTreatment ?? ''}
              className="rounded-md border border-line bg-surface px-2 py-1"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">Cards — the same</span>
            <input
              name="cardTreatment"
              defaultValue={current?.cardTreatment ?? ''}
              className="rounded-md border border-line bg-surface px-2 py-1"
            />
          </label>
          <button type="submit" disabled={pending || isFinal} className={buttonClass('secondary')}>
            {isFinal ? 'Start the next version' : 'Save the primitives'}
          </button>
          <Message state={state} />
        </form>
        {current && !isFinal ? (
          <form action={finalAction} className="flex flex-col gap-1">
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="themeOptionId" value={themeOptionId} />
            <button type="submit" disabled={finalPending} className={buttonClass('secondary')}>
              Finalize these primitives
            </button>
            <Message state={finalState} />
          </form>
        ) : null}
        {isFinal ? (
          <p className="text-xs text-muted">
            Final. Phase 4 inherits these. A later change is a new version, not an edit.
          </p>
        ) : null}
      </div>
    </details>
  );
}
