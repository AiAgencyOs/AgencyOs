import type { Metadata } from 'next';

import { quotationValidityDays } from '@/lib/admin/operational-defaults';
import { readOperationalSettings } from '@/lib/admin/settings';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listLeadsForTable, listThirdPartyCharges } from '@/modules/crm/queries';
import { listOpportunities, listPaymentStructures } from '@/modules/sales/queries';
import { isOpenOpportunity, type OpportunityStage } from '@/modules/sales/schema';
import { PageHeader, PermissionDenied } from '@/ui';

import { TrailLabel } from '../../trail-label';
import { QuotationComposer, type ComposerDeal } from './composer';

export const metadata: Metadata = { title: 'Create quotation' };

/**
 * SCR-012 — the quotation composer, the reference's one-screen "Create
 * Quotation". Everything on it is the Lead 360's own governed steps in one
 * pass (`composeQuotationAction`): draft → lines → pricing → submit for the
 * owner's approval. The deal list is every OPEN opportunity the caller may
 * read, named by its lead; a quotation cannot exist without one, because
 * that is where the accepted price lands.
 */
export default async function NewQuotationPage({ searchParams }: { searchParams: Promise<{ opportunity?: string }> }) {
  const context = await requireInternal('/quotations/new');
  if (!can(context.role, 'proposal.draft')) return <PermissionDenied />;
  const { opportunity } = await searchParams;

  const [opportunities, leads, settings, charges, structures] = await Promise.all([listOpportunities(200), listLeadsForTable(500), readOperationalSettings(), listThirdPartyCharges(), listPaymentStructures()]);
  const validityDays = quotationValidityDays(settings);
  const leadById = new Map(leads.map((l) => [l.id, l]));

  const deals: ComposerDeal[] = opportunities
    .filter((o): o is typeof o & { lead_id: string } => o.lead_id !== null && isOpenOpportunity(o.stage as OpportunityStage))
    .map((o) => {
      const lead = leadById.get(o.lead_id);
      return {
        opportunityId: o.id,
        leadId: o.lead_id,
        name: o.name,
        leadTitle: lead?.title ?? 'Lead',
        contactName: lead?.contact?.fullName ?? null,
        contactPhone: lead?.contact?.phone ?? null,
        company: lead?.contact?.company ?? null,
        stage: o.stage,
        currency: o.currency,
        valueMinor: o.value_minor,
      };
    });

  const defaultValidUntil = new Date(Date.now() + validityDays * 86_400_000).toISOString().slice(0, 10);

  return (
    <div className="flex flex-col gap-5">
      <TrailLabel name="Create quotation" />
      <PageHeader title="Create quotation" description="Create a professional quotation for your client — drafted, itemised, priced and sent to the owner for approval in one pass." />
      <QuotationComposer deals={deals} defaultValidUntil={defaultValidUntil} validityDays={validityDays} taxRatePercent={18} initialOpportunityId={opportunity} charges={charges} structures={structures} />
    </div>
  );
}
