import type { Metadata } from 'next';
import Link from 'next/link';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listProjectBillingSummaries } from '@/modules/finance/queries';
import { readGstIdentity } from '@/modules/finance/gstr-queries';
import { buttonClass, Card, EmptyState, IconInvoices, PageHeader, PermissionDenied } from '@/ui';

import { TrailLabel } from '../../trail-label';

import { ComposerForm } from './composer-form';

export const metadata: Metadata = { title: 'New Invoice' };

/**
 * Compose an invoice — SCR-052. A hand-built draft for a project: tax mode
 * and billing profile from the project's confirmed profile, line items, a tax
 * calculation, a review step, then a draft. `invoice.create` is the same gate
 * as the milestone path; the door re-checks it and the role.
 */
export default async function NewInvoicePage() {
  const context = await requireInternal('/invoices/new');
  if (!can(context, 'invoice.create')) return <PermissionDenied />;

  const [projects, identity] = await Promise.all([listProjectBillingSummaries(), readGstIdentity()]);

  return (
    <div className="flex flex-col gap-5">
      <TrailLabel name="New invoice" />
      <PageHeader
        title="New Invoice"
        description="Compose a draft for a project: lines, tax by the project's confirmed billing mode, then review. Issuing is a separate step on the invoice."
        actions={<Link href="/invoices" className={buttonClass('secondary', 'sm')}>All invoices</Link>}
      />
      {projects.length === 0 ? (
        <EmptyState
          icon={<IconInvoices size={22} />}
          title="No project to bill yet"
          description="An invoice belongs to a project, which carries the client and the billing profile."
          action={<Link href="/projects" className={buttonClass('secondary', 'sm')}>Open projects</Link>}
        />
      ) : (
        <Card>
          <div className="p-4 sm:p-5">
            <ComposerForm projects={projects} supplierStateCode={identity.stateCode} />
          </div>
        </Card>
      )}
    </div>
  );
}
