/**
 * Vendor / tool rollup — SCR-055. Pure: the expenses page hands in its rows
 * and gets one line per vendor (or "No vendor recorded"), per currency, with
 * the categories that vendor was recorded under. A rollup, not a judgement:
 * nothing here decides what a "tool" is beyond what the person typed in the
 * category field.
 */

export type VendorRollupRow = {
  vendor: string;
  currency: string;
  totalMinor: number;
  count: number;
  categories: string[];
  lastIncurredOn: string;
};

export const NO_VENDOR = 'No vendor recorded';

export function rollupByVendor(
  expenses: readonly { vendor: string | null; currency: string; amountMinor: number; category: string; incurredOn: string }[],
): VendorRollupRow[] {
  const byKey = new Map<string, VendorRollupRow & { cats: Set<string> }>();
  for (const e of expenses) {
    const vendor = (e.vendor ?? '').trim() || NO_VENDOR;
    const key = `${vendor.toLowerCase()}|${e.currency}`;
    const row = byKey.get(key) ?? { vendor, currency: e.currency, totalMinor: 0, count: 0, categories: [], lastIncurredOn: e.incurredOn, cats: new Set<string>() };
    row.totalMinor += e.amountMinor;
    row.count += 1;
    row.cats.add(e.category);
    if (e.incurredOn > row.lastIncurredOn) row.lastIncurredOn = e.incurredOn;
    byKey.set(key, row);
  }
  return [...byKey.values()]
    .map(({ cats, ...row }) => ({ ...row, categories: [...cats].sort() }))
    .sort((a, b) => b.totalMinor - a.totalMinor || a.vendor.localeCompare(b.vendor));
}
