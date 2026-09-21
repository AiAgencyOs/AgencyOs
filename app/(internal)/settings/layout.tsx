import type { Metadata } from 'next';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { PageHeader } from '@/ui';
import { redirect } from 'next/navigation';

import { SettingsTabs } from './settings-tabs';

export const metadata: Metadata = { title: 'Settings' };

const TABS = [
  { href: '/settings', label: 'General' },
  { href: '/settings/commercial', label: 'Commercial' },
  { href: '/settings/team', label: 'Team' },
  { href: '/settings/communication', label: 'Communication' },
  { href: '/settings/approvals', label: 'Approvals' },
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
  if (!can(context.role, 'organization.settings')) redirect('/dashboard');

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
      <SettingsTabs tabs={TABS} />
      {children}
    </div>
  );
}
