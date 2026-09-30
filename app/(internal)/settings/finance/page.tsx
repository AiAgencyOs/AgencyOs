import type { Metadata } from 'next';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can, hasRole } from '@/lib/authz/permissions';
import { listPaymentAccounts } from '@/modules/finance/queries';
import { readInvoiceReminderPolicy } from '@/modules/finance/reminder-queries';
import { readGstIdentity } from '@/modules/finance/gstr-queries';
import { describeStateCode, gstIdentityIssues } from '@/modules/finance/gstr';
import { SUGGESTED_SAC } from '@/modules/finance/gst-identity-schema';
import { PAYMENT_ACCOUNT_FIELDS, PAYMENT_ACCOUNT_KIND_LABEL } from '@/modules/finance/schema';
import { Badge, Callout, EmptyState, IconRupee, StatusBadge } from '@/ui';

import { AddPaymentAccountForm, PaymentAccountStatusButton } from './payment-accounts-panel';
import { InvoiceReminderPolicyForm } from './reminder-policy-form';
import { GstIdentityForm } from './gst-identity-form';

export const metadata: Metadata = { title: 'Settings — Finance' };

/**
 * SCR-057 — Settings › Finance: the receiving accounts the agency offers on
 * its invoices (Doc 15 §9). Confirmed genuinely missing: finance.payment_accounts
 * existed since migration 20260821250000 and nothing in the admin panel could
 * read or add one, so every client claim was recorded against no account.
 *
 * Once a claim names an account, the database freezes its details; the only
 * edit left is active/inactive, which this page offers and says why.
 */
export default async function SettingsFinancePage() {
  const context = await requireInternal('/settings/finance');
  const clock = await agencyClock();
  const accounts = await listPaymentAccounts();
  const mayManage = can(context, 'invoice.issue');
  // Owner decision 2026-09-29: automatic past-due reminders, two real columns
  // on the organization. Reading is every internal role's; the switch is
  // `organization.settings`, like the other switches on these screens.
  const reminderPolicy = await readInvoiceReminderPolicy();
  const maySetPolicy = can(context, 'organization.settings');
  // E5: the agency's own GST identity. Read by every internal role; set by
  // the owner only — a registration number is legal identity, not a switch.
  const gstIdentity = await readGstIdentity();
  const gstIssues = gstIdentityIssues(gstIdentity);
  const maySetIdentity = hasRole(context, 'owner');

  const active = accounts.filter((a) => a.status === 'active');
  const inactive = accounts.filter((a) => a.status === 'inactive');

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5 shadow-xs">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="receiving-accounts" className="scroll-mt-24 text-[13px] font-semibold tracking-tight">Receiving accounts</h2>
          <span className="text-xs text-muted">
            {active.length} active · {inactive.length} inactive
          </span>
        </div>
        <p className="text-xs text-muted">
          Where a client is told to pay. An invoice prints the accounts active at issue time and a
          payment claim names the one it was paid into. Details are frozen once any claim names an
          account — deactivate and add a new one rather than editing where money goes.
        </p>

        {accounts.length === 0 ? (
          <EmptyState
            icon={<IconRupee size={22} />}
            title="No receiving accounts"
            description="Add the bank, UPI or gateway details a client pays into. Until one exists, invoices cannot say where to pay."
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {accounts.map((a) => (
              <li key={a.id} className="flex flex-col gap-2 rounded-lg border border-line bg-canvas px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold">{a.label}</span>
                  <Badge mono>{PAYMENT_ACCOUNT_KIND_LABEL[a.kind]}</Badge>
                  <StatusBadge status={a.status} />
                  {a.usedBy > 0 ? (
                    <span className="text-xs text-muted">named by {a.usedBy} claim{a.usedBy === 1 ? '' : 's'} · details frozen</span>
                  ) : null}
                </div>
                <dl className="grid grid-cols-[minmax(6rem,30%)_1fr] gap-x-3 gap-y-1 text-[13px]">
                  {PAYMENT_ACCOUNT_FIELDS[a.kind]
                    .filter((f) => a.instructions[f.key])
                    .map((f) => (
                      <div key={f.key} className="contents">
                        <dt className="text-muted">{f.label}</dt>
                        <dd className="font-mono text-xs">{a.instructions[f.key]}</dd>
                      </div>
                    ))}
                  {Object.entries(a.instructions)
                    .filter(([k]) => !PAYMENT_ACCOUNT_FIELDS[a.kind].some((f) => f.key === k))
                    .map(([k, v]) => (
                      <div key={k} className="contents">
                        <dt className="text-muted">{k}</dt>
                        <dd className="font-mono text-xs">{v}</dd>
                      </div>
                    ))}
                  <div className="contents">
                    <dt className="text-muted">Effective</dt>
                    <dd className="text-muted">
                      {clock.date(a.effectiveFrom)}
                      {a.effectiveTo ? ` → ${clock.date(a.effectiveTo)}` : ' → open'}
                    </dd>
                  </div>
                </dl>
                {mayManage ? <PaymentAccountStatusButton accountId={a.id} status={a.status} /> : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {mayManage ? (
        <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5 shadow-xs">
          <h2 className="text-[13px] font-semibold tracking-tight">Add a receiving account</h2>
          <AddPaymentAccountForm />
        </div>
      ) : (
        <Callout tone="info">Only an owner or ops admin can add or deactivate receiving accounts.</Callout>
      )}

      {/*
        Past-due reminders — owner decision 2026-09-29 (AGENT_BRIEF_D
        decision 1). The runner chases past-due invoices on WhatsApp by itself
        once this is on: as text inside the 24-hour window, as the approved
        "invoice_reminder" template outside it, never more than once per
        interval. Audited both ways.
      */}
      <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5 shadow-xs">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="past-due-reminders" className="scroll-mt-24 text-[13px] font-semibold tracking-tight">Past-due reminders</h2>
          <Badge tone={reminderPolicy.enabled ? 'success' : 'neutral'} dot>
            {reminderPolicy.enabled ? `on · every ${reminderPolicy.intervalDays} day${reminderPolicy.intervalDays === 1 ? '' : 's'}` : 'off'}
          </Badge>
        </div>
        <p className="text-xs text-muted">
          When on, an issued invoice past its due date is chased on the client's WhatsApp thread (the
          client's own thread, else the project group) once per interval, with no approval step. Inside the
          24-hour window the reminder is plain text; outside it only the approved template registered as
          "Past-due invoice reminder" under Settings › Communication is carried, and with none registered
          nothing is sent and the invoice's Reminders section says so. Consent is checked on every send.
        </p>
        {maySetPolicy ? (
          <InvoiceReminderPolicyForm enabled={reminderPolicy.enabled} intervalDays={reminderPolicy.intervalDays} />
        ) : (
          <Callout tone="info">Only an owner or ops admin can change the reminder policy.</Callout>
        )}
      </div>

      {/*
        GST identity — bucket E5 (owner decision 2026-09-30: GSTR-1 / GSTR-3B
        exports). Three columns on the organization: the agency's own GSTIN,
        its registration state code (the intra/inter-state decision on every
        exported line) and the SAC its lines are classified under. Owner
        only, audited with old and new values by core.set_gst_identity.
      */}
      <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5 shadow-xs">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="gst-identity" className="scroll-mt-24 text-[13px] font-semibold tracking-tight">GST identity</h2>
          {gstIssues.length === 0 ? (
            <Badge tone="success" dot>
              {gstIdentity.gstin} · {gstIdentity.stateCode ? describeStateCode(gstIdentity.stateCode) : ''} · SAC {gstIdentity.defaultSac}
            </Badge>
          ) : (
            <Badge tone="warning" dot>incomplete</Badge>
          )}
        </div>
        <p className="text-xs text-muted">
          The supplier on every GST invoice and the header of the GSTR-1 and GSTR-3B files exported from Finance › GST & tax.
          The state code decides whether a line is split CGST+SGST (client in the same state) or IGST (any other state); it is
          the first two characters of the GSTIN and is taken from it when left blank. The default SAC classifies every line in
          the HSN summary — {SUGGESTED_SAC} is IT design and development services — until a per-line code exists. Nothing here
          verifies a registration with the GST portal; it records what the owner states.
        </p>
        {gstIssues.length > 0 ? (
          <Callout tone="warning">The GSTR exports refuse until this is complete: {gstIssues.map((i) => i.reason).join(' ')}</Callout>
        ) : null}
        {maySetIdentity ? (
          <GstIdentityForm gstin={gstIdentity.gstin} stateCode={gstIdentity.stateCode} defaultSac={gstIdentity.defaultSac} />
        ) : (
          <Callout tone="info">Only the owner can state the agency’s GST identity.</Callout>
        )}
      </div>
    </div>
  );
}
