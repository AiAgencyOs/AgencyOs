import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { configStatus, type ConfigArea, type ConfigItem } from '@/lib/admin/config-status';
import { APPROVAL_SUBJECT_TYPES, APPROVER_ROLES } from '@/modules/approvals/schema';
import { reactivationSummary } from '@/lib/admin/reactivation-summary';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { PageHeader } from '@/ui';
import { createClient } from '@/lib/db/server';
import { readCronAgeSeconds } from '@/lib/observability/queries';

import {
  ApprovalPolicyForm,
  InternalGroupForm,
  InternalRecipientForm,
  PilotToggleForm,
  TestRecipientForm,
  OrganizationNameForm,
  PricingModelForm,
  QuotationContactForm,
  TimezoneForm,
  VerifyWhatsAppButton,
  WhatsAppNumberForm,
} from './forms';

export const metadata: Metadata = { title: 'Settings' };

/**
 * Configuration, from the owner's chair — without the SQL or the .env file.
 *
 * The single place an owner can answer "is this deployment configured, and
 * what is missing?" without opening a shell. It renders the SAME presence
 * report and production rules the app boots with (src/lib/admin/config-status,
 * which reuses src/lib/env-schema) — so it can never claim a variable is set
 * that the app would refuse, nor the reverse.
 *
 * Secret-safe by construction: `configStatus()` runs server-side and returns
 * only booleans (present / not) and sanitized problem strings. No secret value,
 * length, or prefix crosses to the browser. Gated on `organization.settings`
 * (owner) — the capability that already means "change organization settings";
 * operational diagnostics for both admins stay on /operations (audit.read).
 */

const AREAS: readonly ConfigArea[] = [
  'Database',
  'Application',
  'Scheduler',
  'WhatsApp',
  'AI provider',
  'Speech to text',
  'Alerts',
];

function Dot({ item }: { item: ConfigItem }) {
  if (item.present) return <span className="text-success">configured</span>;
  if (item.requiredInProduction)
    return <span className="text-danger">not configured — required</span>;
  return <span className="text-muted">not configured — optional</span>;
}

export default async function SettingsPage() {
  const context = await requireInternal('/settings');
  if (!can(context.role, 'organization.settings')) redirect('/dashboard');

  const status = configStatus();
  const cronAge = await readCronAgeSeconds();

  // The agency timezone is a business fact, not a secret, so it is shown. Null
  // by design until an owner sets it (G-137) — and until then nothing sends.
  const supabase = await createClient();
  const { data: orgRows } = await supabase.schema('core').from('organizations').select('name, timezone, settings').limit(1);
  const timezone = orgRows?.[0]?.timezone ?? null;
  const organizationName = orgRows?.[0]?.name ?? '';
  const orgSettings = (orgRows?.[0]?.settings ?? {}) as Record<string, unknown>;
  const whatsappPhoneNumberId =
    typeof orgSettings.whatsapp_phone_number_id === 'string' ? orgSettings.whatsapp_phone_number_id : null;
  const whatsappTestRecipient =
    typeof orgSettings.whatsapp_test_recipient === 'string' ? orgSettings.whatsapp_test_recipient : null;
  // G-171 — the contact block on every quotation PDF.
  const contactEmail =
    typeof orgSettings.quotation_contact_email === 'string' ? orgSettings.quotation_contact_email : null;
  const contactPhone =
    typeof orgSettings.quotation_contact_phone === 'string' ? orgSettings.quotation_contact_phone : null;
  const contactLocation =
    typeof orgSettings.quotation_contact_location === 'string' ? orgSettings.quotation_contact_location : null;
  // G-179 — the pricing model's own inputs. Read as written; the reader in
  // production-cost.ts is what decides whether the five of them make a
  // coherent model, and an incoherent set says nothing rather than guessing.
  const setting = (key: string) => (typeof orgSettings[key] === 'string' ? (orgSettings[key] as string) : null);
  const dayRate = setting('pricing_day_rate_rupees');
  const aiDayRate = setting('pricing_ai_day_rate_rupees');
  const multiplierMin = setting('pricing_multiplier_min');
  const multiplierTarget = setting('pricing_multiplier_target');
  const multiplierMax = setting('pricing_multiplier_max');
  const pricingModelConfigured = Boolean(dayRate && aiDayRate && multiplierMin && multiplierTarget && multiplierMax);
  // The linked internal group, read the same way the announcer finds it — by
  // kind — so this page and the handler can never disagree about whether one
  // exists.
  const { data: groupRows } = await supabase
    .schema('crm')
    .from('conversations')
    .select('external_ref')
    .eq('kind', 'internal_group')
    .neq('status', 'abandoned')
    .limit(1);
  const internalGroup = groupRows?.[0]?.external_ref ?? null;

  // The person the announcements reach — ADM-95's channel, read by kind for
  // the same never-disagree reason.
  const { data: recipientRows } = await supabase
    .schema('crm')
    .from('conversations')
    .select('external_ref')
    .eq('kind', 'internal_direct')
    .neq('status', 'abandoned')
    .limit(1);
  const internalRecipient =
    recipientRows?.[0]?.external_ref?.replace(/^internal:\+/, '') ?? null;

  const reactivation = await reactivationSummary();

  const problems = status.productionProblems;
  const ready = problems.length === 0;
  const cronStale = cronAge === null || cronAge > 15 * 60;
  const cronLabel =
    cronAge === null ? 'unknown' : cronAge > 3600 ? `${Math.floor(cronAge / 3600)}h ago` : cronAge > 90 ? `${Math.floor(cronAge / 60)}m ago` : `${cronAge}s ago`;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={<>Settings</>}
        description={
          <>
        Configuration status for this deployment. Secret values are never shown here or sent to your browser — only
        whether each is present. Set secrets in the deployment environment, not in the product.
          </>
        }
      />

      <div
        className={`rounded-lg border px-4 py-3 text-sm ${ready ? 'border-success/30 text-success' : 'border-warning/30 text-warning'}`}
      >
        {ready
          ? 'Every production-required value is present and safe.'
          : `${problems.length} configuration ${problems.length === 1 ? 'value is' : 'values are'} missing or unsafe for production (see below). NODE_ENV=${status.nodeEnv}.`}
      </div>

      {AREAS.map((area) => {
        const items = status.items.filter((i) => i.area === area);
        if (items.length === 0) return null;
        return (
          <div key={area} className="flex flex-col gap-2">
            <h2 className="text-[13px] font-semibold tracking-tight">{area}</h2>
            <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface">
              {items.map((item) => (
                <li key={item.key} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-4 py-3 text-sm">
                  <div className="flex items-baseline gap-2">
                    <code className="text-xs">{item.key}</code>
                    {item.secret ? (
                      <span className="rounded bg-surface-sunken px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                        secret
                      </span>
                    ) : null}
                    {item.requiredInProduction ? (
                      <span className="text-[10px] uppercase tracking-wide text-muted">required</span>
                    ) : null}
                  </div>
                  <div className="text-xs">
                    <Dot item={item} />
                  </div>
                  <p className="w-full text-xs text-muted">{item.note}</p>
                </li>
              ))}
            </ul>
          </div>
        );
      })}

      {problems.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h2 className="text-[13px] font-semibold tracking-tight">Not ready for production</h2>
          <ul className="flex flex-col gap-1 rounded-lg border border-warning/30 px-4 py-3 text-sm">
            {problems.map((p) => (
              <li key={p.variable} className="text-warning">
                <code className="text-xs">{p.variable}</code> — {p.problem}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/*
        G-160: the name every quotation PDF wears as its letterhead — found
        still reading "Demo Agency" one step before the first real client.
        Owner only, audited, and the database refuses any other write.
      */}
      <div className="flex flex-col gap-2">
        <h2 className="text-[13px] font-semibold tracking-tight">Agency name</h2>
        <p className="text-xs text-muted">
          The letterhead on every quotation PDF a client keeps, and the sender of every
          announcement. This is the agency&rsquo;s signature — renaming is owner-only and audited.
        </p>
        <OrganizationNameForm current={organizationName} />
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="text-[13px] font-semibold tracking-tight">Quotation contact details</h2>
        <p className="text-xs text-muted">
          Printed under the agency name on every quotation PDF, so a client who forwards the
          document to a partner can still reach you from it. Leave a field empty to clear it —
          a quotation with none of these set simply carries no contact line rather than an
          invented one.
        </p>
        <QuotationContactForm email={contactEmail} phone={contactPhone} location={contactLocation} />
      </div>

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
        <PricingModelForm
          dayRate={dayRate}
          aiDayRate={aiDayRate}
          multiplierMin={multiplierMin}
          multiplierTarget={multiplierTarget}
          multiplierMax={multiplierMax}
        />
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="text-[13px] font-semibold tracking-tight">Agency timezone</h2>
        <p className="text-xs text-muted">
          {timezone
            ? 'Follow-ups schedule in this zone. Changing it re-schedules future sends.'
            : 'Not set — follow-up sending is paused until an IANA timezone is chosen (G-137). Nothing sends before that.'}
        </p>
        <TimezoneForm current={timezone} />
      </div>

      {/*
        ADM-08b, and the reason nothing could be quoted on a fresh deployment:
        `sales.submit_proposal` answers `no_policy` when nothing covers
        quotations, and the message it produces — "An owner sets one before
        this can be approved" — named an action the product offered nowhere.

        Here rather than on /approvals deliberately. That page's own comment
        says changing who may approve what is "not a screen a queue view should
        hand out", and it is right; this is the owner's configuration surface,
        already owner-gated and already audited.
      */}
      {/*
        Business rules §5.1: the internal group is "an approval channel, not a
        chat log". Nothing could link one, so every announcement the agent made
        — an approval waiting, a conversation handed to a person — answered
        `no_group` and went nowhere.
      */}
      <div className="flex flex-col gap-2">
        <h2 className="text-[13px] font-semibold tracking-tight">Internal group</h2>
        <p className="text-xs text-muted">
          Where the agent asks for a person — an approval that needs deciding, a client it has
          handed over. Add the AgencyOS number to your team&rsquo;s WhatsApp group, then paste the
          group id here. Without one, a handover still reaches the lead page but nobody&rsquo;s
          phone.
        </p>
        <InternalGroupForm current={internalGroup} />
      </div>

      {/*
        ADM-95, G-159. Meta refused this WhatsApp number the Groups APIs
        (#131215), so the group above cannot receive anything on this
        deployment — a person can. While both are linked, announcements
        prefer the person, because a channel that delivers outranks one that
        cannot.
      */}
      <div className="flex flex-col gap-2">
        <h2 className="text-[13px] font-semibold tracking-tight">Announcements number</h2>
        <p className="text-xs text-muted">
          A person&rsquo;s own WhatsApp — approvals with the full quotation and its PDF, and
          handovers, arrive here. On this WhatsApp number Meta has not enabled groups, so this is
          the channel that actually delivers. The decision itself is still made in AgencyOS.
        </p>
        <InternalRecipientForm current={internalRecipient} />
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="text-[13px] font-semibold tracking-tight">Who must approve what</h2>
        <p className="text-xs text-muted">
          A quotation cannot be submitted until a policy covers it — with none, the queue would
          hold a quote nobody is named to answer. Policies read as a ladder: the highest rung at
          or below the amount decides.
        </p>
        <ApprovalPolicyForm subjectTypes={APPROVAL_SUBJECT_TYPES} roles={APPROVER_ROLES} />
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="text-[13px] font-semibold tracking-tight">Historical-lead reactivation</h2>
        <p className="text-xs text-muted">
          Off by default. When on, only leads explicitly enrolled in the cohort — each with a granted WhatsApp consent
          row — are nurtured on the inactive-lead rhythm. Enrol leads from a lead&rsquo;s own page. Nothing sends until
          the timezone, provider and WhatsApp are configured.
        </p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ['Pilot', reactivation.pilotEnabled ? 'on' : 'off'],
            ['Eligible', `${reactivation.eligible}${reactivation.eligibleCapped ? '+' : ''}`],
            ['Enrolled', reactivation.enrolled],
            ['Nurturing', reactivation.activeSequences],
          ].map(([label, value]) => (
            <div key={String(label)} className="rounded-lg border border-line bg-surface px-3 py-2">
              <div className="text-lg font-semibold tabular">{value}</div>
              <div className="text-xs text-muted">{label}</div>
            </div>
          ))}
        </div>
        <div
          className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border px-4 py-3 text-sm ${reactivation.pilotEnabled ? 'border-success/30 text-success' : 'border-line text-muted'}`}
        >
          <span>
            {reactivation.pilotEnabled
              ? 'Reactivation is ENABLED for this organization.'
              : 'Reactivation is OFF for this organization.'}
          </span>
          <PilotToggleForm enabled={reactivation.pilotEnabled} />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="text-[13px] font-semibold tracking-tight">WhatsApp</h2>
        <p className="text-xs text-muted">
          Whether the tokens are set is shown above under “WhatsApp”. This checks the number itself with Meta — a
          read-only lookup that <span className="font-medium">sends no message</span>. It needs
          <code className="text-xs"> WHATSAPP_ACCESS_TOKEN</code> and a phone number id for this organization.
        </p>
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface px-4 py-3 text-sm">
          <span>
            Phone number id:{' '}
            {whatsappPhoneNumberId ? (
              <code className="text-xs">{whatsappPhoneNumberId}</code>
            ) : (
              <span className="text-muted">not set for this organization</span>
            )}
          </span>
          <WhatsAppNumberForm current={whatsappPhoneNumberId} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface px-4 py-3 text-sm">
          <VerifyWhatsAppButton />
        </div>
        <p className="text-xs text-muted">
          Internal test recipient — an owner-controlled number for a controlled first send before anything reaches a
          real customer. Not a secret; the send itself needs <code className="text-xs">WHATSAPP_ACCESS_TOKEN</code> and
          stays off until you run it.
        </p>
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface px-4 py-3 text-sm">
          <span>
            Test recipient:{' '}
            {whatsappTestRecipient ? (
              <code className="text-xs">{whatsappTestRecipient}</code>
            ) : (
              <span className="text-muted">not set</span>
            )}
          </span>
          <TestRecipientForm current={whatsappTestRecipient} />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="text-[13px] font-semibold tracking-tight">Scheduler</h2>
        <div
          className={`flex items-baseline justify-between rounded-lg border px-4 py-3 text-sm ${cronStale ? 'border-danger/30 text-danger' : 'border-line text-muted'}`}
        >
          <span className="font-medium">Last authorized tick</span>
          <span>{cronStale ? `${cronLabel} — the scheduler may be stopped` : cronLabel}</span>
        </div>
        <p className="text-xs text-muted">
          Live operational health — dead jobs, wedged follow-ups, backlog — is on the{' '}
          <a href="/operations" className="underline hover:text-foreground">
            Operations
          </a>{' '}
          page.
        </p>
      </div>
    </div>
  );
}
