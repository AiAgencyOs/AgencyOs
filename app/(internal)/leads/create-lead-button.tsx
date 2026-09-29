'use client';

import { buttonClass, IconPlus } from '@/ui';

import { OPEN_CREATE_EVENT } from '../shell-controls';

/** "+ Add lead" — opens the same quick-create the header's Create button does. */
export function CreateLeadButton() {
  return (
    <button type="button" onClick={() => window.dispatchEvent(new CustomEvent(OPEN_CREATE_EVENT))} className={buttonClass('primary', 'sm')}>
      <IconPlus size={14} />
      Add lead
    </button>
  );
}
