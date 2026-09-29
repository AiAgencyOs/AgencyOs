'use client';

import Link from 'next/link';

import { buttonClass, IconPlus } from '@/ui';

import { ClientCreateProjectButton } from './client-360-forms';

/**
 * SCR-015's three create buttons, each pointing at the flow that exists
 * rather than a form invented here.
 *
 * - **Create project**: the manual project door's own form (bucket D),
 *   with this client pre-filled (SCR-015).
 * - **Create quote**: the quotation composer, pre-selected on the client's
 *   open opportunity (`/quotations/new?opportunity=`).
 * - **Create invoice**: the project's billing section, where an invoice is
 *   generated from the next unlocked milestone — or the Invoices tab here,
 *   which offers the same door for the eligible milestone.
 */
export function ClientCreateButtons({
  clientAccountId,
  opportunityId,
  invoiceHref,
}: {
  clientAccountId: string;
  opportunityId: string | null;
  invoiceHref: string;
}) {
  return (
    <>
      {/* SCR-015 — through the manual project door, this client pre-filled. */}
      <ClientCreateProjectButton clientAccountId={clientAccountId} />
      <Link
        href={opportunityId ? `/quotations/new?opportunity=${opportunityId}` : '/quotations/new'}
        className={buttonClass('secondary', 'sm')}
        title="Draft a quotation on this client's open deal."
      >
        <IconPlus size={14} />
        Create quote
      </Link>
      <Link href={invoiceHref} className={buttonClass('primary', 'sm')} title="An invoice is generated from a project's next unlocked milestone.">
        <IconPlus size={14} />
        Create invoice
      </Link>
    </>
  );
}
