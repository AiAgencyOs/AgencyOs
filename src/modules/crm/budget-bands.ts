/**
 * Lead budget bands — owner decision Q-BAND, round 3 (2026-10-01).
 *
 * The owner edits the bands (an organization setting); a lead's budget is shown
 * in its band beside the figure; a lead with no budget still reads "Not
 * recorded". A band is `{ label, minMinor }`: it starts at `minMinor` (paise)
 * and runs up to the next band's start. The first starts at 0, the last is open
 * ended, so every recorded budget falls in exactly one band.
 *
 * Pure: the page reads the saved bands (or these starting ones) and calls
 * `describeBudget`; `parseBandLines` / `bandLines` are the form's text format,
 * and the database door (`crm.set_budget_bands`) checks the same rules again.
 */

export type BudgetBand = { label: string; minMinor: number };

/** What applies until the owner saves their own: four bands in rupees. */
export const STARTING_BANDS: readonly BudgetBand[] = [
  { label: 'Under ₹50K', minMinor: 0 },
  { label: '₹50K to ₹2L', minMinor: 5_000_000 },
  { label: '₹2L to ₹10L', minMinor: 20_000_000 },
  { label: '₹10L and above', minMinor: 100_000_000 },
];

export const MAX_BANDS = 12;
const MAX_MINOR = 999_999_999_999_999;

/** The band a budget in paise falls in; null when no budget is recorded. */
export function bandFor(budgetMinor: number | null | undefined, bands: readonly BudgetBand[]): BudgetBand | null {
  if (budgetMinor === null || budgetMinor === undefined || bands.length === 0) return null;
  let found: BudgetBand | null = null;
  for (const band of bands) if (budgetMinor >= band.minMinor) found = band;
  return found;
}

/** The two things a lead shows: its band and its figure, or "Not recorded". */
export function describeBudget(
  budgetMinor: number | null | undefined,
  bands: readonly BudgetBand[],
  formatMoney: (minor: number) => string,
): { band: string | null; figure: string | null; text: string } {
  if (budgetMinor === null || budgetMinor === undefined) return { band: null, figure: null, text: 'Not recorded' };
  const band = bandFor(budgetMinor, bands)?.label ?? null;
  const figure = formatMoney(budgetMinor);
  return { band, figure, text: band ? `${band} (${figure})` : figure };
}

/** True when the list is a valid set of bands (the rules the database door enforces). */
export function bandsProblem(bands: readonly BudgetBand[]): string | null {
  if (bands.length === 0) return null;
  if (bands.length > MAX_BANDS) return `At most ${MAX_BANDS} bands.`;
  const seen = new Set<string>();
  let previous: number | null = null;
  for (const band of bands) {
    const label = band.label.trim();
    if (label.length < 1 || label.length > 40) return 'Each band needs a name of 1 to 40 characters.';
    if (!Number.isInteger(band.minMinor) || band.minMinor < 0 || band.minMinor > MAX_MINOR) return `“${label}” starts at a figure that is not valid.`;
    if (seen.has(label.toLowerCase())) return `“${label}” is named twice.`;
    seen.add(label.toLowerCase());
    if (previous === null && band.minMinor !== 0) return 'The first band must start at 0, so every budget has a band.';
    if (previous !== null && band.minMinor <= previous) return `“${label}” must start higher than the band before it.`;
    previous = band.minMinor;
  }
  return null;
}

/**
 * The form's text: one band per line, the rupee figure the band starts at, then
 * its name — `50000 Small`. Commas in the figure are fine. Blank text clears
 * the setting back to the starting bands.
 */
export function parseBandLines(text: string): { bands: BudgetBand[]; problem: string | null } {
  const bands: BudgetBand[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = /^([0-9][0-9,]*)\s+(.+)$/.exec(line);
    if (!match) return { bands: [], problem: `“${line}” must be a rupee figure, a space, then the band’s name.` };
    const rupees = Number((match[1] as string).replace(/,/g, ''));
    if (!Number.isSafeInteger(rupees)) return { bands: [], problem: `“${line}” starts at a figure that is not valid.` };
    bands.push({ label: (match[2] as string).trim(), minMinor: rupees * 100 });
  }
  const problem = bandsProblem(bands);
  return { bands: problem ? [] : bands, problem };
}

export function bandLines(bands: readonly BudgetBand[]): string {
  return bands.map((b) => `${b.minMinor / 100} ${b.label}`).join('\n');
}
