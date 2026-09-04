'use client';

import { useActionState } from 'react';

import { IDLE_STATE } from '@/modules/identity/types';
import { buttonClass, inputClass } from '@/ui';

import { upsertApprovalPolicyAction } from '@/modules/approvals/actions';
import { linkInternalRecipientAction, linkInternalGroupAction } from '@/modules/crm/actions';

import {
  setApprovedOfferAction,
  setOrganizationNameAction,
  setPricingModelAction,
  setProjectGroupIdentifierAction,
  setQuotationContactAction,
  setReactivationPilotAction,
  setTestRecipientAction,
  setTimezoneAction,
  setWhatsAppNumberAction,
  verifyWhatsAppAction,
  setNegotiationLimitsAction,
  setPaymentTermsAction,
} from './actions';

/** A few common IANA zones as suggestions; any valid IANA zone is accepted. */
const COMMON_ZONES = [
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Europe/London',
  'America/New_York',
  'America/Los_Angeles',
  'UTC',
];

function Message({ status, message }: { status: string; message?: string }) {
  if (status === 'idle' || !message) return null;
  return (
    <span className={`text-xs ${status === 'error' ? 'text-danger' : 'text-success'}`}>
      {message}
    </span>
  );
}

/**
 * The agency's own name — the letterhead on every quotation PDF (G-160).
 * Owner only, audited; the database refuses any other write of the column.
 */
export function OrganizationNameForm({ current }: { current: string }) {
  const [state, action, pending] = useActionState(setOrganizationNameAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          name="name"
          defaultValue={current}
          maxLength={120}
          placeholder="BussEnhancer"
          aria-label="Agency name"
          className={`${inputClass} w-72`}
        />
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Saving…' : 'Rename agency'}
        </button>
      </div>
      <Message status={state.status} message={state.message} />
    </form>
  );
}

export function TimezoneForm({ current }: { current: string | null }) {
  const [state, action, pending] = useActionState(setTimezoneAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input
        type="text"
        name="timezone"
        defaultValue={current ?? ''}
        placeholder="Asia/Kolkata"
        list="iana-zones"
        aria-label="Agency IANA timezone"
        className={inputClass}
      />
      <datalist id="iana-zones">
        {COMMON_ZONES.map((z) => (
          <option key={z} value={z} />
        ))}
      </datalist>
      <button
        type="submit"
        disabled={pending}
        className={buttonClass('secondary', 'sm')}
      >
        {pending ? 'Saving…' : current ? 'Update' : 'Set timezone'}
      </button>
      <Message status={state.status} message={state.message} />
    </form>
  );
}

export function WhatsAppNumberForm({ current }: { current: string | null }) {
  const [state, action, pending] = useActionState(setWhatsAppNumberAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input
        type="text"
        name="phone_number_id"
        defaultValue={current ?? ''}
        placeholder="123456789012345"
        inputMode="numeric"
        aria-label="WhatsApp phone number id"
        className={inputClass}
      />
      <button
        type="submit"
        disabled={pending}
        className={buttonClass('secondary', 'sm')}
      >
        {pending ? 'Saving…' : current ? 'Update' : 'Set number id'}
      </button>
      <Message status={state.status} message={state.message} />
    </form>
  );
}

export function TestRecipientForm({ current }: { current: string | null }) {
  const [state, action, pending] = useActionState(setTestRecipientAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input
        type="text"
        name="test_recipient"
        defaultValue={current ?? ''}
        placeholder="+919000000000"
        aria-label="Internal WhatsApp test recipient"
        className={inputClass}
      />
      <button
        type="submit"
        disabled={pending}
        className={buttonClass('secondary', 'sm')}
      >
        {pending ? 'Saving…' : current ? 'Update' : 'Set test number'}
      </button>
      <Message status={state.status} message={state.message} />
    </form>
  );
}

/**
 * The contact block printed on every quotation PDF — G-171.
 *
 * One form for the three keys, because they are one block on the document:
 * a client who gets an email with no phone number is barely better served
 * than one who gets neither. Any field left empty is cleared, and a document
 * with none of them set simply carries no contact line rather than an
 * invented one.
 */
export function QuotationContactForm({
  email,
  phone,
  location,
}: {
  email: string | null;
  phone: string | null;
  location: string | null;
}) {
  const [state, action, pending] = useActionState(setQuotationContactAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input
        type="email"
        name="contact_email"
        defaultValue={email ?? ''}
        placeholder="care@example.com"
        aria-label="Quotation contact email"
        className={inputClass}
      />
      <input
        type="text"
        name="contact_phone"
        defaultValue={phone ?? ''}
        placeholder="+91 90000 00000"
        inputMode="tel"
        aria-label="Quotation contact phone"
        className={inputClass}
      />
      <input
        type="text"
        name="contact_location"
        defaultValue={location ?? ''}
        placeholder="Mohali, Punjab"
        aria-label="Quotation contact location"
        className={inputClass}
      />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Saving…' : 'Save contact details'}
      </button>
      <Message status={state.status} message={state.message} />
    </form>
  );
}

/**
 * What the work costs, and the bands above it — G-179.
 *
 * Five fields and one button, because they are one model. The placeholders are
 * the owner's own stated principle (×2 / ×2.5 / ×3) rather than an invented
 * default: a pre-filled multiplier would be this system choosing a margin,
 * which is exactly what ADM-22 leaves to a person.
 */
export function PricingModelForm({
  dayRate,
  aiDayRate,
  multiplierMin,
  multiplierTarget,
  multiplierMax,
}: {
  dayRate: string | null;
  aiDayRate: string | null;
  multiplierMin: string | null;
  multiplierTarget: string | null;
  multiplierMax: string | null;
}) {
  const [state, action, pending] = useActionState(setPricingModelAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input
        type="text"
        name="day_rate"
        defaultValue={dayRate ?? ''}
        placeholder="Build ₹/day"
        inputMode="numeric"
        aria-label="Build cost per developer-day, in rupees"
        className={inputClass}
      />
      <input
        type="text"
        name="ai_day_rate"
        defaultValue={aiDayRate ?? ''}
        placeholder="AI ₹/day"
        inputMode="numeric"
        aria-label="AI and tooling cost per developer-day, in rupees"
        className={inputClass}
      />
      <input
        type="text"
        name="multiplier_min"
        defaultValue={multiplierMin ?? ''}
        placeholder="Min ×2"
        inputMode="decimal"
        aria-label="Minimum multiplier"
        className={inputClass}
      />
      <input
        type="text"
        name="multiplier_target"
        defaultValue={multiplierTarget ?? ''}
        placeholder="Target ×2.5"
        inputMode="decimal"
        aria-label="Recommended multiplier"
        className={inputClass}
      />
      <input
        type="text"
        name="multiplier_max"
        defaultValue={multiplierMax ?? ''}
        placeholder="Premium ×3"
        inputMode="decimal"
        aria-label="Premium multiplier"
        className={inputClass}
      />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Saving…' : 'Save pricing model'}
      </button>
      <Message status={state.status} message={state.message} />
    </form>
  );
}

/**
 * The fifth segment of a project group's name — G-188.
 *
 * One field, because the other four segments are facts about rows and this is
 * the only part of the name that is the owner's to choose.
 */
export function ProjectGroupIdentifierForm({ identifier }: { identifier: string | null }) {
  const [state, action, pending] = useActionState(setProjectGroupIdentifierAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input
        type="text"
        name="project_group_identifier"
        defaultValue={identifier ?? ''}
        placeholder="e.g. BussEnhancer"
        maxLength={40}
        aria-label="The last part of a project group's name"
        className={inputClass}
      />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Saving…' : 'Save identifier'}
      </button>
      <Message status={state.status} message={state.message} />
    </form>
  );
}

/**
 * The agency's own payment terms — G-196, Doc 07 §11.
 *
 * Eight rows, because eight is what the database accepts and a form that
 * offers fewer than the system allows is a form somebody works around. Blank
 * rows are ignored, so the common three-milestone schedule is three filled
 * rows and five left alone.
 *
 * The running total is shown as the person types, because the one rule this
 * form has — a hundred — is the one thing arithmetic can tell them before
 * they press Save.
 */
export function PaymentTermsForm({
  structure,
}: {
  structure: {
    name: string;
    minAmountMinor: number | null;
    maxAmountMinor: number | null;
    milestones: Array<{ label: string; pct: number }>;
  } | null;
}) {
  const [state, action, pending] = useActionState(setPaymentTermsAction, IDLE_STATE);
  const rows = Array.from({ length: 8 }, (_, i) => structure?.milestones[i] ?? null);

  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium">Name these terms</span>
          <input
            type="text"
            name="terms_name"
            defaultValue={structure?.name ?? 'Standard'}
            maxLength={60}
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium">From (₹, optional)</span>
          <input
            type="text"
            inputMode="numeric"
            name="terms_min_rupees"
            defaultValue={structure?.minAmountMinor ? String(structure.minAmountMinor / 100) : ''}
            placeholder="any"
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium">Up to (₹, optional)</span>
          <input
            type="text"
            inputMode="numeric"
            name="terms_max_rupees"
            defaultValue={structure?.maxAmountMinor ? String(structure.maxAmountMinor / 100) : ''}
            placeholder="any"
            className={inputClass}
          />
        </label>
      </div>

      <div className="flex flex-col gap-2">
        {rows.map((row, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              name={`milestone_label_${i}`}
              defaultValue={row?.label ?? ''}
              placeholder={i === 0 ? 'Advance — confirmation; work starts here' : 'What has to happen for this payment'}
              maxLength={120}
              aria-label={`Milestone ${i + 1} name`}
              className={`${inputClass} min-w-[18rem] flex-1`}
            />
            <input
              type="text"
              inputMode="decimal"
              name={`milestone_pct_${i}`}
              defaultValue={row ? String(row.pct) : ''}
              placeholder="%"
              aria-label={`Milestone ${i + 1} percentage`}
              className={`${inputClass} w-20 tabular`}
            />
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Saving…' : 'Save payment terms'}
        </button>
        <Message status={state.status} message={state.message} />
      </div>
    </form>
  );
}

/**
 * What the agent may do while nobody is looking — G-195, Doc §21.
 *
 * Every box may be left empty, and empty means no limit: §21 asks for these
 * to be configurable, and choosing a default here would be this product
 * choosing the agency's commercial policy.
 *
 * The copy under each says what it BOUNDS rather than what it is called,
 * because "maximum autonomous quote value" describes a field and "no price
 * above this reaches a client unless you send it yourself" describes what
 * happens.
 */
export function NegotiationLimitsForm({
  maxRounds,
  minPrice,
  maxDiscount,
  maxAutonomous,
}: {
  maxRounds: string | null;
  minPrice: string | null;
  maxDiscount: string | null;
  maxAutonomous: string | null;
}) {
  const [state, action, pending] = useActionState(setNegotiationLimitsAction, IDLE_STATE);

  const boxes = [
    {
      name: 'max_rounds',
      value: maxRounds,
      label: 'Rounds of redrafting',
      hint: 'After this many rounds on one deal the agent stops redrafting and hands the thread to you.',
      placeholder: 'e.g. 3',
    },
    {
      name: 'min_price',
      value: minPrice,
      label: 'Minimum price (₹)',
      hint: 'Your standing offer is never applied if it would take a quotation below this. You can still approve anything.',
      placeholder: 'e.g. 25000',
    },
    {
      name: 'max_discount',
      value: maxDiscount,
      label: 'Maximum discount (%)',
      hint: 'The most you can pre-authorise in a standing offer. A larger one is refused, not trimmed.',
      placeholder: 'e.g. 10',
    },
    {
      name: 'max_autonomous',
      value: maxAutonomous,
      label: 'Maximum autonomous quote (₹)',
      hint: 'Above this the standing offer stops applying itself — a deal that size waits for you.',
      placeholder: 'e.g. 200000',
    },
  ] as const;

  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {boxes.map((box) => (
          <label key={box.name} className="flex flex-col gap-1">
            <span className="text-xs font-medium">{box.label}</span>
            <input
              type="text"
              inputMode="numeric"
              name={box.name}
              defaultValue={box.value ?? ''}
              placeholder={box.placeholder}
              className={inputClass}
            />
            <span className="text-[11px] text-muted">{box.hint}</span>
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Saving…' : 'Save limits'}
        </button>
        <Message status={state.status} message={state.message} />
      </div>
    </form>
  );
}

/**
 * The concession the agent may apply on its own — G-184, ADM-98.
 *
 * The only form on this page that GIVES an agent authority rather than
 * configuring one it already had, so the copy above it says exactly that and
 * the empty state is the safe one: no offer, nothing applied.
 */
export function ApprovedOfferForm({
  label,
  condition,
  discountPct,
  validUntil,
}: {
  label: string | null;
  condition: string | null;
  discountPct: number | null;
  validUntil: string | null;
}) {
  const [state, action, pending] = useActionState(setApprovedOfferAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input
        type="text"
        name="offer_label"
        defaultValue={label ?? ''}
        placeholder="Sign this week"
        aria-label="What you call the offer"
        className={inputClass}
      />
      <input
        type="text"
        name="offer_condition"
        defaultValue={condition ?? ''}
        placeholder="they confirm within 7 days"
        aria-label="What the client has to do to earn it"
        className={inputClass}
      />
      <input
        type="text"
        name="offer_discount_pct"
        defaultValue={discountPct ? String(discountPct) : ''}
        placeholder="10"
        inputMode="numeric"
        aria-label="Discount percent, 1 to 50"
        className={inputClass}
      />
      <input
        type="date"
        name="offer_valid_until"
        defaultValue={validUntil ?? ''}
        aria-label="Valid until"
        className={inputClass}
      />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Saving…' : label ? 'Update offer' : 'Authorise offer'}
      </button>
      <Message status={state.status} message={state.message} />
    </form>
  );
}

export function VerifyWhatsAppButton() {
  const [state, action, pending] = useActionState(verifyWhatsAppAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <button
        type="submit"
        disabled={pending}
        className={buttonClass('secondary', 'sm')}
      >
        {pending ? 'Checking with Meta…' : 'Verify configuration'}
      </button>
      <Message status={state.status} message={state.message} />
    </form>
  );
}

export function PilotToggleForm({ enabled }: { enabled: boolean }) {
  const [state, action, pending] = useActionState(setReactivationPilotAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="enabled" value={enabled ? 'false' : 'true'} />
      <button
        type="submit"
        disabled={pending}
        className={buttonClass('secondary', 'sm')}
      >
        {pending ? 'Saving…' : enabled ? 'Disable pilot' : 'Enable pilot'}
      </button>
      <Message status={state.status} message={state.message} />
    </form>
  );
}

/**
 * Who must approve what — ADM-08b, and the reason nothing could be quoted.
 *
 * `sales.submit_proposal` answers `no_policy` when nothing covers quotations,
 * and the message an owner reads says *"An owner sets one before this can be
 * approved"* — an action the product did not offer anywhere. So on a fresh
 * deployment the whole of ADM-07's close path stopped at the first submit.
 *
 * Here rather than on /approvals deliberately: that page's own comment says
 * *"changing who may approve what is an authority change… not a screen a queue
 * view should hand out"*, and it is still right. This is the owner's
 * configuration surface, already owner-gated and already audited.
 *
 * The money floor is stated in the form rather than discovered on submit —
 * `violatesMoneyFloor` was written for exactly this and had no caller. The
 * DDL constraint is still the rule; this only says so first.
 */
export function ApprovalPolicyForm({ subjectTypes, roles }: { subjectTypes: readonly string[]; roles: readonly string[] }) {
  const [state, action, pending] = useActionState(upsertApprovalPolicyAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <select name="subjectType" defaultValue="proposal" aria-label="What needs approving" className={`${inputClass} w-auto`}>
          {subjectTypes.map((s) => (
            <option key={s} value={s}>
              {s.replace(/_/g, ' ')}
            </option>
          ))}
        </select>

        <label className="flex items-center gap-1.5 text-[12.5px] text-muted">
          at or above ₹
          <input
            name="minAmountMinor"
            type="number"
            min="0"
            step="1"
            defaultValue="0"
            aria-label="Minimum amount in rupees"
            className={`${inputClass} w-28`}
          />
        </label>

        <select name="requiredRole" defaultValue="owner" aria-label="Who must approve" className={`${inputClass} w-auto`}>
          {roles.map((r) => (
            <option key={r} value={r}>
              {r.replace(/_/g, ' ')}
            </option>
          ))}
        </select>

        <label className="flex items-center gap-1.5 text-[12.5px] text-muted">
          within
          <input
            name="slaHours"
            type="number"
            min="1"
            max="8760"
            defaultValue="24"
            aria-label="Hours to answer"
            className={`${inputClass} w-20`}
          />
          h
        </label>

        <input name="note" placeholder="Note (optional)" aria-label="Note" className={`${inputClass} w-44`} />

        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Saving…' : 'Set policy'}
        </button>
      </div>

      <p className="text-[12.5px] text-muted">
        A policy says who must consent, never who may act. Refunds are owner-only and invoices
        need owner or ops admin — policy may make a gate stricter, never looser, and the database
        refuses the rest. Setting the same subject and amount again replaces that rung.
      </p>

      <Message status={state.status} message={state.message} />
    </form>
  );
}

/**
 * Where the agent asks for help — G-109, business rules §5.1.
 *
 * The internal group is *"an approval channel, not a chat log"*: what the
 * agent brings there is what needs a person — an approval, and a conversation
 * it has handed over.
 *
 * Written after the first real handover on production reached nobody. The
 * reason was good, the lead went to the top of the attention list, the thread
 * grew a banner — and no phone buzzed, because no group was linked and there
 * was no way to link one. The announcer had been built and was silent.
 */
/**
 * Where announcements go when the channel is a person — ADM-95, G-159.
 *
 * Meta refused this WABA the Groups APIs (#131215), so the group form above
 * cannot deliver anywhere today; this one can. One number, the owner's own.
 */
export function InternalRecipientForm({ current }: { current: string | null }) {
  const [state, action, pending] = useActionState(linkInternalRecipientAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          name="phone"
          defaultValue={current ?? ''}
          placeholder="+91 98765 43210"
          aria-label="Announcements WhatsApp number"
          className={`${inputClass} w-72`}
        />
        <input name="title" placeholder="Name (optional)" aria-label="Recipient name" className={`${inputClass} w-44`} />
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Linking…' : current ? 'Change number' : 'Link number'}
        </button>
      </div>
      <Message status={state.status} message={state.message} />
    </form>
  );
}

export function InternalGroupForm({ current }: { current: string | null }) {
  const [state, action, pending] = useActionState(linkInternalGroupAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          name="externalRef"
          defaultValue={current ?? ''}
          placeholder="120363012345678901@g.us"
          aria-label="Internal group id"
          className={`${inputClass} w-72`}
        />
        <input name="title" placeholder="Name (optional)" aria-label="Group name" className={`${inputClass} w-44`} />
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Linking…' : current ? 'Relink group' : 'Link group'}
        </button>
      </div>
      <Message status={state.status} message={state.message} />
    </form>
  );
}
