import type { Metadata } from 'next';

import { requireInternal } from '@/lib/auth/session';
import { createClient } from '@/lib/db/server';

import {
  ApprovedOfferForm,
  NegotiationLimitsForm,
  PaymentTermsForm,
  PricingModelForm,
  ThirdPartyChargesForm,
} from '../forms';

export const metadata: Metadata = { title: 'Settings — Commercial' };

export default async function SettingsCommercialPage() {
  await requireInternal('/settings');

  const supabase = await createClient();
  const { data: orgRows } = await supabase.schema('core').from('organizations').select('settings').limit(1);
  const orgSettings = (orgRows?.[0]?.settings ?? {}) as Record<string, unknown>;
  const setting = (key: string) => (typeof orgSettings[key] === 'string' ? (orgSettings[key] as string) : null);

  // G-179 — the pricing model's own inputs. Read as written; the reader in
  // production-cost.ts is what decides whether the five of them make a
  // coherent model, and an incoherent set says nothing rather than guessing.
  const dayRate = setting('pricing_day_rate_rupees');
  const aiDayRate = setting('pricing_ai_day_rate_rupees');
  const multiplierMin = setting('pricing_multiplier_min');
  const multiplierTarget = setting('pricing_multiplier_target');
  const multiplierMax = setting('pricing_multiplier_max');
  const pricingModelConfigured = Boolean(dayRate && aiDayRate && multiplierMin && multiplierTarget && multiplierMax);

  // G-195 — Doc §21's limits. Read as written and shown as written: each is
  // independently optional, and an empty box means no limit rather than an
  // unfinished form.
  const maxRounds = setting('negotiation_max_rounds');
  const minPrice = setting('negotiation_min_price_rupees');
  const maxDiscount = setting('negotiation_max_discount_pct');
  const maxAutonomous = setting('negotiation_max_autonomous_quote_rupees');
  const anyLimitSet = Boolean(maxRounds || minPrice || maxDiscount || maxAutonomous);

  // G-184 — the standing offer, read through the sales module's own surface.
  // A failed read refuses rather than rendering "no offer", which would tell
  // the owner nothing is authorised while the agent is still applying one.
  const { readApprovedOffer } = await import('@/modules/sales/service');
  const offerResult = await readApprovedOffer();
  const offer = offerResult.ok ? offerResult.data : null;

  // G-196 — the agency's own payment terms. A failed read refuses for the
  // same reason the offer's does: telling an owner their terms are unset
  // while quotations still draw them is worse than telling them nothing.
  // G-201 — what the agency charged itself for AI against what AI cost. Both
  // halves are rows; a failed read refuses rather than reporting a zero.
  const { readAiSpendComparison } = await import('@/modules/sales/service');
  const { aiSpendSentence, aiSpendLooksLow } = await import('@/modules/sales/ai-spend');
  const spendResult = await readAiSpendComparison();
  const spend = spendResult.ok ? spendResult.data : null;
  const spendSentence = spend ? aiSpendSentence(spend) : null;
  const spendLooksLow = spend ? aiSpendLooksLow(spend) : false;

  // G-207 — the third-party charges the Admin maintains, and the only figures
  // a quotation may print for them. A failed read refuses (G-054) rather than
  // showing an empty list while quotations go on citing it.
  const { readThirdPartyCharges } = await import('@/modules/crm/service');
  const chargesResult = await readThirdPartyCharges();
  const charges = chargesResult.ok ? chargesResult.data : [];

  const { readPaymentStructures } = await import('@/modules/sales/service');
  const termsResult = await readPaymentStructures();
  const paymentTerms = termsResult.ok ? (termsResult.data[0] ?? null) : null;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h2 className="text-[13px] font-semibold tracking-tight">What the work costs</h2>
        <p className="text-xs text-muted">
          {pricingModelConfigured
            ? 'Set. A quotation drafted below your minimum band shows the owner what it cost to produce and what your bands are. A client never sees any of it.'
            : 'Not set — no quotation shows a cost band, and nothing warns you about one priced below cost. Fill in all five to turn it on.'}
        </p>
        <p className="text-xs text-muted">
          What a developer-day costs to build, what AI and tooling add per day, and the three
          multipliers above cost — minimum, recommended and premium. These are references shown
          only to whoever approves; the price itself is always yours to set.
        </p>
        {spendSentence ? (
          <p className="text-xs text-muted">
            {spendLooksLow ? <strong>Worth a look. </strong> : null}
            {spendSentence}
          </p>
        ) : null}
        <PricingModelForm
          dayRate={dayRate}
          aiDayRate={aiDayRate}
          multiplierMin={multiplierMin}
          multiplierTarget={multiplierTarget}
          multiplierMax={multiplierMax}
        />
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="text-[13px] font-semibold tracking-tight">When the client pays</h2>
        <p className="text-xs text-muted">
          {paymentTerms
            ? `Set — “${paymentTerms.name}”, ${paymentTerms.milestones.length} milestone${paymentTerms.milestones.length === 1 ? '' : 's'}. New quotations carry it; ones already drafted keep the terms they were drafted with.`
            : 'Not set — quotations use the two standard schedules: 40/30/30 under ₹1,00,000 and 30/30/25/15 at or above it. Fill this in to use your own.'}
        </p>
        <p className="text-xs text-muted">
          Milestones must add up to 100%. Name what has to <em>happen</em> for each payment rather
          than when it falls due — a demo is a promise about work, a date is a promise about a
          calendar.
        </p>
        <PaymentTermsForm structure={paymentTerms} />

        <h3 className="mt-6 text-sm font-medium">Third-party charges</h3>
        <p className="text-xs text-muted">
          What a quotation is allowed to say a gateway, store or service costs. The agent may cite
          one of these and cannot write a figure of its own.
        </p>
        <ThirdPartyChargesForm charges={charges} />
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="text-[13px] font-semibold tracking-tight">Limits on what the agent may do alone</h2>
        <p className="text-xs text-muted">
          {anyLimitSet
            ? 'Set. These bound what happens with nobody looking. None of them can refuse a decision you make yourself.'
            : 'None set — nothing bounds the agent beyond the rules already built in. Every box is optional; fill in the ones you have a number for.'}
        </p>
        <NegotiationLimitsForm
          maxRounds={maxRounds}
          minPrice={minPrice}
          maxDiscount={maxDiscount}
          maxAutonomous={maxAutonomous}
        />
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="text-[13px] font-semibold tracking-tight">An offer the agent may apply</h2>
        <p className="text-xs text-muted">
          {offer
            ? `Authorised: ${offer.label} — ${offer.discountPct}% off, because ${offer.condition}.${
                offer.validUntil ? ` Until ${offer.validUntil}.` : ' No end date.'
              }`
            : 'None. On a price objection the agent redrafts and asks you, which is the behaviour with no offer set.'}
        </p>
        <p className="text-xs text-muted">
          This is the one place you give the agent authority rather than configure one it already
          has. With an offer set, a client who pushes back on price can be given this concession —
          once per deal, never below your own minimum band, and never past its date — without the
          agent coming back to you. You are told each time. Clear all three fields to withdraw it.
        </p>
        <ApprovedOfferForm
          label={offer?.label ?? null}
          condition={offer?.condition ?? null}
          discountPct={offer?.discountPct ?? null}
          validUntil={offer?.validUntil ?? null}
        />
      </div>
    </div>
  );
}
