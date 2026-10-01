import type { Metadata } from 'next';

import { quotationValidityDays } from '@/lib/admin/operational-defaults';
import { readOperationalSettings } from '@/lib/admin/settings';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listLeadsForTable, listThirdPartyCharges } from '@/modules/crm/queries';
import { listInternalRoster } from '@/modules/projects/queries';
import { readClausesInForce } from '@/modules/sales/clauses-service';
import { listDealBillingModes } from '@/modules/sales/composer-queries';
import { listPipelineOpportunities } from '@/modules/sales/pipeline-queries';
import { listPaymentStructures } from '@/modules/sales/queries';
import { clauseBodies } from '@/modules/sales/quotation-clauses';
import { commercialTermsFor } from '@/modules/sales/quotation-standards';
import { isOpenOpportunity, type OpportunityStage } from '@/modules/sales/schema';
import { PermissionDenied } from '@/ui';

import { TrailLabel } from '../../trail-label';
import { QuotationComposer, type ComposerDeal } from './composer';

export const metadata: Metadata = { title: 'Create Quotation' };

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
  if (!can(context, 'proposal.draft')) return <PermissionDenied />;
  const { opportunity } = await searchParams;

  const mayAssign = can(context, 'lead.assign');
  const [opportunities, leads, settings, charges, structures, roster] = await Promise.all([
    listPipelineOpportunities(200),
    listLeadsForTable(500),
    readOperationalSettings(),
    listThirdPartyCharges(),
    listPaymentStructures(),
    mayAssign ? listInternalRoster() : Promise.resolve([]),
  ]);
  const validityDays = quotationValidityDays(settings);
  const leadById = new Map(leads.map((l) => [l.id, l]));
  // SCR-012 — the GST pre-fill reads the confirmed billing mode of deals
  // that already have a project; the rest stay manual.
  const billingModes = await listDealBillingModes(opportunities.map((o) => o.id));

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
        ownerId: o.owner_id,
        billingMode: billingModes.get(o.id) ?? null,
      };
    });

  // Audit B-6 — the standard terms with the owner's clause wording in them, so
  // the textarea starts from what a quotation would actually print. A failed
  // read refuses rather than offering the constants over the owner's words.
  const inForce = await readClausesInForce();
  if (!inForce.ok) throw new Error(inForce.error.message);
  const defaultTerms = commercialTermsFor(undefined, clauseBodies(inForce.data));
  const defaultValidUntil = new Date(Date.now() + validityDays * 86_400_000).toISOString().slice(0, 10);

  return (
    <div className="flex flex-col gap-5">
      <TrailLabel name="Create quotation" />
      <QuotationComposer deals={deals} defaultValidUntil={defaultValidUntil} validityDays={validityDays} defaultTerms={defaultTerms} taxRatePercent={18} initialOpportunityId={opportunity} charges={charges} structures={structures} roster={mayAssign ? roster : undefined} />
    </div>
  );
}
