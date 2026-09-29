'use client';

import { buttonClass, IconPlus } from '@/ui';

import { openQuickCreate, type CreateMode } from '../shell-controls';

/** "+ Add lead" / "+ Add client" — opens the same quick-create the header's Create button does, on that form. */
export function CreateLeadButton({ mode = 'lead', label = 'Add lead' }: { mode?: CreateMode; label?: string }) {
  return (
    <button type="button" onClick={() => openQuickCreate(mode)} className={buttonClass('primary', 'sm')}>
      <IconPlus size={14} />
      {label}
    </button>
  );
}
