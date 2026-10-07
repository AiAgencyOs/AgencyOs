'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, inputClass } from '@/ui';

import { setOverlapRuleAction } from './overlap-actions';

/** P1-SCHED-036: whether two booked meetings may overlap. Off until the owner decides (one booking calendar, or several). */
export function OverlapRuleForm({ current, canEdit }: { current: boolean; canEdit: boolean }) {
  const [state, action, pending] = useActionState(setOverlapRuleAction, IDLE_STATE);
  if (!canEdit) return <p className="text-xs text-muted">Only an owner or ops admin can change this.</p>;
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="prevent" defaultChecked={current} />
        Refuse a booking that overlaps another booked meeting
      </label>
      <input name="reason" required maxLength={500} placeholder="why (kept with the change)" aria-label="Why this setting" className={`${inputClass} h-8 w-72 text-xs`} />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>{pending ? 'Saving…' : 'Save'}</button>
      <FormMessage status={state.status} message={state.message} className="text-xs" />
    </form>
  );
}
