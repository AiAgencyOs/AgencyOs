'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, FormMessage } from '@/ui';

import { createFigmaCodeAction } from './actions';

type Issued = { code: string; projectId: string; address: string; hours: number };

const CopyRow = ({ label, value, secret }: { label: string; value: string; secret?: boolean }) => (
  <label className="flex flex-col gap-1">
    <span className="text-xs font-medium text-muted">{label}</span>
    <input readOnly value={value} type={secret ? 'text' : 'text'} onFocus={(e) => e.currentTarget.select()} className="w-full rounded-md border border-line bg-surface-sunken px-2 py-1.5 font-mono text-xs" />
  </label>
);

/** Creates the plugin code. The code is shown once, here, and kept nowhere. */
export function FigmaCodeForm({ projectId }: { projectId: string }) {
  const [state, action, pending] = useActionState(createFigmaCodeAction, IDLE_STATE);
  let issued: Issued | null = null;
  if (state.status === 'success') {
    try {
      issued = JSON.parse(state.message ?? '') as Issued;
    } catch {
      issued = null;
    }
  }
  return (
    <div className="flex flex-col gap-3">
      <form action={action} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="projectId" value={projectId} />
        <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')}>
          {pending ? 'Creating…' : 'Create plugin code'}
        </button>
        {state.status === 'error' ? <FormMessage status="error" message={state.message} className="text-xs" /> : null}
      </form>
      {issued ? (
        <div className="flex flex-col gap-2 rounded-lg border border-line p-3">
          <p className="text-xs text-muted">Paste these three into the plugin. The code works for {issued.hours} hours, only for this project, and is not shown again.</p>
          <CopyRow label="AgencyOS address" value={issued.address || '(set NEXT_PUBLIC_APP_URL, or type your deployment address)'} />
          <CopyRow label="Project id" value={issued.projectId} />
          <CopyRow label="Plugin code" value={issued.code} secret />
        </div>
      ) : null}
    </div>
  );
}
