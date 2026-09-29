import type { Metadata } from 'next';

import { requireInternal } from '@/lib/auth/session';
import { HELP } from '@/lib/help/screens';
import { PageHeader } from '@/ui';

import { HelpSearch } from './help-search';

export const metadata: Metadata = { title: 'Help' };

/**
 * Help — the panel explains itself (bucket E, decision E3; blueprint A34).
 *
 * One entry per screen of the 71-screen inventory, generated at build time
 * by `scripts/build-help.mjs` from `docs/AGENCYOS_ADMIN_MASTER_SCREEN_INVENTORY.md`
 * into `src/lib/help/screens.json`. Nothing on this page is written twice:
 * the route, the capability that guards it, what it reads and its status are
 * the inventory's own words. Every internal role may read it — knowing a
 * screen exists is not the same as opening it; the capability is printed so
 * a person can see why a link refuses them.
 *
 * `?q=` seeds the search box so the shell's "?" can deep-link, and the
 * entries carry `id`s so `/help#scr-007` scrolls to one.
 */
export default async function HelpPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requireInternal('/help');
  const { q } = await searchParams;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Help"
        title="Every screen, and what it does"
        description={`${HELP.count} screens from the master screen inventory — route, who may open it, what it reads, and whether it is complete. Generated from ${HELP.source}; the "?" in the header brings you to the screen you are on.`}
      />
      <HelpSearch screens={HELP.screens} initialQuery={q ?? ''} />
    </div>
  );
}
