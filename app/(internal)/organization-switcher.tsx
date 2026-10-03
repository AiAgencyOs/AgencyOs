'use client';

import { useActionState } from 'react';

import type { MyOrganization } from '@/lib/admin/organization-switch';
import { IDLE_STATE } from '@/modules/identity/types';
import { cx, FormMessage, humanize, selectClass } from '@/ui';

import { switchOrganizationAction } from './organization-actions';

/**
 * The organisation selector — SCR-001 "Global date range and organization
 * selector" (bucket F, stream F-A). Rendered only for a person who holds
 * more than one active membership (the layout decides that from
 * `listMyOrganizations`); everybody else keeps the plain organisation chip.
 * Changing the select submits at once: the switch is a governed, audited
 * write (`core.switch_organization`), so it goes through a form and a
 * Server Action like every other write, and its refusal is shown here.
 */
export function OrganizationSwitcher({ organizations, className }: { organizations: MyOrganization[]; className?: string }) {
  const [state, action, pending] = useActionState(switchOrganizationAction, IDLE_STATE);
  const current = organizations.find((o) => o.isCurrent) ?? organizations[0];

  return (
    <form action={action} className={cx('flex min-w-0 flex-col gap-1', className)}>
      <label htmlFor="organization-switcher" className="sr-only">
        Organisation
      </label>
      <select
        id="organization-switcher"
        name="organizationId"
        defaultValue={current?.organizationId ?? ''}
        disabled={pending}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        aria-label="Switch organisation"
        className={cx(selectClass, 'h-8 w-full border-sidebar-border bg-sidebar-hover text-[13px] font-semibold text-sidebar-fg')}
      >
        {organizations.map((o) => (
          <option key={o.organizationId} value={o.organizationId}>
            {o.name} · {humanize(o.role)}
          </option>
        ))}
      </select>
      {pending ? <span className="text-[11px] text-sidebar-muted">Switching…</span> : null}
      <FormMessage status={state.status} message={state.message} className="text-[11px]" />
    </form>
  );
}
