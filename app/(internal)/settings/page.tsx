import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { configStatus, type ConfigArea, type ConfigItem } from '@/lib/admin/config-status';
import { reactivationSummary } from '@/lib/admin/reactivation-summary';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { PageHeader } from '@/ui';
import { createClient } from '@/lib/db/server';
import { readCronAgeSeconds } from '@/lib/observability/queries';

import {
  PilotToggleForm,
  TestRecipientForm,
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

const AREAS: readonly ConfigArea[] = ['Database', 'Application', 'Scheduler', 'WhatsApp', 'AI provider', 'Alerts'];

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
  const { data: orgRows } = await supabase.schema('core').from('organizations').select('timezone, settings').limit(1);
  const timezone = orgRows?.[0]?.timezone ?? null;
  const orgSettings = (orgRows?.[0]?.settings ?? {}) as Record<string, unknown>;
  const whatsappPhoneNumberId =
    typeof orgSettings.whatsapp_phone_number_id === 'string' ? orgSettings.whatsapp_phone_number_id : null;
  const whatsappTestRecipient =
    typeof orgSettings.whatsapp_test_recipient === 'string' ? orgSettings.whatsapp_test_recipient : null;
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

      <div className="flex flex-col gap-2">
        <h2 className="text-[13px] font-semibold tracking-tight">Agency timezone</h2>
        <p className="text-xs text-muted">
          {timezone
            ? 'Follow-ups schedule in this zone. Changing it re-schedules future sends.'
            : 'Not set — follow-up sending is paused until an IANA timezone is chosen (G-137). Nothing sends before that.'}
        </p>
        <TimezoneForm current={timezone} />
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
