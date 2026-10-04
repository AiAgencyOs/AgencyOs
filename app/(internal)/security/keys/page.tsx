import type { Metadata } from 'next';
import Link from 'next/link';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can, hasRole } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { SECRET_CATEGORIES, SECRET_CATEGORY_LABEL } from '@/lib/secrets/registry';
import { readKeysOverview, type KeyRow } from '@/lib/secrets/overview';
import { Badge, buttonClass, Callout, Card, CardHeader, EmptyState, FilterChips, IconLock, PageHeader, PermissionDenied, Stat, StatGrid } from '@/ui';

import { TrailLabel } from '../../trail-label';
import { RevokeSecretForm, StoreSecretForm, VerifySecretForm } from './key-forms';

export const metadata: Metadata = { title: 'Keys & secrets' };

const SHOWS = ['all', 'configured', 'missing', 'attention'] as const;
type Show = (typeof SHOWS)[number];

/**
 * Keys & secrets — one screen for every key the system uses. It hangs off
 * SCR-071 (Organization Settings) and sits under Security & Audit.
 *
 * What it does: shows, for each key, where the running system reads it from
 * (the hosting environment or the encrypted vault), when a stored copy was set
 * and by whom, when it expires or is due for rotation, and whether a live check
 * last passed; lets the OWNER store, replace and revoke a key; lets an admin
 * verify one. What it never does: show a value. A key is typed once into a
 * password field, encrypted in the server, and gone from the screen for good.
 *
 * The environment always wins. A value set in the hosting dashboard is used
 * before the vault's copy (the provider vault's own rule, applied to every
 * key), so a deployment that works today is unchanged; where both exist the
 * row says which one is live and why the other is idle.
 */
export default async function KeysPage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  const context = await requireInternal('/security/keys');
  // View and verify: the owner and the ops admin (audit.read). Store and revoke stay owner-only below.
  if (!can(context, 'audit.read')) return <PermissionDenied />;
  const isOwner = hasRole(context, 'owner');

  const { show: showParam } = await searchParams;
  const show: Show = (SHOWS as readonly string[]).includes(showParam ?? '') ? (showParam as Show) : 'all';

  const supabase = await createClient();
  const clock = await agencyClock();
  const overview = await readKeysOverview(supabase, new Date());

  if (!overview.ok) {
    return (
      <div className="flex flex-col gap-5">
        <PageHeader eyebrow="Security" title="Keys & secrets" description="Every key the system uses, in one place." />
        <Callout tone="danger" title="The vault could not be read">
          {overview.error.message} Nothing was changed. Reload to try again; if it persists, the audit trail and the operations page say what failed.
        </Callout>
      </div>
    );
  }

  const { rows, vaultReady } = overview.data;
  const storable = rows.filter((r) => r.slot.storage !== 'env_only');
  const configured = storable.filter((r) => r.source !== 'none');
  const missing = storable.filter((r) => r.source === 'none');
  const attention = rows.filter((r) => r.attention);

  const visible = (r: KeyRow) => {
    if (show === 'configured') return r.source !== 'none' && r.slot.storage !== 'env_only';
    if (show === 'missing') return r.source === 'none' && r.slot.storage !== 'env_only';
    if (show === 'attention') return r.attention;
    return true;
  };
  const href = (s: Show) => (s === 'all' ? '/security/keys' : `/security/keys?show=${s}`);

  return (
    <div className="flex flex-col gap-5">
      <TrailLabel name="Keys & secrets" />
      <PageHeader
        eyebrow="Security"
        title="Keys & secrets"
        description="Every key the system uses, in one place: where it comes from, when it was set, when it expires. Stored keys are encrypted, shown only as their last four characters, and every change is audited."
        meta={
          <>
            <Badge tone={vaultReady ? 'success' : 'danger'} dot>
              {vaultReady ? 'Vault ready' : 'Vault cannot encrypt'}
            </Badge>
            <Badge tone="neutral">{isOwner ? 'You are the owner: you may store and revoke' : 'View and verify — the owner stores and revokes'}</Badge>
          </>
        }
        actions={
          <Link href="/audit" className="text-[13px] font-medium text-brand underline-offset-2 hover:underline">
            Audit trail
          </Link>
        }
      />

      {!vaultReady ? (
        <Callout tone="danger" title="The vault has no encryption key">
          <code className="font-mono text-[12px]">VAULT_ENCRYPTION_KEY</code> is not set on this deployment, so no key can be encrypted or stored from here. Set it once in the hosting environment (a random 32+ character secret, for example <code className="font-mono text-[12px]">openssl rand -hex 32</code>) and redeploy. Keys set in the hosting environment keep working meanwhile.
        </Callout>
      ) : null}

      <StatGrid>
        <Stat label="Keys the system uses" value={String(storable.length)} caption="Storable here, beside the environment-only ones below" tone="neutral" icon={<IconLock size={16} />} href={href('all')} />
        <Stat label="Configured" value={String(configured.length)} caption="Set in the environment or the vault" tone="success" icon={<IconLock size={16} />} href={href('configured')} />
        <Stat label="Not set" value={String(missing.length)} caption="Whatever needs them says not configured" tone={missing.length > 0 ? 'warning' : 'success'} icon={<IconLock size={16} />} href={href('missing')} />
        <Stat label="Need attention" value={String(attention.length)} caption="Expired, expiring within 14 days, due for rotation, or a failed check" tone={attention.length > 0 ? 'danger' : 'success'} icon={<IconLock size={16} />} href={href('attention')} />
      </StatGrid>

      <FilterChips
        options={[
          { key: 'all', label: 'All', href: href('all'), active: show === 'all' },
          { key: 'configured', label: `Configured (${configured.length})`, href: href('configured'), active: show === 'configured' },
          { key: 'missing', label: `Not set (${missing.length})`, href: href('missing'), active: show === 'missing' },
          { key: 'attention', label: `Need attention (${attention.length})`, href: href('attention'), active: show === 'attention' },
        ]}
      />

      {SECRET_CATEGORIES.map((category) => {
        const inCategory = rows.filter((r) => r.slot.category === category).filter(visible);
        if (inCategory.length === 0) return null;
        return (
          <Card key={category} id={category}>
            <CardHeader title={SECRET_CATEGORY_LABEL[category]} description={category === 'platform' ? 'These open the vault or are sent by the platform itself, so they can only be set in the hosting environment.' : undefined} />
            <ul className="divide-y divide-line">
              {inCategory.map((row) => (
                <KeyRowView key={row.slot.key} row={row} isOwner={isOwner} vaultReady={vaultReady} dateTime={(iso) => clock.dateTime(iso)} />
              ))}
            </ul>
          </Card>
        );
      })}

      {rows.filter(visible).length === 0 ? (
        <EmptyState
          title="Nothing matches"
          description="No key is in that state right now."
          action={
            <Link href="/security/keys" className={buttonClass('secondary', 'sm')}>
              Show every key
            </Link>
          }
        />
      ) : null}
    </div>
  );
}

function KeyRowView({ row, isOwner, vaultReady, dateTime }: { row: KeyRow; isOwner: boolean; vaultReady: boolean; dateTime: (iso: string) => string }) {
  const { slot } = row;
  const envOnly = slot.storage === 'env_only';
  const providerVault = slot.storage === 'provider_vault' ? slot.provider : undefined;
  const hasVaultCopy = row.source === 'vault' || row.vaultShadowed;

  return (
    <li id={slot.key} className="flex flex-col gap-3 px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">
            {slot.label} <code className="ml-1 font-mono text-[11px] font-normal text-muted">{slot.key}</code>
          </p>
          <p className="mt-0.5 max-w-3xl text-[13px] text-muted">{slot.purpose}</p>
          <p className="mt-0.5 text-xs text-faint">Used by: {slot.usedBy.join(' · ')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {row.source === 'env' ? <Badge tone="success" dot>Environment</Badge> : null}
          {row.source === 'vault' ? <Badge tone="brand" dot>Vault</Badge> : null}
          {row.source === 'none' ? <Badge tone={envOnly ? 'danger' : 'warning'} dot>{envOnly ? 'Missing from the environment' : 'Not set'}</Badge> : null}
          {row.plainValue ? <Badge tone="neutral" mono>{row.plainValue}</Badge> : null}
          {row.hint && !slot.plain ? <Badge tone="neutral" mono>…{row.hint}</Badge> : null}
          {row.expiry === 'expired' ? <Badge tone="danger" dot>Expired {row.expiresOn}</Badge> : null}
          {row.expiry === 'soon' ? <Badge tone="warning" dot>Expires {row.expiresOn}</Badge> : null}
          {row.expiry === 'ok' ? <Badge tone="neutral">Expires {row.expiresOn}</Badge> : null}
          {row.rotate ? <Badge tone="warning" dot>Rotate — set {row.ageDays} days ago</Badge> : null}
          {row.lastVerifiedOk === true ? <Badge tone="success" dot>Verified {row.lastVerifiedAt ? dateTime(row.lastVerifiedAt) : ''}</Badge> : null}
          {row.lastVerifiedOk === false ? <Badge tone="danger" dot>Check failed</Badge> : null}
        </div>
      </div>

      {row.vaultShadowed ? (
        <p className="text-xs text-muted">
          A copy is also stored in the vault, but the hosting environment sets <code className="font-mono">{slot.key}</code> and that value is the one in use. To use the vault copy, remove the environment variable in the hosting dashboard and redeploy.
        </p>
      ) : null}
      {row.updatedAt ? (
        <p className="text-xs text-faint">
          Stored copy set {dateTime(row.updatedAt)}
          {row.updatedByName ? ` by ${row.updatedByName}` : ''}.
          {row.lastVerifiedOk === false && row.lastVerifiedDetail ? ` Last check: ${row.lastVerifiedDetail}` : ''}
        </p>
      ) : null}

      {envOnly ? (
        <p className="text-xs text-muted">Environment only. {slot.envOnlyReason}</p>
      ) : (
        <div className="flex flex-col gap-3">
          {providerVault ? (
            <p className="text-[13px] text-muted">
              AI provider keys are managed in one place - several keys per provider, rotation, health and the models they serve.{' '}
              <Link href={`/agents/providers/${providerVault}?tab=credentials`} className="font-medium text-brand underline-offset-2 hover:underline">
                Manage in AI providers
              </Link>
            </p>
          ) : isOwner && vaultReady ? (
            <details className="group rounded-lg border border-line bg-surface-sunken px-3 py-2">
              <summary className="cursor-pointer text-[13px] font-medium text-foreground">{slot.plain ? (hasVaultCopy ? 'Change this setting' : 'Set this') : hasVaultCopy ? 'Replace the stored key' : 'Store a key'}</summary>
              <div className="mt-3">
                <StoreSecretForm slot={slot.key} label={slot.label} plain={slot.plain} canExpire={slot.canExpire} replace={hasVaultCopy} whereToGetIt={slot.whereToGetIt} />
              </div>
            </details>
          ) : null}
          {!isOwner && !providerVault ? <p className="text-xs text-muted">Only the owner may store or revoke a key.</p> : null}
          <div className="flex flex-wrap items-start gap-3">
            {slot.verifier && row.source !== 'none' ? <VerifySecretForm slot={slot.key} /> : null}
            {isOwner && hasVaultCopy && !providerVault ? <RevokeSecretForm slot={slot.key} label={slot.label} /> : null}
          </div>
        </div>
      )}
    </li>
  );
}
