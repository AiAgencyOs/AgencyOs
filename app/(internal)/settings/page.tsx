import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { configStatus, type ConfigArea, type ConfigItem } from '@/lib/admin/config-status';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { readCronAgeSeconds } from '@/lib/observability/queries';

export const metadata: Metadata = { title: 'Settings · AgencyOS' };

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
  if (item.present) return <span className="text-green-600 dark:text-green-400">configured</span>;
  if (item.requiredInProduction)
    return <span className="text-red-600 dark:text-red-400">not configured — required</span>;
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
  const { data: orgRows } = await supabase.schema('core').from('organizations').select('timezone').limit(1);
  const timezone = orgRows?.[0]?.timezone ?? null;

  const problems = status.productionProblems;
  const ready = problems.length === 0;
  const cronStale = cronAge === null || cronAge > 15 * 60;
  const cronLabel =
    cronAge === null ? 'unknown' : cronAge > 3600 ? `${Math.floor(cronAge / 3600)}h ago` : cronAge > 90 ? `${Math.floor(cronAge / 60)}m ago` : `${cronAge}s ago`;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted">
          Configuration status for this deployment. Secret values are never shown here or sent to your browser — only
          whether each is present. Set secrets in the deployment environment, not in the product.
        </p>
      </div>

      <div
        className={`rounded-lg border px-4 py-3 text-sm ${
          ready
            ? 'border-green-500/30 text-green-700 dark:text-green-400'
            : 'border-amber-500/30 text-amber-700 dark:text-amber-400'
        }`}
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
            <h2 className="text-sm font-medium">{area}</h2>
            <ul className="flex flex-col divide-y divide-black/5 rounded-lg border border-black/10 dark:divide-white/5 dark:border-white/15">
              {items.map((item) => (
                <li key={item.key} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-4 py-3 text-sm">
                  <div className="flex items-baseline gap-2">
                    <code className="text-xs">{item.key}</code>
                    {item.secret ? (
                      <span className="rounded bg-black/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted dark:bg-white/10">
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
          <h2 className="text-sm font-medium">Not ready for production</h2>
          <ul className="flex flex-col gap-1 rounded-lg border border-amber-500/30 px-4 py-3 text-sm">
            {problems.map((p) => (
              <li key={p.variable} className="text-amber-700 dark:text-amber-400">
                <code className="text-xs">{p.variable}</code> — {p.problem}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Agency timezone</h2>
        <div
          className={`rounded-lg border px-4 py-3 text-sm ${
            timezone ? 'border-black/10 dark:border-white/15' : 'border-amber-500/30 text-amber-700 dark:text-amber-400'
          }`}
        >
          {timezone ? (
            <span>
              Set to <code className="text-xs">{timezone}</code>. Follow-ups schedule in this zone.
            </span>
          ) : (
            <span>
              Not set. Follow-up sending is paused until an IANA timezone is chosen (G-137) — nothing sends before that.
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Scheduler</h2>
        <div
          className={`flex items-baseline justify-between rounded-lg border px-4 py-3 text-sm ${
            cronStale ? 'border-red-500/30 text-red-600 dark:text-red-400' : 'border-black/10 text-muted dark:border-white/15'
          }`}
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
