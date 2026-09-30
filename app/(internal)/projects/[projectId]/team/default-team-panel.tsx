'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect } from 'react';

import { addTeamDefaultAction, removeTeamDefaultAction } from '@/modules/projects/actions';
import { IDLE_STATE } from '@/modules/identity/types';
import type { TeamDefault } from '@/modules/projects/queries';
import { Badge, FormMessage, buttonClass, inputClass, labelClass } from '@/ui';

/**
 * SCR-025 — assign / remove members with a role, through the doors that
 * exist: `addTeamDefaultAction` / `removeTeamDefaultAction` over
 * `projects.group_team_defaults`. That table is the AGENCY's default team
 * (Master §5.5), not a per-project roster — there is no project_members
 * table — so the card says so, and a change here reaches every project's
 * next group card, not only this one's.
 *
 * The actions revalidate `/settings`, where they were built; this page
 * refreshes itself on success so the list here does not lag behind.
 */
function AddForm() {
  const router = useRouter();
  const [state, action, pending] = useActionState(addTeamDefaultAction, IDLE_STATE);
  useEffect(() => {
    if (state.status === 'success') router.refresh();
  }, [state, router]);

  return (
    <form action={action} className="flex flex-wrap items-end gap-2 border-t border-line px-4 py-3 sm:px-5">
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Name</span>
        <input name="displayName" required placeholder="Priya" className={inputClass} />
      </label>
      <label className="flex flex-col gap-1">
        <span className={labelClass}>WhatsApp number</span>
        <input name="phone" required inputMode="tel" placeholder="+919876543210" className={`${inputClass} tabular`} />
      </label>
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Project role</span>
        <input name="role" placeholder="Project manager" className={inputClass} />
      </label>
      <button type="submit" className={buttonClass('secondary', 'sm')} disabled={pending}>
        {pending ? 'Adding…' : 'Add to default team'}
      </button>
      <FormMessage status={state.status} message={state.message} />
    </form>
  );
}

function RemoveForm({ memberId }: { memberId: string }) {
  const router = useRouter();
  const [state, action, pending] = useActionState(removeTeamDefaultAction, IDLE_STATE);
  useEffect(() => {
    if (state.status === 'success') router.refresh();
  }, [state, router]);

  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="memberId" value={memberId} />
      <button type="submit" className={buttonClass('ghost', 'sm')} disabled={pending}>
        {pending ? 'Removing…' : 'Remove'}
      </button>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}

export function DefaultTeamPanel({ members, mayEdit }: { members: TeamDefault[]; mayEdit: boolean }) {
  return (
    <div className="flex flex-col">
      {members.length === 0 ? (
        <p className="px-4 py-3 text-[13px] text-muted sm:px-5">Nobody on the default team yet.</p>
      ) : (
        <ul className="divide-y divide-line">
          {members.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-[13px] sm:px-5">
              <span className="flex flex-wrap items-baseline gap-2">
                <span className="font-medium text-foreground">{m.displayName}</span>
                <span className="tabular text-muted">{m.phone}</span>
                {m.role ? <span className="text-muted">{m.role}</span> : null}
                {m.active ? null : <Badge tone="neutral">not on new groups</Badge>}
              </span>
              {mayEdit ? <RemoveForm memberId={m.id} /> : null}
            </li>
          ))}
        </ul>
      )}
      {mayEdit ? <AddForm /> : null}
    </div>
  );
}
