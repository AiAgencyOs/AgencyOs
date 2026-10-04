import type { Metadata } from 'next';
import Link from 'next/link';

import { reactivationSummary } from '@/lib/admin/reactivation-summary';
import { readSettingImpact } from '@/lib/admin/settings-impact';
import { impactEffects } from '@/lib/admin/settings-impact-copy';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { normaliseSearch } from '@/lib/db/search';
import { listAnnouncementTargets, listAnnouncements } from '@/modules/crm/announcements-queries';
import { listAnnouncementTemplates } from '@/modules/crm/announcement-templates-queries';
import { readInternalGroup, readInternalRecipient } from '@/modules/crm/queries';
import { listWhatsAppTemplates, listWhatsAppTemplateVersions } from '@/modules/crm/template-queries';
import { agencyClock } from '@/lib/admin/agency-clock';
import { Badge, DomainSearch, SearchSummary, Stat, StatGrid, StatusBadge, buttonClass } from '@/ui';

import {
  InternalGroupForm,
  InternalRecipientForm,
  MeetingOfferHorizonForm,
  OnboardingFollowUpForm,
  OutreachLimitsForm,
  OutreachWindowForm,
  PilotToggleForm,
  ReactivationCapForm,
  SendWhatsAppTestForm,
  TestRecipientForm,
  TrustFactsForm,
  VerifyWhatsAppButton,
  WakeOnInboundForm,
  WhatsAppNumberForm,
  WhatsAppTemplatesForm,
} from '../forms';
import { ImpactGate } from '../impact-gate';
import { SettingHistory } from '../setting-history';
import { loadSettingHistory } from '../setting-history-entries';
import { AnnouncementsPanel } from './announcements-panel';
import { AnnouncementTemplatesPanel } from './announcement-templates-panel';

export const metadata: Metadata = { title: 'Settings — Communication' };

const ANNOUNCEMENT_STATUS_FILTERS = ['draft', 'published', 'archived'] as const;

export default async function SettingsCommunicationPage({ searchParams }: { searchParams: Promise<{ q?: string; astatus?: string }> }) {
  const raw = await searchParams;
  const announcementQuery = normaliseSearch(raw.q);
  const announcementStatus = (ANNOUNCEMENT_STATUS_FILTERS as readonly string[]).includes(raw.astatus ?? '') ? (raw.astatus as (typeof ANNOUNCEMENT_STATUS_FILTERS)[number]) : undefined;
  const context = await requireInternal('/settings');

  const [historyOf, impact] = await Promise.all([loadSettingHistory(), readSettingImpact()]);
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

  // SCR-017/057 — announcements: a record, never a send.
  const [announcements, announcementTargets, announcementTemplates] = await Promise.all([listAnnouncements({ limit: 50, q: announcementQuery || undefined, status: announcementStatus }), listAnnouncementTargets(), listAnnouncementTemplates()]);

  // SCR-059 — the registry by the numbers, and its history. Categories are
  // the situations a template answers; languages are what it answers in.
  const clock = await agencyClock();
  const [allTemplates, templateVersions] = await Promise.all([listWhatsAppTemplates(), listWhatsAppTemplateVersions(50)]);
  const categories = new Set(allTemplates.map((t) => t.situationKey)).size;
  const languages = new Set(allTemplates.map((t) => t.languageCode)).size;
  const approved = allTemplates.filter((t) => t.status === 'approved' && t.active).length;

  return (
    <div className="flex flex-col gap-5">
      {/*
        Business rules §5.1: the internal group is "an approval channel, not a
        chat log". Nothing could link one, so every announcement the agent made
        — an approval waiting, a conversation handed to a person — answered
        `no_group` and went nowhere.
      */}
      <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5 shadow-xs">
        <h2 id="internal-group" className="scroll-mt-24 text-[13px] font-semibold tracking-tight">Internal group</h2>
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
      <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5 shadow-xs">
        <h2 id="announcements-number" className="scroll-mt-24 text-[13px] font-semibold tracking-tight">Announcements number</h2>
        <p className="text-xs text-muted">
          A person&rsquo;s own WhatsApp — approvals with the full quotation and its PDF, and
          handovers, arrive here. On this WhatsApp number Meta has not enabled groups, so this is
          the channel that actually delivers. The decision itself is still made in AgencyOS.
        </p>
        <InternalRecipientForm current={internalRecipient} />
      </div>

      {/*
        SCR-017/057/059. An announcement is RECORDED here — drafted,
        published, archived, each audited — and shown read-only on the
        Communication Center and on every Client 360. It is not sent:
        WhatsApp broadcast is declined on record (traceability row 59), and
        no other channel exists for a message to many people at once.
      */}
      <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5 shadow-xs">
        <h2 id="announcements" className="scroll-mt-24 text-[13px] font-semibold tracking-tight">Announcements</h2>
        <p className="text-xs text-muted">
          What the agency announced, to the team or to clients, and when. Publishing records the announcement so the
          Communication Center and each client&rsquo;s page can show it; <span className="font-medium">nothing is
          sent</span> — WhatsApp broadcast is declined on record (traceability row 59).
        </p>
        {/* SCR-059: the list can grow, so it can be searched and narrowed by status (server-side, past the newest 50). */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-full max-w-md sm:w-80">
          <DomainSearch action="/settings/communication#announcements" value={announcementQuery} placeholder="Search title or text…" label="Search announcements" preserve={{ astatus: announcementStatus }} className="[flex-wrap:nowrap]" />
          </div>
          <div role="group" aria-label="Announcement status" className="flex flex-wrap gap-1">
            {[undefined, ...ANNOUNCEMENT_STATUS_FILTERS].map((st) => (
              <Link
                key={st ?? 'all'}
                href={`/settings/communication?${new URLSearchParams({ ...(announcementQuery ? { q: announcementQuery } : {}), ...(st ? { astatus: st } : {}) }).toString()}#announcements`}
                aria-current={announcementStatus === st ? 'true' : undefined}
                className={buttonClass(announcementStatus === st ? 'primary' : 'secondary', 'sm')}
              >
                {st ? st[0]!.toUpperCase() + st.slice(1) : 'All'}
              </Link>
            ))}
          </div>
        </div>
        {announcementQuery ? <SearchSummary q={announcementQuery} count={announcements.length} bounded={announcements.length >= 50} clearHref={`/settings/communication${announcementStatus ? `?astatus=${announcementStatus}` : ''}#announcements`} /> : null}
        <AnnouncementsPanel
          canWrite={can(context, 'organization.settings')}
          targets={announcementTargets}
          templates={announcementTemplates}
          announcements={announcements.map((a) => ({
            id: a.id,
            title: a.title,
            body: a.body,
            audience: a.audience,
            status: a.status,
            projectName: a.projectName,
            clientName: a.clientName,
            fromMilestone: a.source === 'milestone',
            when:
              a.status === 'published' && a.publishedAt
                ? `published ${clock.dateTime(a.publishedAt)}`
                : a.status === 'archived' && a.archivedAt
                  ? `archived ${clock.dateTime(a.archivedAt)}`
                  : `drafted ${clock.dateTime(a.createdAt)}`,
          }))}
        />
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5 shadow-xs">
        <h2 id="announcement-templates" className="scroll-mt-24 text-[13px] font-semibold tracking-tight">Announcement templates</h2>
        <p className="text-xs text-muted">
          Reusable client-update formats. A template marked Milestone drafts an announcement each time a client-visible
          milestone is met, naming the project, the client and the milestone; you publish it — <span className="font-medium">nothing is sent</span>.
        </p>
        <AnnouncementTemplatesPanel canWrite={can(context, 'organization.settings')} templates={announcementTemplates} />
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5 shadow-xs">
        <h2 id="whatsapp-templates" className="scroll-mt-24 text-[13px] font-semibold tracking-tight">Messages outside the 24-hour window</h2>
        <p className="text-xs text-muted">
          WhatsApp only carries a free-form message within 24 hours of the client&rsquo;s last message.
          Every follow-up day is outside that, and so is every imported lead — so a follow-up can only
          be delivered as a template Meta has approved. Register which approved template answers which
          situation; the wording itself lives at Meta.
        </p>
        <StatGrid>
          <Stat label="Templates" value={allTemplates.length} caption="registered, any status" />
          <Stat label="Approved" value={approved} tone={approved > 0 ? 'success' : 'neutral'} caption="active and approved by Meta" />
          <Stat label="Categories" value={categories} caption="situations with a template" />
          <Stat label="Languages" value={languages} caption="distinct language codes" />
        </StatGrid>
        <WhatsAppTemplatesForm registered={whatsappTemplates} />

        <h2 id="template-history" className="scroll-mt-24 text-[13px] font-semibold tracking-tight">Template history</h2>
        <p className="text-xs text-muted">
          Every change to a registration, newest first, as <code className="text-xs">crm.whatsapp_template_versions</code> recorded it.
        </p>
        {templateVersions.length === 0 ? (
          <p className="rounded-lg border border-line bg-surface px-4 py-3 text-[13px] text-muted">No change has been recorded yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface">
            {templateVersions.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2.5 text-[13px]">
                <span className="flex flex-wrap items-center gap-2">
                  <code className="text-xs">{v.templateName}</code>
                  <Badge tone="neutral">{v.languageCode}</Badge>
                  <StatusBadge status={v.status} />
                  {!v.active ? <Badge tone="neutral">inactive</Badge> : null}
                  {v.parameters.length > 0 ? <span className="text-xs text-muted">{v.parameters.join(', ')}</span> : null}
                </span>
                <span className="text-xs text-muted">
                  {clock.dateTime(v.recordedAt)}
                  {v.changedBy ? ` · by ${v.changedBy.slice(0, 8)}` : ''}
                  {v.changeReason ? ` · ${v.changeReason}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}

        <h2 id="outreach-limits" className="scroll-mt-24 text-[13px] font-semibold tracking-tight">How often AgencyOS starts a conversation</h2>
        <p className="text-xs text-muted">
          Nothing limited this before, which was survivable while nothing could be delivered at all.
          It stops being survivable the moment templates are approved and twelve hundred historical
          leads become reachable. These are the numbers in force; the defaults are what a careful
          person would choose rather than what a campaign would like.
        </p>
        <ImpactGate title="Changing the outreach limits affects" effects={impactEffects('outreach-limits', impact)}>
          <OutreachLimitsForm limits={outreachLimits} />
        </ImpactGate>

        <h2 id="outreach-window" className="scroll-mt-24 text-[13px] font-semibold tracking-tight">When AgencyOS may send</h2>
        <p className="text-xs text-muted">
          {setting('outreach_window_start_hour') && setting('outreach_window_end_hour')
            ? `Set — follow-ups go out between ${setting('outreach_window_start_hour')}:00 and ${setting('outreach_window_end_hour')}:00 in the agency’s timezone, on business days.`
            : 'Not set — follow-ups go out between 10:00 and 19:00 in the agency’s timezone, on business days. A follow-up that falls due outside these hours waits for the next opening.'}
        </p>
        <ImpactGate title="Changing when AgencyOS may send affects" effects={impactEffects('outreach-window', impact)}>
          <OutreachWindowForm start={setting('outreach_window_start_hour')} end={setting('outreach_window_end_hour')} />
        </ImpactGate>
        <SettingHistory label="Sending window" entries={historyOf('outreach_window_start_hour', 'outreach_window_end_hour')} />

        <h2 className="text-[13px] font-semibold tracking-tight">How far ahead a meeting time is offered</h2>
        <p className="text-xs text-muted">
          {setting('meeting_offer_horizon_days')
            ? `Set — when a lead named no time, Propose a time reads the next ${setting('meeting_offer_horizon_days')} days of the calendar.`
            : 'Not set — when a lead named no time, Propose a time reads the next 7 days of the calendar. Whole days, 1 to 60. A time the lead did name is unaffected.'}
        </p>
        <MeetingOfferHorizonForm current={setting('meeting_offer_horizon_days')} />
        <SettingHistory label="Meeting offer horizon" entries={historyOf('meeting_offer_horizon_days')} />

        <h2 id="onboarding-followup" className="scroll-mt-24 text-[13px] font-semibold tracking-tight">Reminding a client who has not answered</h2>
        <p className="text-xs text-muted">
          {setting('onboarding_followup_days')
            ? `Set — a client who has not answered an onboarding ask (GST or Non-GST, their GST details) in ${setting('onboarding_followup_days')} day(s) gets one short reminder, then a second after another ${setting('onboarding_followup_days')}, inside the sending window; after that it is left to a person.`
            : 'Not set — the project manager asks once and never chases on its own. Whole days, 1 to 30. A client who writes back is never chased.'}
        </p>
        <OnboardingFollowUpForm current={setting('onboarding_followup_days')} />
        <SettingHistory label="Onboarding reminders" entries={historyOf('onboarding_followup_days')} />

        <h2 id="trust-facts" className="scroll-mt-24 text-[13px] font-semibold tracking-tight">What the agent may say about the agency</h2>
        <p className="text-xs text-muted">
          The sales agent states nothing about the agency that it was not given — no years in business, no payment terms,
          no guarantees. Anything a nervous client asks about how you work, it hands to a colleague. Write the statements
          you are willing to stand behind, one per line (up to 12). It may say them in its own words and nothing beyond
          them. Leave empty to keep today&rsquo;s behaviour.
        </p>
        <TrustFactsForm current={setting('approved_trust_facts')} />
        <SettingHistory label="Statements about the agency" entries={historyOf('approved_trust_facts')} />

        <h2 id="wake-on-inbound" className="scroll-mt-24 text-[13px] font-semibold tracking-tight">How quickly the agent answers</h2>
        <p className="text-xs text-muted">
          A message normally waits for the next scheduled run before the agent starts reading it —
          up to a minute. Turning this on has the agent start the moment a message arrives. It does
          not change how much work the agent does, only when it begins.
        </p>
        <WakeOnInboundForm enabled={wakeOnInbound} />

        <h2 id="reactivation" className="scroll-mt-24 text-[13px] font-semibold tracking-tight">Historical-lead reactivation</h2>
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
        <div id="reactivation-cap" className="flex scroll-mt-24 flex-col gap-1 rounded-lg border border-line px-4 py-3">
          <span className="text-xs font-medium">Per-run cap</span>
          <p className="text-[11px] text-muted">
            The most reactivation follow-ups one worker run sends for this organization. Bounds a single tick so
            switching the pilot on for a large cohort does not send the whole batch at once — the daily outreach limits
            bound the day, this bounds the run.
          </p>
          <ImpactGate title="Changing the reactivation cap affects" effects={impactEffects('reactivation-cap', impact)}>
          <ReactivationCapForm maxPerRun={setting('reactivation_max_per_run')} />
        </ImpactGate>
          <SettingHistory label="Reactivation per-run cap" entries={historyOf('reactivation_max_per_run')} />
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5 shadow-xs">
        <h2 id="whatsapp" className="scroll-mt-24 text-[13px] font-semibold tracking-tight">WhatsApp</h2>
        <p className="text-xs text-muted">
          Whether the tokens are set is shown on the General tab. This checks the number itself with Meta — a
          read-only lookup that <span className="font-medium">sends no message</span>. It needs
          <code className="text-xs"> WHATSAPP_ACCESS_TOKEN</code> (add it under <Link href="/security/keys" className="underline underline-offset-2">Governance &amp; Security › Keys &amp; secrets</Link>, or set it in the deployment environment) and a phone number id for this organization.
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
          <SettingHistory label="WhatsApp phone number id" entries={historyOf('whatsapp_phone_number_id')} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface px-4 py-3 text-sm">
          <VerifyWhatsAppButton />
          <p className="text-xs text-muted">
            {whatsappVerifiedAt
              ? `Last verified with Meta ${whatsappVerifiedAt}${whatsappVerifiedNumber ? ` — ${whatsappVerifiedNumber}` : ''}. Recorded, so the readiness page can see it.`
              : 'Never verified with Meta — the readiness page stays amber until a person runs this and the answer is recorded.'}
          </p>
        </div>
        <p id="whatsapp-test-recipient" className="scroll-mt-24 text-xs text-muted">
          Internal test recipient — an owner-controlled number for a controlled first send before anything reaches a
          real customer. Not a secret; the send itself needs <code className="text-xs">WHATSAPP_ACCESS_TOKEN</code> (add it under <Link href="/security/keys" className="underline underline-offset-2">Governance &amp; Security › Keys &amp; secrets</Link>) and
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
          <SettingHistory label="Internal WhatsApp test recipient" entries={historyOf('whatsapp_test_recipient')} />
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
