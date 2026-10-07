import type { Metadata } from 'next';

import { readSettingsAreaSummaries } from '@/lib/admin/settings-summary';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { PageHeader, PermissionDenied, Stat, StatGrid } from '@/ui';

import { SettingsTabs } from './settings-tabs';

export const metadata: Metadata = { title: 'Settings' };

const TABS = [
  { href: '/settings', label: 'General' },
  { href: '/settings/commercial', label: 'Commercial' },
  { href: '/settings/team', label: 'Team' },
  { href: '/settings/communication', label: 'Communication' },
  { href: '/settings/approvals', label: 'Approvals' },
  { href: '/settings/finance', label: 'Finance' },
  // Decision: reversed by the owner on 2026-09-29 — project templates.
  { href: '/settings/templates', label: 'Templates' },
  { href: '/settings/project-defaults', label: 'Project defaults' },
  { href: '/settings/budget-bands', label: 'Budget bands' },
  { href: '/settings/policy-versions', label: 'Policy versions' },
  { href: '/settings/notification-rules', label: 'Notification rules' },
  { href: '/settings/lead-scoring', label: 'Lead scoring' },
] as const;

/**
 * Was one 640-line page with ~23 stacked sections — every configuration area
 * on a single scroll, no way to jump to just the WhatsApp block or just the
 * commercial terms. This layout is the tab shell; each tab keeps the exact
 * queries, forms and G-xxx comments that used to live on the combined page,
 * just grouped by what an owner is actually trying to change.
 */
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const context = await requireInternal('/settings');
  if (!can(context, 'organization.settings')) return <PermissionDenied />;
  // SCR-071: one status tile per area, so the page does not open on an environment list.
  const areas = await readSettingsAreaSummaries();

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={<>Settings</>}
        description={
          <>
            Configuration status for this deployment. Secret values are never shown here or sent
            to your browser — only whether each is present. Set secrets in the deployment
            environment, not in the product.
          </>
        }
      />
      <StatGrid>
        {areas.map((a) => (
          <Stat key={a.key} label={a.label} value={a.value} caption={a.caption} tone={a.tone === 'success' ? 'success' : a.tone === 'warning' ? 'warning' : 'neutral'} href={a.href} compact />
        ))}
      </StatGrid>
      <SettingsTabs tabs={TABS} />
      {/* A bounded column: a form field the full width of a 1400px canvas
          reads as a text area, not a setting. Each page's sections are
          cards (screen architecture §4, "rounded cards"). */}
      <div className="max-w-4xl [&_h2]:text-sm">{children}</div>
    </div>
  );
}
