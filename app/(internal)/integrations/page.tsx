import type { Metadata } from 'next';

import Link from 'next/link';

import { agencyClock } from '@/lib/admin/agency-clock';
import { configStatus } from '@/lib/admin/config-status';
import { getIntegrations } from '@/lib/admin/integrations';
import { githubConfigured, readGithubTokenScopes } from '@/lib/git/github';
import type { Lifecycle } from '@/lib/admin/integrations-eval';
import { readOperationalSettings, settingInstant, settingText } from '@/lib/admin/settings';
import { readSettingHistory } from '@/lib/admin/settings-history';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { LiveRefresh } from '@/lib/realtime';
import { IntegrationState, PageHeader, PermissionDenied, buttonClass, labelClass } from '@/ui';

import { TestRecipientForm, VerifyAiProviderForm, VerifyCalendarForm, VerifyWhatsAppButton, WhatsAppNumberForm } from '../settings/forms';
import { SettingHistory, type SettingHistoryEntry } from '../settings/setting-history';
import { IntegrationsList, type IntegrationIdentifier, type SecureStorage } from './integrations-list';

export const metadata: Metadata = { title: 'Integrations' };

/**
 * The integration registry — every external dependency in one place, each with
 * its real lifecycle state. The rule the spec insists on is enforced by the
 * evaluator, not the copy: CONFIGURED is never VERIFIED. Only the database and
 * scheduler — which a live signal actually exercised — can read VERIFIED;
 * WhatsApp and the AI provider are CONFIGURED at most, and the row links to the
 * page where a person can verify them. Gated on `organization.settings` (owner).
 */

const STYLE: Record<Lifecycle, { dot: string; text: string }> = {
  VERIFIED: {dot: 'bg-success', text: 'text-success'},
  CONFIGURED: {dot: 'bg-warning', text: 'text-warning'},
  DEGRADED: {dot: 'bg-warning', text: 'text-warning'},
  NOT_CONFIGURED: { dot: 'bg-neutral-400', text: 'text-muted' },
  FAILED: {dot: 'bg-danger', text: 'text-danger'},
  DISABLED: { dot: 'bg-neutral-400', text: 'text-muted' },
};

export default async function IntegrationsPage() {
  const context = await requireInternal('/integrations');
  if (!can(context, 'organization.settings')) return <PermissionDenied />;

  const [{ integrations, summary }, settings, githubScopes, history, clock] = await Promise.all([
    getIntegrations(),
    readOperationalSettings(),
    githubConfigured() ? readGithubTokenScopes() : Promise.resolve(null),
    // SCR-070: each panel-set identifier's effective date and history, from the audit trail.
    readSettingHistory(),
    agencyClock(),
  ]);
  const show = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v));
  const historyOf = (key: string): SettingHistoryEntry[] =>
    (history.get(key) ?? []).map((h) => ({ auditId: h.auditId, before: show(h.before), after: show(h.after), actor: `${h.actorType ?? 'unknown'} ${h.actorId ? h.actorId.slice(0, 8) : ''}`.trim(), atLabel: clock.dateTime(h.at) }));
  const effectiveOf = (key: string): string | undefined => {
    const latest = history.get(key)?.[0];
    return latest ? `effective ${clock.dateTime(latest.at)}` : undefined;
  };
  // Presence only — config-status never learns a value, and neither does this page.
  const env = configStatus();
  const envPresent = (key: string) => env.items.find((i) => i.key === key)?.present ?? false;
  // SCR-067 / SCR-070: one verify control per integration that has an
  // action — the SAME forms Settings and /agents use, behind
  // verifyWhatsAppAction / verifyAiProviderAction / verifyCalendarAction —
  // and the non-secret identifiers each row can honestly show.
  const whatsappNumberId = settingText(settings, 'whatsapp_phone_number_id');
  const whatsappTestRecipient = settingText(settings, 'whatsapp_test_recipient');
  const whatsappVerifiedAt = settingInstant(settings, 'whatsapp_verified_at');
  const whatsappVerifiedNumber = settingText(settings, 'whatsapp_verified_number');
  const providerVerifiedAt = settingInstant(settings, 'ai_provider_verified_at');
  const providerVerifiedModel = settingText(settings, 'ai_provider_verified_model');
  const calendarVerifiedAt = settingInstant(settings, 'calendar_verified_at');
  const calendarVerifiedName = settingText(settings, 'calendar_verified_calendar');
  const verify: Record<string, React.ReactNode> = {
    whatsapp: (
      <span className="flex flex-wrap items-center gap-2">
        <VerifyWhatsAppButton />
        <span className="text-xs text-muted">{whatsappVerifiedAt ? `last verified with Meta ${whatsappVerifiedAt}${whatsappVerifiedNumber ? ` — ${whatsappVerifiedNumber}` : ''}` : 'never verified with Meta'}</span>
      </span>
    ),
    'ai-provider': <VerifyAiProviderForm lastVerifiedAt={providerVerifiedAt} model={providerVerifiedModel} />,
  };
  const identifiers: Record<string, IntegrationIdentifier[]> = {
    whatsapp: [
      { label: 'Phone number id', value: whatsappNumberId ?? 'not set', effective: effectiveOf('whatsapp_phone_number_id') },
      { label: 'Internal test recipient', value: whatsappTestRecipient ?? 'not set', effective: effectiveOf('whatsapp_test_recipient') },
      ...(whatsappVerifiedNumber ? [{ label: 'Verified number', value: whatsappVerifiedNumber, effective: effectiveOf('whatsapp_verified_number') }] : []),
    ],
    'ai-provider': providerVerifiedModel ? [{ label: 'Verified model', value: providerVerifiedModel, effective: effectiveOf('ai_provider_verified_model') }] : [],
    // The webhook URL is read from the environment and may embed a token, so only its presence is stated.
    alerts: [{ label: 'Webhook URL (ALERT_WEBHOOK_URL)', value: envPresent('ALERT_WEBHOOK_URL') ? 'set in the deployment environment' : 'unset' }],
    // Bucket F — the token's scopes, read once from X-OAuth-Scopes, so "can this deployment write to GitHub" is answered here.
    github: githubScopes
      ? githubScopes.ok
        ? [
            { label: 'Token scopes', value: githubScopes.data.scopes === null ? 'not stated (fine-grained token)' : githubScopes.data.scopes.length > 0 ? githubScopes.data.scopes.join(', ') : 'none' },
            { label: 'Token login', value: githubScopes.data.login ?? 'unknown' },
            { label: 'Write doors', value: githubScopes.data.mayWrite ? 'allowed (repo scope, or fine-grained)' : 'refused — no repo scope' },
          ]
        : [{ label: 'Token scopes', value: `not readable: ${githubScopes.reason}` }]
      : [{ label: 'Token scopes', value: 'GITHUB_TOKEN unset' }],
  };
  // SCR-070: "Update non-secret identifiers" — the SAME Settings forms, behind
  // setWhatsAppNumberAction / setTestRecipientAction → setOrganizationSetting →
  // core.set_organization_setting (owner/ops_admin, whitelisted keys, audited as
  // organization.setting_set). Only WhatsApp reads an identifier the panel may
  // set; the others' identifiers are environment values the panel cannot write.
  const editors: Record<string, React.ReactNode> = {
    whatsapp: (
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <span className={labelClass}>Phone number id</span>
          <WhatsAppNumberForm current={whatsappNumberId} />
          <SettingHistory label="WhatsApp phone number id" entries={historyOf('whatsapp_phone_number_id')} />
        </div>
        <div className="flex flex-col gap-1">
          <span className={labelClass}>Internal test recipient</span>
          <TestRecipientForm current={whatsappTestRecipient} />
          <SettingHistory label="Internal WhatsApp test recipient" entries={historyOf('whatsapp_test_recipient')} />
        </div>
      </div>
    ),
  };
  // SCR-070: "Open secure key storage" — where the credential is, per integration.
  const envOnly = (names: string) => `${names} live in the deployment environment. The panel never stores, shows or changes them; a deploy does.`;
  const secrets: Record<string, SecureStorage> = {
    whatsapp: { href: '/settings/communication', note: envOnly('WHATSAPP_ACCESS_TOKEN, WHATSAPP_APP_SECRET and WHATSAPP_VERIFY_TOKEN') + ' Settings › Communication holds the non-secret WhatsApp configuration and the verify controls.' },
    'ai-provider': { href: '/agents#vault', note: 'Provider keys are kept encrypted in the provider vault (core.provider_credentials); an environment key is read when the vault has none.' },
    transcriber: { href: '/agents#vault', note: 'The transcription key is kept encrypted in the provider vault, or read from the environment when the vault has none.' },
    'image-generator': { href: '/agents#vault', note: 'The image-generation key is kept encrypted in the provider vault, or read from the environment when the vault has none.' },
    github: { href: null, note: envOnly('GITHUB_TOKEN') },
    alerts: { href: null, note: envOnly('ALERT_WEBHOOK_URL') },
  };
  const verifiedCount = summary.VERIFIED ?? 0;
  const configuredCount = summary.CONFIGURED ?? 0;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={<>Integrations</>}
        description={
          <>
        Every external dependency and its real lifecycle. <span className="font-medium">Configured is not verified</span> —
        only the database and scheduler, which a live signal exercised, read VERIFIED; WhatsApp and the AI provider are
        configured at most until a person verifies them.
          </>
        }
        actions={
          <>
            <LiveRefresh topics={['jobs']} />
            <Link href="/agents#vault" className={buttonClass('secondary', 'sm')}>
              Provider key vault
            </Link>
            <Link href="/settings/communication" className={buttonClass('secondary', 'sm')}>
              WhatsApp credentials
            </Link>
          </>
        }
      />

      <p className="text-[13px] text-muted">
        {verifiedCount} verified · {configuredCount} configured but unproven · {integrations.length - verifiedCount - configuredCount} not configured, degraded or failed.
      </p>

      <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
        {(['VERIFIED', 'CONFIGURED', 'DEGRADED', 'NOT_CONFIGURED', 'FAILED', 'DISABLED'] as Lifecycle[]).map((lc) => (
          <div key={lc} className="rounded-lg border border-line bg-surface px-3 py-2">
            <div className={`text-lg font-semibold tabular ${STYLE[lc].text}`}>{summary[lc] ?? 0}</div>
            <div className="text-[10px] uppercase tracking-wide text-muted">{lc.replace('_', ' ')}</div>
          </div>
        ))}
      </div>

      {/* The shared IntegrationState callout (bucket F) — one per provider
          that is not verified, in the same words Readiness and every page
          that reads a provider use. Verified and disabled rows need none. */}
      {integrations.filter((i) => i.lifecycle !== 'VERIFIED' && i.lifecycle !== 'DISABLED').length > 0 ? (
        <div className="flex flex-col gap-2">
          {integrations
            .filter((i) => i.lifecycle !== 'VERIFIED' && i.lifecycle !== 'DISABLED')
            .map((i) => (
              <IntegrationState key={i.id} name={i.name} lifecycle={i.lifecycle} detail={i.detail} href={i.href} actionLabel={i.lifecycle === 'NOT_CONFIGURED' ? 'Configure' : 'Verify or repair'} />
            ))}
        </div>
      ) : null}

      <IntegrationsList integrations={integrations} verify={verify} identifiers={identifiers} editors={editors} secrets={secrets} vaultHref="/agents#vault" />

      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-4 py-3 text-[13px]">
        <span className="font-medium">Google Calendar</span>
        <span className="text-muted">— not in the lifecycle registry; verified on demand against Google (ADM-102).</span>
        <VerifyCalendarForm lastVerifiedAt={calendarVerifiedAt} calendar={calendarVerifiedName} />
        {/* SCR-070: the calendar's non-secret identifiers — the id is GOOGLE_CALENDAR_ID in the deployment
            environment (presence only; not editable from the panel), the name is what Google answered. */}
        <span className="basis-full text-xs text-muted">
          Calendar id (GOOGLE_CALENDAR_ID): {envPresent('GOOGLE_CALENDAR_ID') ? 'set in the deployment environment' : 'unset'} — not editable from the panel.
          {calendarVerifiedName ? ` Verified calendar: ${calendarVerifiedName}${effectiveOf('calendar_verified_calendar') ? ` (${effectiveOf('calendar_verified_calendar')})` : ''}.` : ''}
        </span>
      </div>

      <p className="text-xs text-muted">
        A failed row means a live read did not succeed (DATA UNAVAILABLE) — not that the integration is definitely broken,
        but that this page could not confirm it. Verify from the linked page.
      </p>
    </div>
  );
}
