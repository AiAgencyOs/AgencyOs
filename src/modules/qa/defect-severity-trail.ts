/**
 * SCR-047 — "change severity with reason": the reason of the LAST severity
 * change, read back from where `triageDefect` writes it.
 *
 * Triage appends `Severity <from> → <to>: <reason>` to `qa.defects.resolution`
 * rather than replacing it, so the trail is in the row. This pure function
 * reads that trail; the page shows the newest entry beside the severity.
 */
export type SeverityChange = { from: string; to: string; reason: string };

const LINE = /^Severity (\w+) → (\w+): (.*)$/;

export function severityChanges(resolution: string | null | undefined): SeverityChange[] {
  if (!resolution) return [];
  const out: SeverityChange[] = [];
  for (const line of resolution.split('\n')) {
    const m = LINE.exec(line.trim());
    if (m) out.push({ from: m[1]!, to: m[2]!, reason: m[3]!.trim() });
  }
  return out;
}

export function lastSeverityChange(resolution: string | null | undefined): SeverityChange | null {
  const all = severityChanges(resolution);
  return all[all.length - 1] ?? null;
}

/** The resolution text with the severity lines removed — what was said about the fix itself. */
export function resolutionWithoutSeverityLines(resolution: string | null | undefined): string | null {
  if (!resolution) return null;
  const kept = resolution
    .split('\n')
    .filter((line) => !LINE.test(line.trim()))
    .join('\n')
    .trim();
  return kept.length > 0 ? kept : null;
}
