/**
 * P1-BLUEPRINT-018 (quote version compare) / P1-FLOW "show what changed between V1 and V2".
 *
 * Pure: two quotation versions in, a list of what differs out. The page reads both through `getProposal` (RLS-scoped, so a version the caller may not see
 * is simply absent) and this function decides nothing about permission or about which version is live. Money is compared in minor units, never as formatted
 * text; line items are matched by their DESCRIPTION (case- and space-insensitive) so a re-ordered line is not reported as removed-and-added.
 */

export type DiffItem = { description: string; quantity: number; unit_price_minor: number; amount_minor: number };
export type DiffProposal = {
  version: number;
  title: string;
  status: string;
  currency: string;
  subtotal_minor: number;
  discount_minor: number;
  tax_minor: number;
  total_minor: number;
  valid_until: string | null;
  plan_label: string | null;
  body: string | null;
  items: readonly DiffItem[];
};

export type FieldChange = { field: string; label: string; from: string | number | null; to: string | number | null; kind: 'money' | 'text' | 'date' };
export type ItemChange =
  | { type: 'added'; description: string; to: DiffItem }
  | { type: 'removed'; description: string; from: DiffItem }
  | { type: 'changed'; description: string; from: DiffItem; to: DiffItem; what: ('quantity' | 'unit_price' | 'amount')[] };

export type ProposalComparison = {
  from: number;
  to: number;
  currencyChanged: boolean;
  fields: FieldChange[];
  items: ItemChange[];
  identical: boolean;
};

const norm = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();

export function compareProposals(a: DiffProposal, b: DiffProposal): ProposalComparison {
  const fields: FieldChange[] = [];
  const push = (field: string, label: string, kind: FieldChange['kind'], from: string | number | null, to: string | number | null) => {
    if (from !== to) fields.push({ field, label, from, to, kind });
  };
  push('title', 'Title', 'text', a.title, b.title);
  push('status', 'Status', 'text', a.status, b.status);
  push('currency', 'Currency', 'text', a.currency, b.currency);
  push('subtotal_minor', 'Subtotal', 'money', a.subtotal_minor, b.subtotal_minor);
  push('discount_minor', 'Discount', 'money', a.discount_minor, b.discount_minor);
  push('tax_minor', 'Tax', 'money', a.tax_minor, b.tax_minor);
  push('total_minor', 'Total', 'money', a.total_minor, b.total_minor);
  push('valid_until', 'Valid until', 'date', a.valid_until, b.valid_until);
  push('plan_label', 'Plan', 'text', a.plan_label, b.plan_label);
  push('body', 'Wording', 'text', a.body ?? null, b.body ?? null);

  // Duplicate descriptions are matched in order: the n-th "Hosting" in A to the n-th "Hosting" in B.
  const bucket = (items: readonly DiffItem[]) => {
    const map = new Map<string, DiffItem[]>();
    for (const item of items) {
      const key = norm(item.description);
      map.set(key, [...(map.get(key) ?? []), item]);
    }
    return map;
  };
  const left = bucket(a.items);
  const right = bucket(b.items);
  const changes: ItemChange[] = [];

  for (const [key, fromItems] of left) {
    const toItems = right.get(key) ?? [];
    fromItems.forEach((from, i) => {
      const to = toItems[i];
      if (!to) {
        changes.push({ type: 'removed', description: from.description, from });
        return;
      }
      const what: ('quantity' | 'unit_price' | 'amount')[] = [];
      if (from.quantity !== to.quantity) what.push('quantity');
      if (from.unit_price_minor !== to.unit_price_minor) what.push('unit_price');
      if (from.amount_minor !== to.amount_minor) what.push('amount');
      if (what.length > 0) changes.push({ type: 'changed', description: to.description, from, to, what });
    });
  }
  for (const [key, toItems] of right) {
    const fromCount = left.get(key)?.length ?? 0;
    toItems.slice(fromCount).forEach((to) => changes.push({ type: 'added', description: to.description, to }));
  }

  return { from: a.version, to: b.version, currencyChanged: a.currency !== b.currency, fields, items: changes, identical: fields.length === 0 && changes.length === 0 };
}
