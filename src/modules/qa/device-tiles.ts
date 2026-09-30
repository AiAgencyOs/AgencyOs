/**
 * Device Testing tiles — SCR-044's "Device Testing" grid.
 *
 * A run that recorded a `device` (and optionally `os`, `browser`,
 * `evidence_url`) is the only thing a tile is drawn from. The platform tab a
 * tile sits under is decided from the words the tester wrote, never guessed
 * from nothing: a device whose words say none of the five platforms goes under
 * "Other". The thumbnail is the run's own evidence link when — and only when —
 * it points straight at an image; any other evidence link is offered as a link.
 */

export const PLATFORMS = ['android', 'ios', 'web', 'tablet', 'tv', 'other'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_LABEL: Record<Platform, string> = { android: 'Android', ios: 'iOS', web: 'Web', tablet: 'Tablet', tv: 'TV', other: 'Other' };

export type DeviceRun = {
  device: string | null;
  os: string | null;
  browser: string | null;
  evidenceUrl: string | null;
  failed: number;
  blocked: number;
  status: 'open' | 'closed';
  executedAt: string;
};

export type DeviceTile = {
  key: string;
  name: string;
  os: string | null;
  platform: Platform;
  runs: number;
  /** 'tested' = the newest run closed with nothing failed or blocked. */
  state: 'tested' | 'failed' | 'in_progress';
  lastAt: string;
  thumbnailUrl: string | null;
  evidenceUrl: string | null;
};

export function platformOf(run: Pick<DeviceRun, 'device' | 'os' | 'browser'>): Platform {
  const words = `${run.device ?? ''} ${run.os ?? ''}`.toLowerCase();
  if (/\b(ipad|tablet|galaxy tab)\b/.test(words)) return 'tablet';
  if (/\b(android tv|apple tv|smart tv|fire tv|tizen|webos|tv)\b/.test(words)) return 'tv';
  if (/\b(android)\b/.test(words) || /\b(galaxy|pixel|oneplus|xiaomi|redmi|realme|vivo|oppo|samsung)\b/.test(words)) return 'android';
  if (/\b(ios|iphone|ipados)\b/.test(words)) return 'ios';
  if (/\b(windows|macos|mac os|linux|chrome|firefox|safari|edge|desktop|web)\b/.test(`${words} ${(run.browser ?? '').toLowerCase()}`)) return 'web';
  return 'other';
}

const IMAGE_URL = /^https:\/\/[^\s]+\.(png|jpe?g|webp|gif|avif)(\?[^\s]*)?$/i;

/** An evidence link is a thumbnail only when it is an https link to an image file. */
export function thumbnailOf(evidenceUrl: string | null): string | null {
  const url = evidenceUrl?.trim() ?? '';
  return IMAGE_URL.test(url) ? url : null;
}

/** One tile per device name, drawn from that device's newest run; newest first. */
export function deviceTiles(runs: readonly DeviceRun[]): DeviceTile[] {
  const byDevice = new Map<string, DeviceRun[]>();
  for (const r of runs) {
    const name = r.device?.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    byDevice.set(key, [...(byDevice.get(key) ?? []), r]);
  }
  const tiles: DeviceTile[] = [];
  for (const [key, list] of byDevice) {
    const sorted = [...list].sort((a, b) => b.executedAt.localeCompare(a.executedAt));
    const latest = sorted[0]!;
    const withEvidence = sorted.find((r) => r.evidenceUrl?.trim());
    tiles.push({
      key,
      name: latest.device!.trim(),
      os: latest.os?.trim() || null,
      platform: platformOf(latest),
      runs: list.length,
      state: latest.status === 'open' ? 'in_progress' : latest.failed > 0 || latest.blocked > 0 ? 'failed' : 'tested',
      lastAt: latest.executedAt,
      thumbnailUrl: thumbnailOf(withEvidence?.evidenceUrl ?? null),
      evidenceUrl: withEvidence?.evidenceUrl?.trim() ?? null,
    });
  }
  return tiles.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

/** Tab counts, with "Tested" totals for the "6/6 Tested" chip. */
export function platformSummary(tiles: readonly DeviceTile[]): { platform: Platform; count: number; tested: number }[] {
  return PLATFORMS.map((platform) => {
    const of = tiles.filter((t) => t.platform === platform);
    return { platform, count: of.length, tested: of.filter((t) => t.state === 'tested').length };
  }).filter((p) => p.count > 0);
}
