import type { Metadata } from 'next';

import Link from 'next/link';

import { getIntegrations } from '@/lib/admin/integrations';
import { githubConfigured, readGithubTokenScopes } from '@/lib/git/github';
import type { Lifecycle } from '@/lib/admin/integrations-eval';
import { readOperationalSettings, settingInstant, settingText } from '@/lib/admin/settings';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { LiveRefresh } from '@/lib/realtime';
import { IntegrationState, PageHeader, PermissionDenied, buttonClass } from '@/ui';

import { VerifyAiProviderForm, VerifyCalendarForm, VerifyWhatsAppButton } from '../settings/forms';
import { IntegrationsList } from './integrations-list';

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
  if (!can(context.role, 'organization.settings')) return <PermissionDenied />;

  const [{ integrations, summary }, settings, githubScopes] = await Promise.all([getIntegrations(), readOperationalSettings(), githubConfigured() ? readGithubTokenScopes() : Promise.resolve(null)]);
  // SCR-067 / SCR-070: one verify control per integration that has an
  // action — the SAME forms Settings and /agents use, behind
  // verifyWhatsAppAction / verifyAiProviderAction / verifyCalendarAction —
  // and the non-secret identifiers each row can honestly show.
  const whatsappNumberId = settingText(settings, 'whatsapp_phone_number_id');
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
  const identifiers: Record<string, { label: string; value: string }[]> = {
    whatsapp: [
      { label: 'Phone number id', value: whatsappNumberId ?? 'not set' },
      ...(whatsappVerifiedNumber ? [{ label: 'Verified number', value: whatsappVerifiedNumber }] : []),
    ],
    'ai-provider': providerVerifiedModel ? [{ label: 'Verified model', value: providerVerifiedModel }] : [],
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

      <IntegrationsList integrations={integrations} verify={verify} identifiers={identifiers} vaultHref="/agents#vault" />

      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-4 py-3 text-[13px]">
        <span className="font-medium">Google Calendar</span>
        <span className="text-muted">— not in the lifecycle registry; verified on demand against Google (ADM-102).</span>
        <VerifyCalendarForm lastVerifiedAt={calendarVerifiedAt} calendar={calendarVerifiedName} />
      </div>

      <p className="text-xs text-muted">
        A failed row means a live read did not succeed (DATA UNAVAILABLE) — not that the integration is definitely broken,
        but that this page could not confirm it. Verify from the linked page.
      </p>
    </div>
  );
}
