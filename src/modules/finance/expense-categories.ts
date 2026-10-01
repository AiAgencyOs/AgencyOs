/**
 * The owner's expense categories (owner decision 6 of 2026-10-01) — the pure
 * half: the shapes, the labels and the two lists the screens need.
 *
 * `finance.expense_categories` holds one row per category; `finance.expenses
 * .category` stores its `key`. A category is retired, never deleted, so an old
 * expense always resolves to a label: `categoryLabel` falls back to a
 * humanised key only for a key the list has never held.
 *
 * Client-safe: no server imports, so the forms can use it.
 */

export type ExpenseCategory = {
  key: string;
  label: string;
  retired: boolean;
  sortOrder: number;
};

/** What the list started from (migration 20261007100000) — also the fallback when the list cannot be read. */
export const STARTING_EXPENSE_CATEGORIES: readonly ExpenseCategory[] = [
  { key: 'infrastructure', label: 'Infrastructure', retired: false, sortOrder: 10 },
  { key: 'ai', label: 'AI', retired: false, sortOrder: 20 },
  { key: 'tooling', label: 'Tooling', retired: false, sortOrder: 30 },
  { key: 'vendor', label: 'Vendor', retired: false, sortOrder: 40 },
  { key: 'contractor', label: 'Contractor', retired: false, sortOrder: 50 },
  { key: 'other', label: 'Other', retired: false, sortOrder: 60 },
];

export const EXPENSE_CATEGORY_KEY = /^[a-z][a-z0-9_]{0,39}$/;

function humanizeKey(key: string): string {
  const spaced = key.replace(/_/g, ' ').trim();
  return spaced.length === 0 ? key : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** The label for a stored key; a key the list never held reads as its own words, never as blank. */
export function categoryLabel(categories: readonly ExpenseCategory[], key: string): string {
  return categories.find((c) => c.key === key)?.label ?? humanizeKey(key);
}

/** What a NEW expense may be filed under: the active categories, in the owner's order. */
export function offeredCategories(categories: readonly ExpenseCategory[]): ExpenseCategory[] {
  return categories.filter((c) => !c.retired).sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
}

/**
 * What an expense that already has `current` may be re-filed under: the active
 * categories, plus its own when that one has since been retired (so opening the
 * edit form never silently re-files it).
 */
export function offeredFor(categories: readonly ExpenseCategory[], current: string): ExpenseCategory[] {
  const offered = offeredCategories(categories);
  if (offered.some((c) => c.key === current)) return offered;
  const own = categories.find((c) => c.key === current);
  return [...offered, own ?? { key: current, label: humanizeKey(current), retired: true, sortOrder: 9999 }];
}

/** Every category an existing screen may FILTER by: all of them, retired included, so old expenses stay findable. */
export function filterableCategories(categories: readonly ExpenseCategory[]): ExpenseCategory[] {
  return [...categories].sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
}

/** True when `key` is a category a person may pick for a new expense. */
export function isOffered(categories: readonly ExpenseCategory[], key: string): boolean {
  return categories.some((c) => c.key === key && !c.retired);
}
