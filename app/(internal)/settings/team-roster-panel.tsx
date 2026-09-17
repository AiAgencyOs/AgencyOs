'use client';

import { useActionState } from 'react';

import {
  addTeamDefaultAction,
  removeTeamDefaultAction,
  setTeamDefaultActiveAction,
} from '@/modules/projects/actions';
import type { TeamDefault } from '@/modules/projects/queries';
import { IDLE_STATE } from '@/modules/identity/types';
import { Badge, buttonClass } from '@/ui';

/**
 * The default team — Master §6, P2-05; G-267.
 *
 * G-253 built `group_team_defaults` with a SELECT policy and no way in. The
 * table has been read onto every group card since and there has never been a
 * door to put anybody in it, so every card shipped with the client's contacts
 * and none of the agency's own people.
 *
 * Two things this panel is careful to say, because both are easy to assume
 * wrongly.
 *
 * **A change here does not touch a group that already exists.** A card copies
 * the roster at the moment it is requested — deliberately, so that a group
 * created in March is not rewritten by a hire in September. Removing somebody
 * here leaves them on every card already prepared, and the copy is what the
 * person adding members to WhatsApp actually works from.
 *
 * **Nothing here adds anybody to a WhatsApp group.** Meta refused this WABA
 * the Groups API (#131215, ADM-95), so the card is a list a person works from
 * by hand. This is the list.
 */

function AddForm() {
  const [state, action, pending] = useActionState(addTeamDefaultAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-1 text-[13px]">
        <span className="text-xs text-muted">Name</span>
        <input
          name="displayName"
          required
          placeholder="Priya"
          className="rounded-md border border-line bg-surface px-2 py-1"
        />
      </label>
      <label className="flex flex-col gap-1 text-[13px]">
        <span className="text-xs text-muted">WhatsApp number</span>
        <input
          name="phone"
          required
          inputMode="tel"
          placeholder="+919876543210"
          className="rounded-md border border-line bg-surface px-2 py-1 tabular"
        />
      </label>
      <label className="flex flex-col gap-1 text-[13px]">
        <span className="text-xs text-muted">Role (optional)</span>
        <input
          name="role"
          placeholder="Project manager"
          className="rounded-md border border-line bg-surface px-2 py-1"
        />
      </label>
      <button type="submit" className={buttonClass('primary')} disabled={pending}>
        {pending ? 'Adding…' : 'Add to default team'}
      </button>
      {state.status === 'error' ? (
        <span className="text-[13px] text-danger">{state.message}</span>
      ) : null}
      {state.status === 'success' ? (
        <span className="text-[13px] text-muted">{state.message}</span>
      ) : null}
    </form>
  );
}

function MemberRow({ member }: { member: TeamDefault }) {
  const [activeState, activeAction, activePending] = useActionState(
    setTeamDefaultActiveAction,
    IDLE_STATE,
  );
  const [removeState, removeAction, removePending] = useActionState(
    removeTeamDefaultAction,
    IDLE_STATE,
  );
  const error = activeState.status === 'error' ? activeState : removeState;

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
      <span className="flex flex-wrap items-baseline gap-2">
        <span className="font-medium">{member.displayName}</span>
        <span className="tabular text-muted">{member.phone}</span>
        {member.role ? <span className="text-muted">{member.role}</span> : null}
        {member.active ? null : <Badge tone="neutral">not on new groups</Badge>}
      </span>
      <span className="flex items-center gap-2">
        <form action={activeAction}>
          <input type="hidden" name="memberId" value={member.id} />
          <input type="hidden" name="active" value={member.active ? 'false' : 'true'} />
          <button type="submit" className={buttonClass('secondary')} disabled={activePending}>
            {member.active ? 'Leave off new groups' : 'Put back on new groups'}
          </button>
        </form>
        <form action={removeAction}>
          <input type="hidden" name="memberId" value={member.id} />
          <button type="submit" className={buttonClass('ghost')} disabled={removePending}>
            Remove
          </button>
        </form>
        {error.status === 'error' ? <span className="text-danger">{error.message}</span> : null}
      </span>
    </li>
  );
}

export function TeamRosterPanel({ members }: { members: TeamDefault[] }) {
  const active = members.filter((member) => member.active).length;

  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-[13px] font-semibold tracking-tight">Default team members</h2>
      <p className="text-xs text-muted">
        Everyone here is listed on the card for each new project group, alongside the client’s own
        contacts. AgencyOS cannot add anybody to a WhatsApp group — Meta refused this number the
        Groups API — so the card is the list a person works from by hand.
      </p>
      {/*
        Said here, not only in the code: somebody deactivating a member who has
        left will otherwise expect the groups they are already in to change.
      */}
      <p className="text-xs text-muted">
        Changes apply to groups requested from now on. A card keeps the team it was prepared with,
        so a group set up in March is not rewritten by a change made today.
      </p>

      {members.length === 0 ? (
        <p className="text-[13px] text-muted">
          Nobody yet — every group card so far has carried only the client’s contacts.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {members.map((member) => (
            <MemberRow key={member.id} member={member} />
          ))}
        </ul>
      )}

      <AddForm />

      {members.length > 0 ? (
        <p className="text-xs text-muted">
          {active} of {members.length} go on new group cards.
        </p>
      ) : null}
    </div>
  );
}
