import type { Metadata } from 'next';
import Link from 'next/link';

import { agencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listContracts, listWonDeals } from '@/modules/sales/contract-service';
import { CONTRACT_STATUSES } from '@/modules/sales/contract-schema';
import { Card, CardHeader, EmptyState, FilterChips, IconFile, PageHeader, PermissionDenied, Stat, StatGrid, statusTone } from '@/ui';

import { SalesTabs } from '../sales-tabs';
import { NewContractForm } from './contract-forms';
import { ContractsTable } from './contracts-list';

export const metadata: Metadata = { title: 'Contracts' };

/**
 * Sales & CRM › Contracts — owner decision 10. A simple record on a WON deal:
 * title, file link, signer name, signed date, status draft / sent / signed.
 * No e-signature. Read on `lead.read`; recording and moving one need
 * `lead.write`, and the doors (`sales.create_contract`,
 * `sales.update_contract_status`) re-check the role and write an audit row.
 */
export default async function ContractsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const context = await requireInternal('/contracts');
  if (!can(context, 'lead.read')) return <PermissionDenied />;

  const { status: statusParam } = await searchParams;
  const status = (CONTRACT_STATUSES as readonly string[]).includes(statusParam ?? '') ? statusParam : undefined;
  const mayWrite = can(context, 'lead.write');

  const [all, deals, clock] = await Promise.all([listContracts(), mayWrite ? listWonDeals() : Promise.resolve([]), agencyClock()]);
  const rows = status ? all.filter((c) => c.status === status) : all;
  const count = (s: string) => all.filter((c) => c.status === s).length;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Contracts"
        description={
          all.length === 0
            ? 'Record the contract for a deal you have won: who signed it, when, and where the file is kept.'
            : `${all.length} contract${all.length === 1 ? '' : 's'} on won deals · ${count('signed')} signed.`
        }
      />

      <SalesTabs />

      {all.length > 0 ? (
        <StatGrid cols={4}>
          {CONTRACT_STATUSES.map((s) => (
            <Stat key={s} label={s.charAt(0).toUpperCase() + s.slice(1)} value={String(count(s))} tone={statusTone(s)} href={`/contracts?status=${s}`} />
          ))}
        </StatGrid>
      ) : null}

      {all.length > 0 ? (
        <FilterChips
          options={[
            { key: 'all', label: `All (${all.length})`, href: '/contracts', active: !status },
            ...CONTRACT_STATUSES.map((s) => ({ key: s, label: `${s.charAt(0).toUpperCase() + s.slice(1)} (${count(s)})`, href: `/contracts?status=${s}`, active: status === s })),
          ]}
        />
      ) : null}

      {rows.length > 0 ? (
        <ContractsTable rows={rows} clock={clock} mayWrite={mayWrite} />
      ) : (
        <EmptyState
          icon={<IconFile size={22} />}
          title={all.length === 0 ? 'No contracts yet' : 'No contract has this status'}
          description={
            all.length === 0
              ? deals.length > 0 || !mayWrite
                ? 'A contract belongs to a won deal. Record the first one below.'
                : 'A contract belongs to a won deal, and none has been won yet.'
              : 'Pick another status, or clear the filter.'
          }
          action={
            status ? (
              <Link href="/contracts" className="text-sm font-medium text-brand hover:underline">
                Show all contracts
              </Link>
            ) : (
              <Link href="/sales-funnel" className="text-sm font-medium text-brand hover:underline">
                Open the pipeline
              </Link>
            )
          }
        />
      )}

      {mayWrite ? (
        <Card>
          <CardHeader title="Record a Contract" />
          <div className="px-4 pb-4 sm:px-5">
            {deals.length > 0 ? (
              <NewContractForm deals={deals} />
            ) : (
              <p className="text-[13px] text-muted">No deal has been won yet. A contract can only be recorded on a won deal.</p>
            )}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
