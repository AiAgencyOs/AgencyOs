import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { agencyClock, type AgencyClock } from '@/lib/admin/agency-clock';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listM2Overview, type M2Row } from '@/modules/finance/queries';
import { Badge, Card, DataTable, EmptyState, IconInvoices, PageHeader, type Column, type Tone } from '@/ui';

export const metadata: Metadata = { title: 'Finance M2' };

/** Minor units → display string, in the currency the invoice was raised in. Mirrors `/invoices`'s own `money`. */
function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(minor / 100);
}

const GATE_TONE: Record<string, Tone> = {
  not_ready: 'neutral',
  invoice_issued: 'warning',
  verified: 'success',
};

const GATE_LABEL: Record<string, string> = {
  not_ready: 'not ready',
  invoice_issued: 'invoice issued',
  verified: 'verified — Phase 5 eligible',
};

const columnsFor = (clock: AgencyClock): Column<M2Row>[] => [
  { key: 'project', header: 'Project', primary: true, cell: (r) => r.projectName },
  { key: 'milestone', header: 'Milestone', cell: (r) => r.milestoneStatus },
  {
    key: 'invoice',
    header: 'Invoice',
    cell: (r) => (r.invoice ? `${r.invoice.number} · ${r.invoice.status}` : 'not raised'),
  },
  {
    key: 'amount',
    header: 'Amount',
    align: 'right',
    cell: (r) => (r.invoice ? money(r.invoice.total_minor, r.invoice.currency) : '—'),
  },
  {
    key: 'issued',
    header: 'Issued',
    align: 'right',
    cellClassName: 'text-muted',
    cell: (r) => (r.invoice?.issued_at ? clock.date(r.invoice.issued_at) : '—'),
  },
  {
    key: 'gate',
    header: 'Phase 5 gate',
    badge: true,
    cell: (r) => <Badge tone={GATE_TONE[r.gateOutcome] ?? 'neutral'}>{GATE_LABEL[r.gateOutcome] ?? r.gateOutcome}</Badge>,
  },
];

/**
 * Finance M2 — FIN §19 (P4-FIN-ADMINUI). `generateM2Invoice` and
 * `projects.phase_five_gate_status` (both `20260923160000`) are real and
 * live-verified; every general finance screen (`/finance`, `/invoices`,
 * `/invoices/verify`) already shows an M2 invoice once one exists, mixed in
 * with M1, M3 and M4. This is the dedicated M2 view Impl §10 names: which
 * projects have reached the M2 milestone, what its invoice and payment status
 * is, and — the hard gate FIN §12-17 exists to protect — whether Phase 5 is
 * actually eligible to start.
 *
 * Reads `projects.milestones` at `position = 2` (M2, FIN §2's 30/20/30/20
 * structure) the same way `generateM2Invoice` itself identifies M2 — not a
 * new concept. `gateOutcome` is `projects.phase_five_gate_status`'s own
 * answer, called once per M2 milestone found: this page never marks
 * anything paid or verified itself — that stays exclusively
 * `finance.verify_payment_submission`, reached only through
 * `/invoices/verify` by a signed-in Admin, which this page links out to
 * rather than duplicates.
 */
export default async function FinanceM2Page() {
  const context = await requireInternal('/finance/m2');
  const clock = await agencyClock();
  if (!can(context.role, 'invoice.read')) redirect('/dashboard');

  const rows = await listM2Overview();
  const verified = rows.filter((r) => r.gateOutcome === 'verified').length;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Finance M2"
        description={
          rows.length === 0
            ? 'No project has reached the M2 (20%) milestone yet.'
            : `${verified} of ${rows.length} project${rows.length === 1 ? '' : 's'} verified for Phase 5.`
        }
      />

      {rows.length > 0 ? (
        <Card className="p-0">
          <DataTable rows={rows} columns={columnsFor(clock)} getKey={(r) => r.milestoneId} href={(r) => `/projects/${r.projectId}`} />
        </Card>
      ) : (
        <EmptyState
          icon={<IconInvoices size={22} />}
          title="No M2 milestones yet"
          description="An M2 milestone appears here once Task 2 completes and generateM2Invoice raises it."
        />
      )}
    </div>
  );
}
