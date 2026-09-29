'use client';

import Link from 'next/link';
import { useState } from 'react';

import type { Integration, Lifecycle } from '@/lib/admin/integrations-eval';
import { Badge, DetailList, DetailRow, Drawer, buttonClass } from '@/ui';

const STYLE: Record<Lifecycle, { dot: string; text: string }> = {
  VERIFIED: { dot: 'bg-success', text: 'text-success' },
  CONFIGURED: { dot: 'bg-warning', text: 'text-warning' },
  DEGRADED: { dot: 'bg-warning', text: 'text-warning' },
  NOT_CONFIGURED: { dot: 'bg-neutral-400', text: 'text-muted' },
  FAILED: { dot: 'bg-danger', text: 'text-danger' },
  DISABLED: { dot: 'bg-neutral-400', text: 'text-muted' },
};

const TONE: Record<Lifecycle, 'success' | 'warning' | 'neutral' | 'danger'> = {
  VERIFIED: 'success',
  CONFIGURED: 'warning',
  DEGRADED: 'warning',
  NOT_CONFIGURED: 'neutral',
  FAILED: 'danger',
  DISABLED: 'neutral',
};

/** One non-secret identifier an integration reads: its current value and, when the panel set it, since when. */
export type IntegrationIdentifier = {
  label: string;
  value: string;
  /** "effective <date>" for a value the panel's settings door wrote; absent for one the environment carries. */
  effective?: string;
};

/** Where an integration's secrets are kept — a link when the panel has a store for them, else the plain fact. */
export type SecureStorage = { href: string | null; note: string };

/**
 * The integration rows, each with its verify control beside it and a detail
 * drawer — SCR-067 / SCR-070. The verify controls are the existing forms
 * (`verifyWhatsAppAction`, `verifyAiProviderAction`, `verifyCalendarAction`
 * behind them), rendered on the server and handed in by integration id;
 * this component only decides which row's drawer is open. An integration
 * with no verify action says so rather than showing a button that would do
 * nothing — the database and scheduler are verified by the live read and
 * heartbeat this page already performs.
 *
 * SCR-070's "Update non-secret identifiers" and "Open secure key storage"
 * live in the same drawer: `editors` carries the Settings forms for the
 * identifiers the settings door (`core.set_organization_setting`) whitelists,
 * scoped to that integration's keys, with each one's history; `secrets`
 * says where the credential is and links to it when the panel holds one.
 */
export function IntegrationsList({
  integrations,
  verify,
  identifiers,
  editors = {},
  secrets = {},
  vaultHref,
}: {
  integrations: Integration[];
  /** The verify form for an integration id, when one exists. */
  verify: Record<string, React.ReactNode>;
  /** Non-secret identifiers per integration id, e.g. the phone number id. */
  identifiers: Record<string, IntegrationIdentifier[]>;
  /** The settings forms that update an integration's non-secret identifiers, per id — the same forms Settings mounts. */
  editors?: Record<string, React.ReactNode>;
  /** Where each integration's secret lives, per id. */
  secrets?: Record<string, SecureStorage>;
  vaultHref: string;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = integrations.find((i) => i.id === openId) ?? null;
  const secure = open ? secrets[open.id] : undefined;

  return (
    <>
      <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface">
        {integrations.map((i) => (
          <li key={i.id} className="flex flex-col gap-2 px-4 py-3 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <div className="flex flex-col">
                <button type="button" onClick={() => setOpenId(i.id)} className="flex items-center gap-2 text-left font-medium hover:underline">
                  <span className={`inline-block h-2 w-2 rounded-full ${STYLE[i.lifecycle].dot}`} aria-hidden />
                  {i.name}
                </button>
                <span className="text-xs text-muted">
                  {i.category} · {i.detail}
                </span>
              </div>
              <span className="flex items-center gap-2 text-xs">
                <span className={STYLE[i.lifecycle].text}>{i.lifecycle.replace('_', ' ')}</span>
                {i.external ? (
                  <span className="rounded border border-line bg-surface px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">external</span>
                ) : null}
                {editors[i.id] ? (
                  <button type="button" onClick={() => setOpenId(i.id)} className={buttonClass('secondary', 'sm')}>
                    Update identifiers
                  </button>
                ) : null}
                <button type="button" onClick={() => setOpenId(i.id)} className={buttonClass('ghost', 'sm')}>
                  Details
                </button>
              </span>
            </div>
            {verify[i.id] ? <div className="pl-4">{verify[i.id]}</div> : null}
          </li>
        ))}
      </ul>

      <Drawer
        open={open !== null}
        onClose={() => setOpenId(null)}
        title={open?.name ?? ''}
        description={open ? `${open.category} · ${open.lifecycle.replace('_', ' ')}` : undefined}
        footer={
          open ? (
            <>
              <Link href={open.href} className={buttonClass('secondary', 'sm')}>
                Open its page
              </Link>
              {secure?.href ? (
                <Link href={secure.href} className={buttonClass('primary', 'sm')}>
                  Open secure key storage
                </Link>
              ) : open.id === 'ai-provider' || open.id === 'transcriber' || open.id === 'image-generator' ? (
                <Link href={vaultHref} className={buttonClass('primary', 'sm')}>
                  Key vault
                </Link>
              ) : null}
            </>
          ) : null
        }
      >
        {open ? (
          <div className="flex flex-col gap-4">
            <DetailList>
              <DetailRow label="Lifecycle" value={<Badge tone={TONE[open.lifecycle]} dot>{open.lifecycle.replace('_', ' ')}</Badge>} />
              <DetailRow label="Evidence" value={<span className="text-left">{open.detail}</span>} />
              <DetailRow label="Needs an external credential" value={open.external ? 'yes' : 'no'} />
              {(identifiers[open.id] ?? []).map((row) => (
                <DetailRow
                  key={row.label}
                  label={row.label}
                  value={
                    <span className="flex flex-col items-end gap-0.5">
                      <code className="text-xs">{row.value}</code>
                      {row.effective ? <span className="text-[11px] text-muted">{row.effective}</span> : null}
                    </span>
                  }
                />
              ))}
            </DetailList>
            <div className="flex flex-col gap-1">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted">Verification</p>
              {verify[open.id] ? (
                verify[open.id]
              ) : (
                <p className="text-[13px] text-muted">
                  {open.id === 'database' || open.id === 'scheduler'
                    ? 'Verified by the live signal this page reads — a query that answered, a heartbeat that ticked. There is no separate action.'
                    : 'No verification action exists for this integration; its state is read from configuration alone.'}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted">Update non-secret identifiers</p>
              {editors[open.id] ? (
                editors[open.id]
              ) : (
                <p className="text-[13px] text-muted">
                  {(identifiers[open.id] ?? []).length > 0
                    ? 'These identifiers come from the deployment environment; the panel reads them and cannot change them. Nothing here is a secret, and nothing here is editable.'
                    : 'This integration reads no non-secret identifier from the panel; there is nothing to update here.'}
                </p>
              )}
            </div>
            {secure ? (
              <div className="flex flex-col gap-1">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted">Secure key storage</p>
                <p className="text-[13px] text-muted">{secure.note}</p>
              </div>
            ) : null}
          </div>
        ) : null}
      </Drawer>
    </>
  );
}
