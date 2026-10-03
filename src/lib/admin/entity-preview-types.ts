/**
 * Client-safe types for the quick-preview drawer — SCR-002 (bucket F,
 * stream F-A). The drawer is a client component shared by the /search page
 * and the ⌘K palette; the reader in `entity-preview.ts` is server-only.
 */

export const PREVIEW_GROUPS = ['Lead', 'Client', 'Project', 'Invoice', 'Quotation', 'Meeting', 'Task', 'Build', 'Test Run', 'Bug', 'Payment'] as const;
export type PreviewGroup = (typeof PREVIEW_GROUPS)[number];

export function isPreviewGroup(value: string | undefined): value is PreviewGroup {
  return (PREVIEW_GROUPS as readonly string[]).includes(value ?? '');
}

export type PreviewFact = { label: string; value: string };

/** What the entity's own header would say — name, status, a subtitle, and the icon-led facts. */
export type EntityPreview = {
  group: PreviewGroup;
  id: string;
  name: string;
  status: string | null;
  subtitle: string | null;
  facts: PreviewFact[];
  href: string;
};
