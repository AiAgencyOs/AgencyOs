import { IconCalendar, IconClock, IconFile, IconInvoices, IconTarget, IconUsers, TabStrip } from '@/ui';

/**
 * The Sales & CRM tab row — Pipeline · Leads · Meetings · Proposals ·
 * Follow-ups · Contracts. One definition for every page that wears it, so a
 * tab added here appears on all of them.
 */
export function SalesTabs({ className = 'min-w-0' }: { className?: string }) {
  return (
    <TabStrip
      className={className}
      label="Sales & CRM"
      tabs={[
        { href: '/sales-funnel', label: 'Pipeline', icon: <IconTarget size={15} />, exact: true },
        { href: '/leads', label: 'Leads', icon: <IconUsers size={15} /> },
        { href: '/meetings', label: 'Meetings', icon: <IconCalendar size={15} /> },
        { href: '/quotations', label: 'Proposals', icon: <IconInvoices size={15} /> },
        { href: '/follow-ups', label: 'Follow-ups', icon: <IconClock size={15} /> },
        { href: '/contracts', label: 'Contracts', icon: <IconFile size={15} /> },
      ]}
    />
  );
}
