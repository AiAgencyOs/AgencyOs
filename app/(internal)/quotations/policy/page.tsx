import type { Metadata } from 'next';
import Link from 'next/link';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listOpenTaxFlags, readQuotationPolicy } from '@/modules/sales/p1o-quotation-service';
import { Badge, Card, CardBody, CardHeader, EmptyState, PageHeader, PermissionDenied, buttonClass } from '@/ui';

import { LimitsForm, ResolveTaxFlagForm, TaxConfigForm } from './policy-forms';

export const metadata: Metadata = { title: 'Quotation policy' };

const rupees = (minor: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(minor / 100);

/**
 * The policy a quotation is judged under (P1-QUOTE-008/018/019/023/025/059). The tax mode and rate are configured here, not hard-coded or guessed; the negotiation
 * limits are recorded for the approver; the approver ladder and payment structures are shown as they stand. The same snapshot is stamped onto a quotation when it
 * enters review, with a version, so a changed setting can be told apart from an old quote. Unresolved tax questions are listed: a quotation with one cannot go
 * for approval.
 */
export default async function QuotationPolicyPage() {
  const context = await requireInternal('/quotations/policy');
  if (!can(context, 'lead.read')) return <PermissionDenied />;
  if (!context.organizationId) return <EmptyState title="No organisation" />;
  const [policy, flags] = await Promise.all([readQuotationPolicy(context.organizationId), listOpenTaxFlags()]);
  const canEdit = can(context, 'organization.settings');

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Quotation policy" description="What a quotation is judged under. Saved settings here are stamped onto each quotation, with a version, when it goes for approval." actions={<Link href="/quotations" className={buttonClass('secondary', 'sm')}>All quotations</Link>} />

      <Card>
        <CardHeader title="Tax" description="Applied to a draft from this configuration. If it is not set, or GST is chosen but the organisation has no GSTIN, the quotation is flagged instead of guessed." actions={<Badge tone={policy.tax ?'success' : 'warning'} dot>{policy.tax ? `${policy.tax.mode === 'gst' ? `GST ${policy.tax.rateBp / 100}%` : 'No GST'}` : 'not configured'}</Badge>} />
        <CardBody>
          <TaxConfigForm mode={policy.tax?.mode ?? null} ratePercent={policy.tax && policy.tax.mode === 'gst' ? String(policy.tax.rateBp / 100) : ''} canEdit={canEdit} />
          <p className="mt-2 text-xs text-muted">{policy.gstRegistered ? 'The organisation has a GSTIN on record.' : 'The organisation has no GSTIN on record; set it in settings before charging GST.'}</p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Negotiation limits" description="Recorded on a quotation that breaches them. The owner still decides every quotation and sees the breach." />
        <CardBody>
          <LimitsForm maxDiscountRupees={policy.limits?.maxDiscountMinor !== null && policy.limits?.maxDiscountMinor !== undefined ? String(policy.limits.maxDiscountMinor / 100) : ''} minAdvance={policy.limits?.minAdvancePct !== null && policy.limits?.minAdvancePct !== undefined ? String(policy.limits.minAdvancePct) : ''} canEdit={canEdit} />
          <p className="mt-2 text-xs text-muted">The percentage cap, the minimum price, the autonomous-quote ceiling and the round limit are in Settings; a maximum deferral and a free-scope cap are not built (they need your rules).</p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Who approves, and the payment structures" />
        <CardBody>
          <ul className="text-sm">
            {policy.approvalPolicies.length === 0 ? <li className="text-muted">No approval policy for quotations: nothing can be submitted for approval.</li> : policy.approvalPolicies.map((a, i) => <li key={i}>From {rupees(a.minAmountMinor)}: {a.requiredRole.replace('_', ' ')} within {a.slaHours} h</li>)}
          </ul>
          <p className="mt-2 text-sm">Payment structures: {policy.paymentStructures.length === 0 ? 'none configured' : policy.paymentStructures.map((s) => s.name).join(', ')}</p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Tax questions waiting for you" description="A quotation with one of these cannot be submitted for approval." />
        <CardBody>
          {flags.length === 0 ? <EmptyState title="None" /> : (
            <ul className="flex flex-col gap-3">
              {flags.map((f) => (
                <li key={f.id} className="rounded-lg border border-line p-3 text-sm">
                  <p>{f.note}</p>
                  <p className="mt-1 text-xs text-muted">Raised {new Date(f.raisedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</p>
                  {canEdit ? <div className="mt-2"><ResolveTaxFlagForm flagId={f.id} /></div> : null}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
