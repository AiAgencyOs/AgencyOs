'use client';

import { useActionState, useState } from 'react';

import {
  confirmGroupCreatedAction,
  mapGroupAction,
  reviseGroupSetupAction,
  verifyGroupAction,
} from '@/modules/projects/actions';
import type { GroupSetupCard } from '@/modules/projects/queries';
import { IDLE_STATE } from '@/modules/identity/types';
import { Badge, buttonClass, type Tone } from '@/ui';

/**
 * The Admin's WhatsApp group card — Master §6, G-254.
 *
 * G-253 built the doors and said plainly what was missing: *"until the surface
 * exists, the card is raised and only an internal reader of the table can see
 * it."* This is that surface.
 *
 * **It cannot create a group and does not pretend to.** Meta refused this
 * WABA the Groups API (#131215, ADM-95), so the honest job of this card is to
 * make the manual step quick and the record of it true: the exact name, the
 * exact member list, one button to copy both, and then four controls that
 * record what a person actually did.
 *
 * §6 asks for "open/create assistance ... without falsely claiming unsupported
 * API automation". The assistance here is the copy button and nothing else.
 * There is deliberately no *Create group* button, because there is nothing it
 * could call.
 *
 * Every refusal comes back from the door rather than being predicted here. A
 * client-side copy of "you cannot map before confirming" goes stale; a
 * surfaced refusal cannot.
 */

const STATE_TONE: Record<GroupSetupCard['state'], Tone> = {
  pending: 'warning',
  created: 'info',
  mapped: 'info',
  verified: 'success',
};

const STATE_LABEL: Record<GroupSetupCard['state'], string> = {
  pending: 'Waiting for you',
  created: 'Created — needs mapping',
  mapped: 'Mapped — needs a check',
  verified: 'Verified',
};

/** §6's "copy setup data — group name + member list + instructions". */
function setupText(card: GroupSetupCard): string {
  const lines: string[] = [];
  lines.push(card.suggestedName ? `Group name: ${card.suggestedName}` : 'Group name: (not composable yet)');
  lines.push('');
  lines.push('Members:');
  for (const m of card.members) {
    const role = m.role ? ` — ${m.role}` : '';
    lines.push(`  ${m.kind === 'client' ? '[client]' : '[team]  '} ${m.name ?? '(no name)'} ${m.phone ?? ''}${role}`);
  }
  lines.push('');
  lines.push('Steps: create the group in WhatsApp with exactly this name, add these numbers,');
  lines.push('then come back and confirm it here.');
  return lines.join('\n');
}

function CopySetupData({ card }: { card: GroupSetupCard }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className={buttonClass('ghost')}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(setupText(card));
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2000);
        } catch {
          // A clipboard a browser refuses is not an error worth a dialog; the
          // text is on the page and can be selected. Saying "copied" when it
          // was not would be the only real failure here.
          setCopied(false);
        }
      }}
    >
      {copied ? 'Copied' : 'Copy name and members'}
    </button>
  );
}

function StepForm({
  action,
  card,
  projectId,
  label,
  children,
}: {
  action: typeof confirmGroupCreatedAction;
  card: GroupSetupCard;
  projectId: string;
  label: string;
  children?: React.ReactNode;
}) {
  const [state, formAction, pending] = useActionState(action, IDLE_STATE);

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="setupId" value={card.id} />
      <input type="hidden" name="projectId" value={projectId} />
      {children}
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className={buttonClass('primary')} disabled={pending}>
          {pending ? 'Saving…' : label}
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

/**
 * §6's "project overrides — add/remove members for this project", and the
 * editable suggested name.
 *
 * A `useActionState` form like every other write here, because the action
 * returns a `FormState` the person needs to see: the door refuses a revision
 * once the group exists, and that refusal is worth reading rather than
 * swallowing.
 */
function ReviseForm({ card, projectId }: { card: GroupSetupCard; projectId: string }) {
  const [state, action, pending] = useActionState(reviseGroupSetupAction, IDLE_STATE);

  return (
    <form action={action} className="mt-2 flex flex-col gap-2">
      <input type="hidden" name="setupId" value={card.id} />
      <input type="hidden" name="projectId" value={projectId} />

      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted">Group name</span>
        <input
          name="suggestedName"
          defaultValue={card.suggestedName ?? ''}
          className="rounded-md border border-line bg-surface px-2 py-1"
        />
      </label>

      {card.members.map((m, i) => (
        <div key={`edit-${i}`} className="flex flex-wrap gap-2">
          <input name="memberName" defaultValue={m.name ?? ''} placeholder="Name"
            className="min-w-[8rem] flex-1 rounded-md border border-line bg-surface px-2 py-1" />
          <input name="memberPhone" defaultValue={m.phone ?? ''} placeholder="Number"
            className="min-w-[8rem] flex-1 rounded-md border border-line bg-surface px-2 py-1" />
          <input name="memberRole" defaultValue={m.role ?? ''} placeholder="Role"
            className="min-w-[6rem] flex-1 rounded-md border border-line bg-surface px-2 py-1" />
          <input type="hidden" name="memberKind" value={m.kind} />
        </div>
      ))}

      {/* One blank row, so adding somebody needs no extra control. */}
      <div className="flex flex-wrap gap-2">
        <input name="memberName" placeholder="Add a name"
          className="min-w-[8rem] flex-1 rounded-md border border-line bg-surface px-2 py-1" />
        <input name="memberPhone" placeholder="Number"
          className="min-w-[8rem] flex-1 rounded-md border border-line bg-surface px-2 py-1" />
        <input name="memberRole" placeholder="Role"
          className="min-w-[6rem] flex-1 rounded-md border border-line bg-surface px-2 py-1" />
        <input type="hidden" name="memberKind" value="internal" />
      </div>

      <p className="text-xs text-muted">
        Clear a row&rsquo;s name and number to remove that person. Once you confirm the group
        exists, this list becomes a record and stops being editable.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className={buttonClass('ghost')} disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
        </button>
        {state.status === 'error' ? (
          <span className="text-[13px] text-danger">{state.message}</span>
        ) : null}
      </div>
    </form>
  );
}

export function GroupSetupCardPanel({
  card,
  projectId,
}: {
  card: GroupSetupCard;
  projectId: string;
}) {
  const clients = card.members.filter((m) => m.kind === 'client');
  const team = card.members.filter((m) => m.kind === 'internal');

  return (
    <div className="flex flex-col gap-3 rounded-md border border-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold tracking-tight">Group setup</h3>
        <Badge tone={STATE_TONE[card.state]}>{STATE_LABEL[card.state]}</Badge>
      </div>

      {/*
        §6's honesty line, on the surface rather than only in a migration
        comment. A person reading this card is the person who has to do the
        work, and they should be told why.
      */}
      <p className="text-[13px] leading-relaxed text-muted">
        WhatsApp gives no API for creating a group or adding people to one, so this step is yours.
        Everything below is prepared for you to paste.
      </p>

      {card.suggestedName ? (
        <p className="break-words rounded-md border border-line bg-surface px-3 py-2 text-[13px] font-medium">
          {card.suggestedName}
        </p>
      ) : (
        <p className="text-[13px] text-muted">
          The standard name cannot be composed yet — it is missing{' '}
          <strong className="text-fg">{card.suggestedNameMissing.join(', ') || 'some facts'}</strong>.
        </p>
      )}

      <div className="flex flex-col gap-1">
        <p className="text-xs uppercase tracking-wide text-muted">Members</p>
        {card.members.length === 0 ? (
          <p className="text-[13px] text-muted">Nobody is on this card yet.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {[...clients, ...team].map((m, i) => (
              <li key={`${m.phone}-${i}`} className="flex flex-wrap items-baseline gap-2 text-[13px]">
                <Badge tone={m.kind === 'client' ? 'info' : 'neutral'}>
                  {m.kind === 'client' ? 'Client' : 'Team'}
                </Badge>
                <span>{m.name ?? '(no name)'}</span>
                <span className="tabular text-muted">{m.phone}</span>
                {m.role ? <span className="text-muted">· {m.role}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <CopySetupData card={card} />
      </div>

      {/*
        The member list and the name are editable only while the card is
        pending — after that they are a record of who was actually added, and
        the door refuses the change anyway (PM §8). Showing an editor that
        would be refused is a worse answer than not showing one.
      */}
      {card.state === 'pending' ? (
        <>
          <details className="text-[13px]">
            <summary className="cursor-pointer text-muted">Change the name or the members</summary>
            <ReviseForm card={card} projectId={projectId} />
          </details>

          <StepForm
            action={confirmGroupCreatedAction}
            card={card}
            projectId={projectId}
            label="I have created the group"
          >
            <label className="flex flex-col gap-1 text-[13px]">
              <span className="text-xs text-muted">Note (optional)</span>
              <input name="note" className="rounded-md border border-line bg-surface px-2 py-1" />
            </label>
          </StepForm>
        </>
      ) : null}

      {card.state === 'created' ? (
        <StepForm action={mapGroupAction} card={card} projectId={projectId} label="Map it">
          <label className="flex flex-col gap-1 text-[13px]">
            <span className="text-xs text-muted">The conversation id for this project&rsquo;s group</span>
            <input
              name="conversationId"
              required
              className="rounded-md border border-line bg-surface px-2 py-1"
            />
          </label>
        </StepForm>
      ) : null}

      {card.state === 'mapped' ? (
        <StepForm
          action={verifyGroupAction}
          card={card}
          projectId={projectId}
          label="I have checked it — the right people are in"
        />
      ) : null}

      {/* §6's audit line: who confirmed, when. Shown, not just stored. */}
      {card.state !== 'pending' ? (
        <dl className="flex flex-col gap-0.5 text-xs text-muted">
          {card.createdAtWhatsapp ? (
            <div className="flex gap-2"><dt>Created</dt><dd className="tabular">{card.createdAtWhatsapp.slice(0, 16).replace('T', ' ')}</dd></div>
          ) : null}
          {card.mappedAt ? (
            <div className="flex gap-2"><dt>Mapped</dt><dd className="tabular">{card.mappedAt.slice(0, 16).replace('T', ' ')}</dd></div>
          ) : null}
          {card.verifiedAt ? (
            <div className="flex gap-2"><dt>Verified</dt><dd className="tabular">{card.verifiedAt.slice(0, 16).replace('T', ' ')}</dd></div>
          ) : null}
          {card.note ? <div className="flex gap-2"><dt>Note</dt><dd>{card.note}</dd></div> : null}
        </dl>
      ) : null}
    </div>
  );
}
