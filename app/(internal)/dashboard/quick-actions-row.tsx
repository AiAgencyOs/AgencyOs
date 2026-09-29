'use client';

import Link from 'next/link';

import { IconApprovals, IconInvoices, IconProjects, IconUsers, QuickActions, type QuickAction } from '@/ui';

import { openQuickCreate } from '../shell-controls';

const SKIN =
  'flex h-10 min-w-0 w-full items-center gap-2 rounded-lg border border-line bg-surface px-2.5 text-[13px] font-medium text-foreground shadow-xs transition-colors hover:border-line-strong hover:bg-surface-hover';

function CreateButton({ mode, icon, label }: { mode: 'lead' | 'project' | 'invoice'; icon: React.ReactNode; label: string }) {
  return (
    <button type="button" onClick={() => openQuickCreate(mode)} className={SKIN}>
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-brand-soft text-brand">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}

/**
 * SCR-001's quick actions — Add lead, Create project, Create invoice, Open
 * approval — as the reference's button grid. The three creates open the
 * ⌘K dialog straight onto the SAME in-place forms the header's "+ Create"
 * offers (`openQuickCreate`), so there is one door per record; "Open
 * approval" is the queue itself. Each button is shown only to a role that
 * may perform it; the page decides that and passes the flags.
 */
export function QuickActionsRow({
  canCreateLead,
  canCreateProject,
  canCreateInvoice,
  pendingApprovals,
}: {
  canCreateLead: boolean;
  canCreateProject: boolean;
  canCreateInvoice: boolean;
  pendingApprovals: number | null;
}) {
  const actions: QuickAction[] = [];
  if (canCreateLead) actions.push({ label: 'Add lead', node: <CreateButton mode="lead" icon={<IconUsers size={13} />} label="Add lead" /> });
  if (canCreateProject) actions.push({ label: 'Create project', node: <CreateButton mode="project" icon={<IconProjects size={13} />} label="Create project" /> });
  if (canCreateInvoice) actions.push({ label: 'Create invoice', node: <CreateButton mode="invoice" icon={<IconInvoices size={13} />} label="Create invoice" /> });
  actions.push({
    label: 'Open approval',
    node: (
      <Link href="/approvals" className={SKIN}>
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-brand-soft text-brand">
          <IconApprovals size={13} />
        </span>
        <span className="truncate">Open approval{pendingApprovals !== null && pendingApprovals > 0 ? ` (${pendingApprovals})` : ''}</span>
      </Link>
    ),
  });
  return <QuickActions title="Quick actions" actions={actions} />;
}
