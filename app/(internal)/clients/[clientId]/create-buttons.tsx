'use client';

import Link from 'next/link';

import { buttonClass, IconPlus } from '@/ui';

import { openQuickCreate } from '../../shell-controls';

/**
 * SCR-015's three create buttons, each pointing at the flow that exists
 * rather than a form invented here.
 *
 * - **Create project**: a project is created by winning a deal on a lead,
 *   so this opens the quick-create on a new lead when the client has no
 *   open deal, or goes to the deal's lead when it has one.
 * - **Create quote**: the quotation composer, pre-selected on the client's
 *   open opportunity (`/quotations/new?opportunity=`).
 * - **Create invoice**: the project's billing section, where an invoice is
 *   generated from the next unlocked milestone — or the Invoices tab here,
 *   which offers the same door for the eligible milestone.
 */
export function ClientCreateButtons({
  leadId,
  opportunityId,
  invoiceHref,
}: {
  leadId: string | null;
  opportunityId: string | null;
  invoiceHref: string;
}) {
  return (
    <>
      {leadId ? (
        <Link href={`/leads/${leadId}`} className={buttonClass('secondary', 'sm')} title="A project is created by winning the deal on this client's lead.">
          <IconPlus size={14} />
          Create project
        </Link>
      ) : (
        <button type="button" onClick={() => openQuickCreate('lead')} className={buttonClass('secondary', 'sm')} title="A project is created by winning a deal on a lead — start one.">
          <IconPlus size={14} />
          Create project
        </button>
      )}
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
