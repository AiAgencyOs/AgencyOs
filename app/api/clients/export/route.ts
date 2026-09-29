import { NextResponse } from 'next/server';

import { listClients } from '@/lib/admin/clients';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';

/**
 * The client list as CSV — SCR-014's "export". The same reader and the same
 * gate as the page; amounts in major units, one row per account.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function cell(v: string | number | null | undefined): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(request: Request) {
  const context = await requireInternal('/clients');
  if (!can(context, 'project.read')) {
    return NextResponse.json({ error: 'You do not have permission to read clients.' }, { status: 403 });
  }

  const params = new URL(request.url).searchParams;
  const q = (params.get('q') ?? '').trim().toLowerCase();
  const tag = (params.get('tag') ?? '').trim().toLowerCase();
  const owner = (params.get('owner') ?? '').trim();
  const rows = (await listClients()).filter(
    (c) =>
      (!q || c.name.toLowerCase().includes(q) || (c.billingEmail ?? '').toLowerCase().includes(q)) &&
      (!tag || c.tags.includes(tag)) &&
      (!owner || (owner === 'none' ? c.ownerId === null : c.ownerId === owner)),
  );

  const header = ['Client', 'Billing email', 'Status', 'Owner', 'Tags', 'Joined', 'Active projects', 'Total projects', 'Currency', 'Invoiced', 'Paid', 'Outstanding'];
  const lines = rows.map((c) =>
    [
      c.name,
      c.billingEmail ?? '',
      c.status,
      c.ownerName ?? '',
      c.tags.join('; '),
      c.createdAt.slice(0, 10),
      c.projectsActive,
      c.projectsTotal,
      c.currency,
      (c.invoicedMinor / 100).toFixed(2),
      (c.paidMinor / 100).toFixed(2),
      (c.outstandingMinor / 100).toFixed(2),
    ]
      .map(cell)
      .join(','),
  );

  return new NextResponse([header.join(','), ...lines].join('\n') + '\n', {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="clients.csv"',
      'cache-control': 'no-store',
    },
  });
}
