import type { Metadata } from 'next';

import { reactivationSummary } from '@/lib/admin/reactivation-summary';
import { requireInternal } from '@/lib/auth/session';
import { createClient } from '@/lib/db/server';
import { readInternalGroup, readInternalRecipient } from '@/modules/crm/queries';

import {
  InternalGroupForm,
  InternalRecipientForm,
  OutreachLimitsForm,
  PilotToggleForm,
  ReactivationCapForm,
  SendWhatsAppTestForm,
  TestRecipientForm,
  VerifyWhatsAppButton,
  WakeOnInboundForm,
  WhatsAppNumberForm,
  WhatsAppTemplatesForm,
} from '../forms';

export const metadata: Metadata = { title: 'Settings — Communication' };

export default async function SettingsCommunicationPage() {
  await requireInternal('/settings');

  const supabase = await createClient();
  const { data: orgRows } = await supabase.schema('core').from('organizations').select('settings').limit(1);
  const orgSettings = (orgRows?.[0]?.settings ?? {}) as Record<string, unknown>;
  const setting = (key: string) => (typeof orgSettings[key] === 'string' ? (orgSettings[key] as string) : null);

  const whatsappPhoneNumberId = setting('whatsapp_phone_number_id');
  const whatsappTestRecipient = setting('whatsapp_test_recipient');
  // G-236 — the recorded verifications, shown beside the controls that write them.
  const whatsappVerifiedAt = setting('whatsapp_verified_at');
  const whatsappVerifiedNumber = setting('whatsapp_verified_number');
  const whatsappTestSentAt = setting('whatsapp_test_sent_at');
  // G-209 — off is the default and the state every deployment starts in.
  const { data: wakeRows } = await supabase.schema('core').from('organizations').select('wake_runner_on_inbound').limit(1);
  const wakeOnInbound = wakeRows?.[0]?.wake_runner_on_inbound ?? false;

  // G-217 — read from the performance view rather than the table: it carries
  // everything the table does plus how each one is actually doing, derived
  // from Meta's own receipts and the clients' own replies. One read, and the
  // figures cannot disagree with the transcript they summarise.
  const { data: templateRows } = await supabase
    .schema('crm')
    .from('whatsapp_template_performance')
    .select('situation_key, template_name, language_code, status, sent, delivered, read, replied')
    .eq('active', true)
    .order('situation_key');
  const whatsappTemplates = templateRows ?? [];

  // G-216 — the limits in force, defaults included. A failed read throws
  // rather than showing figures nobody set, which somebody would then trust.
  const { readOutreachLimits } = await import('@/lib/admin/settings');
  const limitsResult = await readOutreachLimits();
  const outreachLimits = limitsResult.ok
    ? limitsResult.data
    : { perContactPerDay: 0, perContactPerWeek: 0, perOrganizationPerDay: 0, unansweredBeforeCooldown: 0, cooldownDays: 0 };

  // The linked internal group and the person announcements reach (ADM-95),
  // through the module's own readers rather than read inline here.
  const internalGroup = (await readInternalGroup())?.externalRef ?? null;
  const internalRecipient = (await readInternalRecipient())?.phone ?? null;

  const reactivation = await reactivationSummary();

  return (
    <div className="flex flex-col gap-5">
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
        <h2 className="text-[13px] font-semibold tracking-tight">Messages outside the 24-hour window</h2>
        <p className="text-xs text-muted">
          WhatsApp only carries a free-form message within 24 hours of the client&rsquo;s last message.
          Every follow-up day is outside that, and so is every imported lead — so a follow-up can only
          be delivered as a template Meta has approved. Register which approved template answers which
          situation; the wording itself lives at Meta.
        </p>
        <WhatsAppTemplatesForm registered={whatsappTemplates} />

        <h2 className="text-[13px] font-semibold tracking-tight">How often AgencyOS starts a conversation</h2>
        <p className="text-xs text-muted">
          Nothing limited this before, which was survivable while nothing could be delivered at all.
          It stops being survivable the moment templates are approved and twelve hundred historical
          leads become reachable. These are the numbers in force; the defaults are what a careful
          person would choose rather than what a campaign would like.
        </p>
        <OutreachLimitsForm limits={outreachLimits} />

        <h2 className="text-[13px] font-semibold tracking-tight">How quickly the agent answers</h2>
        <p className="text-xs text-muted">
          A message normally waits for the next scheduled run before the agent starts reading it —
          up to a minute. Turning this on has the agent start the moment a message arrives. It does
          not change how much work the agent does, only when it begins.
        </p>
        <WakeOnInboundForm enabled={wakeOnInbound} />

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
        <div className="flex flex-col gap-1 rounded-lg border border-line px-4 py-3">
          <span className="text-xs font-medium">Per-run cap</span>
          <p className="text-[11px] text-muted">
            The most reactivation follow-ups one worker run sends for this organization. Bounds a single tick so
            switching the pilot on for a large cohort does not send the whole batch at once — the daily outreach limits
            bound the day, this bounds the run.
          </p>
          <ReactivationCapForm maxPerRun={setting('reactivation_max_per_run')} />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="text-[13px] font-semibold tracking-tight">WhatsApp</h2>
        <p className="text-xs text-muted">
          Whether the tokens are set is shown on the General tab. This checks the number itself with Meta — a
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
          <p className="text-xs text-muted">
            {whatsappVerifiedAt
              ? `Last verified with Meta ${whatsappVerifiedAt}${whatsappVerifiedNumber ? ` — ${whatsappVerifiedNumber}` : ''}. Recorded, so the readiness page can see it.`
              : 'Never verified with Meta — the readiness page stays amber until a person runs this and the answer is recorded.'}
          </p>
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
          {whatsappTestRecipient ? (
            <SendWhatsAppTestForm recipient={whatsappTestRecipient} lastSentAt={whatsappTestSentAt} />
          ) : (
            <p className="text-xs text-muted">Set an internal test recipient to make the controlled first send.</p>
          )}
        </div>
      </div>
    </div>
  );
}
