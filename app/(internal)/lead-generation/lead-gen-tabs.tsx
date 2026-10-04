'use client';

import { CHANNEL_LABEL, CHANNEL_SLUG, ACQUISITION_CHANNELS } from '@/modules/acquisition/schema';
import { IconActivity, IconSettings, TabStrip } from '@/ui';

/** The Lead Generation tab row - Overview, the five engines, Settings. Tabs are routes, so the URL is the state. */
export function LeadGenTabs() {
  return (
    <TabStrip
      className="min-w-0"
      label="Lead generation"
      tabs={[
        { href: '/lead-generation', label: 'Overview', icon: <IconActivity size={15} />, exact: true },
        ...ACQUISITION_CHANNELS.map((c) => ({ href: `/lead-generation/${CHANNEL_SLUG[c]}`, label: CHANNEL_LABEL[c] })),
        { href: '/lead-generation/settings', label: 'Settings', icon: <IconSettings size={15} /> },
      ]}
    />
  );
}
