import Link from 'next/link';

import type { AgencyClock } from '@/lib/admin/agency-clock';
import type { ContractRow } from '@/modules/sales/contract-service';
import { Badge, DataTable, statusTone, type Column } from '@/ui';

import { ContractStatusForm } from './contract-forms';

/**
 * The contracts table, shared by the Contracts screen and the lists on the
 * deal (Lead 360) and the client. `mayWrite` only decides whether the
 * status form is drawn; the door decides again.
 */
export function ContractsTable({ rows, clock, mayWrite, showDeal = true, showClient = true }: { rows: readonly ContractRow[]; clock: AgencyClock; mayWrite: boolean; showDeal?: boolean; showClient?: boolean }) {
  const columns: Column<ContractRow>[] = [
    {
      key: 'title',
      header: 'Contract',
      primary: true,
      cell: (c) => (
        <span className="min-w-0">
          <span className="block truncate font-medium">{c.title}</span>
          {c.fileUrl ? (
            <a href={c.fileUrl} target="_blank" rel="noopener noreferrer" className="block truncate text-[11px] font-normal text-brand hover:underline">
              Open file
            </a>
          ) : (
            <span className="block text-[11px] font-normal text-muted">No file link yet</span>
          )}
        </span>
      ),
    },
    ...(showDeal
      ? [
          {
            key: 'deal',
            header: 'Won Deal',
            cellClassName: 'text-muted',
            cell: (c: ContractRow) => (c.leadId ? <Link href={`/leads/${c.leadId}`} className="hover:underline">{c.dealName}</Link> : c.dealName),
          },
        ]
      : []),
    ...(showClient
      ? [
          {
            key: 'client',
            header: 'Client',
            desktopOnly: true,
            cellClassName: 'text-muted',
            cell: (c: ContractRow) => (c.clientAccountId && c.clientName ? <Link href={`/clients/${c.clientAccountId}`} className="hover:underline">{c.clientName}</Link> : '—'),
          },
        ]
      : []),
    { key: 'status', header: 'Status', badge: true, cell: (c) => <Badge tone={statusTone(c.status)} dot={false}>{c.status.charAt(0).toUpperCase() + c.status.slice(1)}</Badge> },
    {
      key: 'signed',
      header: 'Signed',
      desktopOnly: true,
      cellClassName: 'text-muted whitespace-nowrap',
      cell: (c) => (c.status === 'signed' && c.signedOn ? `${c.signerName ?? 'Signer not named'} · ${clock.date(c.signedOn)}` : '—'),
    },
    ...(mayWrite
      ? [
          {
            key: 'update',
            header: 'Update',
            cell: (c: ContractRow) => <ContractStatusForm contractId={c.id} status={c.status} signerName={c.signerName} leadId={c.leadId} clientId={c.clientAccountId} />,
          },
        ]
      : []),
  ];
  return <DataTable rows={rows} columns={columns} getKey={(c) => c.id} ariaLabel="Contracts" />;
}
