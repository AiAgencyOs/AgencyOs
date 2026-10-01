/**
 * SCR-038 — "Recent feedback", and "Feedback must link to the exact design/
 * prototype version it refers to".
 *
 * Two ledgers hold what a client said about the design, and each already names
 * the exact version: a Phase 3 decision (`client_design_decisions`) answers one
 * SHARE, and a share stores a snapshot of the theme options and their versions
 * that were sent; a Phase 4 decision (`ui_version_client_decisions`) names one
 * UI version. This merges them newest first and says, in words built only from
 * those rows, which version each answer refers to. Nothing here is inferred.
 *
 * Pure: no server-only imports.
 */

export type SharedOptionSnapshot = { name?: unknown; version?: unknown };

export type DesignDecisionRow = {
  id: string;
  shareId: string;
  decision: string;
  clientWords: string;
  selectedThemeOptionId: string | null;
  createdAt: string;
};
export type DesignShareRow = { id: string; shareNumber: number; sharedOptions: unknown[] };
export type ThemeOptionRow = { id: string; name: string; version?: number | null };
export type UiVersionDecisionRow = { id: string; uiVersion: number | null; decision: string; clientWords: string; createdAt: string };

export type FeedbackEntry = {
  id: string;
  kind: 'design' | 'prototype';
  at: string;
  decision: string;
  words: string;
  /** What the answer refers to, e.g. “Theme “Calm” v1 · share 2” or “UI version 3”. */
  refersTo: string;
};

function optionLabel(o: SharedOptionSnapshot): string | null {
  const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : null;
  if (!name) return null;
  const version = typeof o.version === 'number' ? ` v${o.version}` : '';
  return `${name}${version}`;
}

/** The versions a share carried, as written in its own snapshot; empty when it stored none. */
export function sharedVersions(share: DesignShareRow | undefined): string[] {
  if (!share) return [];
  return share.sharedOptions
    .map((o) => (o && typeof o === 'object' ? optionLabel(o as SharedOptionSnapshot) : null))
    .filter((x): x is string => x !== null);
}

export function describeDesignRef(decision: DesignDecisionRow, share: DesignShareRow | undefined, themes: ReadonlyMap<string, ThemeOptionRow>): string {
  const shareLabel = share ? `share ${share.shareNumber}` : 'a share that is no longer listed';
  const picked = decision.selectedThemeOptionId ? themes.get(decision.selectedThemeOptionId) : undefined;
  if (picked) return `Theme “${picked.name}”${typeof picked.version === 'number' ? ` v${picked.version}` : ''} · ${shareLabel}`;
  const versions = sharedVersions(share);
  return versions.length > 0 ? `${versions.join(', ')} · ${shareLabel}` : `The options sent in ${shareLabel}`;
}

export function recentFeedback(input: {
  decisions: readonly DesignDecisionRow[];
  shares: readonly DesignShareRow[];
  themes: readonly ThemeOptionRow[];
  uiDecisions: readonly UiVersionDecisionRow[];
  limit?: number;
}): FeedbackEntry[] {
  const shareOf = new Map(input.shares.map((s) => [s.id, s]));
  const themeOf = new Map(input.themes.map((t) => [t.id, t]));
  const entries: FeedbackEntry[] = [
    ...input.decisions.map<FeedbackEntry>((d) => ({
      id: `design-${d.id}`,
      kind: 'design',
      at: d.createdAt,
      decision: d.decision,
      words: d.clientWords,
      refersTo: describeDesignRef(d, shareOf.get(d.shareId), themeOf),
    })),
    ...input.uiDecisions.map<FeedbackEntry>((d) => ({
      id: `prototype-${d.id}`,
      kind: 'prototype',
      at: d.createdAt,
      decision: d.decision,
      words: d.clientWords,
      refersTo: d.uiVersion === null ? 'A UI version that is no longer listed' : `UI version ${d.uiVersion}`,
    })),
  ];
  return entries.sort((a, b) => b.at.localeCompare(a.at)).slice(0, input.limit ?? 5);
}

/** Case-insensitive match of an asset search over the fields the asset card shows. */
export function assetMatches(asset: { title: string; kind: string; status: string; rightsNote?: string | null }, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return `${asset.title} ${asset.kind.replace(/_/g, ' ')} ${asset.status} ${asset.rightsNote ?? ''}`.toLowerCase().includes(q);
}
