import { configStatus, type ConfigArea, type ConfigItem } from '@/lib/admin/config-status';
import { requireInternal } from '@/lib/auth/session';
import { createClient } from '@/lib/db/server';
import { readCronAgeSeconds } from '@/lib/observability/queries';

import Link from 'next/link';

import { agencyClock } from '@/lib/admin/agency-clock';
import { readSettingHistory } from '@/lib/admin/settings-history';
import { readSettingImpact } from '@/lib/admin/settings-impact';
import { buttonClass } from '@/ui';

import { QuotationContactForm } from './forms';
import { OrganizationNameFormWithPreview, TimezoneFormWithPreview } from './high-risk-forms';
import { SettingHistory, type SettingHistoryEntry } from './setting-history';

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
 * length, or prefix crosses to the browser.
 */

const AREAS: readonly ConfigArea[] = [
  'Database',
  'Application',
  'Scheduler',
  'WhatsApp',
  'AI provider',
  'Speech to text',
  'Figma',
  'GitHub',
  'Calendar',
  'Alerts',
  'Files',
  'Email',
];

function Dot({ item }: { item: ConfigItem }) {
  if (item.present) return <span className="text-success">configured</span>;
  if (item.requiredInProduction)
    return <span className="text-danger">not configured — required</span>;
  return <span className="text-muted">not configured — optional</span>;
}

export default async function SettingsGeneralPage() {
  await requireInternal('/settings');

  const status = configStatus();
  const clock = await agencyClock();
  // SCR-071: what a high-risk change touches, and each setting's recorded history.
  const [cronAge, impact, history] = await Promise.all([readCronAgeSeconds(), readSettingImpact(), readSettingHistory()]);
  const show = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v));
  const historyOf = (key: string): SettingHistoryEntry[] =>
    (history.get(key) ?? []).map((h) => ({ auditId: h.auditId, before: show(h.before), after: show(h.after), actor: `${h.actorType ?? 'unknown'} ${h.actorId ? h.actorId.slice(0, 8) : ''}`.trim(), atLabel: clock.dateTime(h.at) }));

  // The agency timezone is a business fact, not a secret, so it is shown. Null
  // by design until an owner sets it (G-137) — and until then nothing sends.
  const supabase = await createClient();
  const { data: orgRows } = await supabase
    .schema('core')
    .from('organizations')
    .select('name, timezone, settings')
    .limit(1);
  const timezone = orgRows?.[0]?.timezone ?? null;
  const organizationName = orgRows?.[0]?.name ?? '';
  const orgSettings = (orgRows?.[0]?.settings ?? {}) as Record<string, unknown>;
  // G-171 — the contact block on every quotation PDF.
  const contactEmail =
    typeof orgSettings.quotation_contact_email === 'string' ? orgSettings.quotation_contact_email : null;
  const contactPhone =
    typeof orgSettings.quotation_contact_phone === 'string' ? orgSettings.quotation_contact_phone : null;
  const contactLocation =
    typeof orgSettings.quotation_contact_location === 'string' ? orgSettings.quotation_contact_location : null;

  const problems = status.productionProblems;
  const ready = problems.length === 0;
  const cronStale = cronAge === null || cronAge > 15 * 60;
  const cronLabel =
    cronAge === null ? 'unknown' : cronAge > 3600 ? `${Math.floor(cronAge / 3600)}h ago` : cronAge > 90 ? `${Math.floor(cronAge / 60)}m ago` : `${cronAge}s ago`;

  return (
    <div className="flex flex-col gap-5">
      <div
        className={`rounded-lg border px-4 py-3 text-sm ${ready ? 'border-success/30 text-success' : 'border-warning/30 text-warning'}`}
      >
        {ready
          ? 'Every production-required value is present and safe.'
          : `${problems.length} configuration ${problems.length === 1 ? 'value is' : 'values are'} missing or unsafe for production (see below). NODE_ENV=${status.nodeEnv}.`}
      </div>

      {/* SCR-071: where the sensitive things live — one click, not a search. */}
      <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5 shadow-xs">
        <h2 className="text-[13px] font-semibold tracking-tight">Security, integrations and the key vault</h2>
        <p className="text-xs text-muted">The three places a setting with teeth lives. Secrets are never shown; the vault says only whether a key is present and when it was set.</p>
        <div className="flex flex-wrap gap-2">
          <Link href="/security" className={buttonClass('secondary', 'sm')}>Security</Link>
          <Link href="/security/users" className={buttonClass('secondary', 'sm')}>Users &amp; roles</Link>
          <Link href="/security/incidents" className={buttonClass('secondary', 'sm')}>Incidents</Link>
          <Link href="/integrations" className={buttonClass('secondary', 'sm')}>Integrations</Link>
          <Link href="/agents#vault" className={buttonClass('secondary', 'sm')}>Provider key vault</Link>
          <Link href="/governance/overrides" className={buttonClass('secondary', 'sm')}>Overrides &amp; emergency controls</Link>
        </div>
      </div>

      {AREAS.map((area) => {
        const items = status.items.filter((i) => i.area === area);
        if (items.length === 0) return null;
        return (
          <div key={area} className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5 shadow-xs">
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
        <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5 shadow-xs">
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
      <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[13px] font-semibold tracking-tight">Agency name</h2>
          <SettingHistory label="Agency name" entries={historyOf('name')} />
        </div>
        <p className="text-xs text-muted">
          The letterhead on every quotation PDF a client keeps, and the sender of every
          announcement. This is the agency&rsquo;s signature — renaming is owner-only and audited.
        </p>
        <OrganizationNameFormWithPreview current={organizationName} impact={impact.name} />
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5 shadow-xs">
        <h2 className="text-[13px] font-semibold tracking-tight">Quotation contact details</h2>
        <p className="text-xs text-muted">
          Printed under the agency name on every quotation PDF, so a client who forwards the
          document to a partner can still reach you from it. Leave a field empty to clear it —
          a quotation with none of these set simply carries no contact line rather than an
          invented one.
        </p>
        <QuotationContactForm email={contactEmail} phone={contactPhone} location={contactLocation} />
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[13px] font-semibold tracking-tight">Agency timezone</h2>
          <SettingHistory label="Agency timezone" entries={historyOf('timezone')} />
        </div>
        <p className="text-xs text-muted">
          {timezone
            ? 'Follow-ups schedule in this zone. Changing it re-schedules future sends — preview what it touches before confirming.'
            : 'Not set — follow-up sending is paused until an IANA timezone is chosen (G-137). Nothing sends before that.'}
        </p>
        <TimezoneFormWithPreview current={timezone} impact={impact.timezone} />
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5 shadow-xs">
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
