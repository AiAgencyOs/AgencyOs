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
import { readOrganizationSettingsRow, numberingFrom } from '@/modules/finance/numbering';
import { createClient } from '@/lib/db/server';
import { gstSetupFrom, GST_FILING_LABEL, GST_REGISTRATION_LABEL } from '@/modules/finance/gst-settings';
import { countExpensesByCategory, listExpenseCategories } from '@/modules/finance/expense-category-queries';
import { formatInvoiceNumber } from '@/modules/finance/schema';
import { Badge, Callout, EmptyState, IconRupee, StatusBadge } from '@/ui';

import { AddPaymentAccountForm, PaymentAccountStatusButton } from './payment-accounts-panel';
import { InvoiceReminderPolicyForm } from './reminder-policy-form';
import { GstIdentityForm } from './gst-identity-form';
import { InvoiceNumberingForm, WonGateForm } from './numbering-form';
import { GstSetupForm } from './gst-setup-form';
import { AddExpenseCategoryForm, ExpenseCategoryRow } from './expense-categories-panel';

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

  // PDF §7: invoice numbering / terms, and the won-gate switch.
  const orgSettings = await readOrganizationSettingsRow(await createClient());
  const numbering = numberingFrom(orgSettings);
  const wonGateOn = orgSettings.won_requires_payment_evidence === 'on';

  // Owner decisions 6 and 9 (2026-10-01): the expense categories and the GST setup.
  const gstSetup = gstSetupFrom(orgSettings);
  const mayReadMoney = can(context, 'invoice.read');
  const categories = mayReadMoney ? await listExpenseCategories() : [];
  const categoryCounts = mayReadMoney ? await countExpensesByCategory() : new Map<string, number>();

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
      {/* PDF §7 "Invoice numbering/terms": the prefix, default terms and the note an invoice prints. */}
      <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5 shadow-xs">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="invoice-numbering" className="scroll-mt-24 text-[13px] font-semibold tracking-tight">Invoice numbering and terms</h2>
          <Badge tone={orgSettings.invoice_number_prefix || orgSettings.invoice_terms_days ? 'success' : 'neutral'} dot>
            {orgSettings.invoice_number_prefix || orgSettings.invoice_terms_days ? 'set' : 'defaults'}
          </Badge>
        </div>
        <p className="text-xs text-muted">
          Numbers run per year as PREFIX-YEAR-0001. A new prefix starts its own series at 1; invoices already raised keep their numbers.
          Default terms set the due date when a milestone carries none and the person raising the invoice names none; the note is printed on the invoice.
        </p>
        {maySetPolicy ? (
          <InvoiceNumberingForm
            prefix={typeof orgSettings.invoice_number_prefix === 'string' ? orgSettings.invoice_number_prefix : null}
            termsDays={typeof orgSettings.invoice_terms_days === 'string' ? orgSettings.invoice_terms_days : null}
            termsNote={numbering.termsNote}
            example={formatInvoiceNumber(new Date().getUTCFullYear(), 1, numbering.prefix)}
          />
        ) : (
          <Callout tone="info">Only an owner or ops admin can change numbering and terms. Current prefix: {numbering.prefix}.</Callout>
        )}
      </div>

      {/* PDF §7 "Milestone rules where user explicitly changes policy": the won-gate switch. */}
      <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5 shadow-xs">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="won-gate" className="scroll-mt-24 text-[13px] font-semibold tracking-tight">Payment evidence before a deal is won</h2>
          <Badge tone={wonGateOn ? 'success' : 'neutral'} dot>{wonGateOn ? 'required' : 'not required'}</Badge>
        </div>
        <p className="text-xs text-muted">
          A deal always needs its accepted quotation. Switched on, it also needs a captured payment for the client, or an approved no-advance
          exception, before it can be marked won. The gate is enforced in the database; this is its switch.
        </p>
        {maySetPolicy ? <WonGateForm on={wonGateOn} /> : <Callout tone="info">Only an owner or ops admin can change this policy.</Callout>}
      </div>

      {/* Owner decision 9: registration type, filing frequency and tax period, as organization settings through the settings door. */}
      <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5 shadow-xs">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="gst-setup" className="scroll-mt-24 text-[13px] font-semibold tracking-tight">GST setup</h2>
          <Badge tone={gstSetup.explicit.registrationType || gstSetup.explicit.filingFrequency || gstSetup.explicit.periodBasis ? 'success' : 'neutral'} dot>
            {GST_REGISTRATION_LABEL[gstSetup.registrationType]} · {GST_FILING_LABEL[gstSetup.filingFrequency].replace(' (GSTR-1 and GSTR-3B)', '')}
          </Badge>
        </div>
        <p className="text-xs text-muted">
          The agency is a regular taxpayer that files GSTR-1 and GSTR-3B monthly, for the calendar month. That is what applies until a value is saved
          here; the GST &amp; tax page offers the return period due next and the GSTR exports refuse a window this setup does not file.
        </p>
        {maySetPolicy ? <GstSetupForm setup={gstSetup} /> : <Callout tone="info">Only an owner or ops admin can change the GST setup.</Callout>}
      </div>

      {/* Owner decision 6: the owner's list of expense categories. Retired, never deleted. */}
      <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5 shadow-xs">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="expense-categories" className="scroll-mt-24 text-[13px] font-semibold tracking-tight">Expense categories</h2>
          <span className="text-xs text-muted">{categories.filter((c) => !c.retired).length} offered · {categories.filter((c) => c.retired).length} retired</span>
        </div>
        <p className="text-xs text-muted">
          What an expense can be filed under on Finance › Expenses. Retire a category to stop offering it; expenses already filed under it keep it,
          and the list never deletes one. Renaming changes the label everywhere; the stored key stays.
        </p>
        {!mayReadMoney ? (
          <Callout tone="info">Only the owner, ops admin and finance roles read the expense categories.</Callout>
        ) : categories.length === 0 ? (
          <EmptyState
            icon={<IconRupee size={22} />}
            title="No expense categories"
            description="Add the first category; expenses cannot be recorded without one."
            action={maySetPolicy ? <a href="#expense-categories" className="text-[13px] font-medium text-brand hover:underline">Use the form below</a> : undefined}
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {categories.map((c) => (
              <ExpenseCategoryRow key={c.key} category={c} inUse={categoryCounts.get(c.key) ?? 0} />
            ))}
          </ul>
        )}
        {maySetPolicy ? <AddExpenseCategoryForm /> : <Callout tone="info">Only an owner or ops admin can change the categories.</Callout>}
      </div>

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
