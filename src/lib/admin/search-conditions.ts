/**
 * SCR-002's filter builder: stackable conditions, each a field, an operator
 * and a value, carried in the URL as repeated `f=field:op:value`. `status`
 * matches the row's own status word; `owner` its assignee/owner column (a
 * group without one ignores it); `created` compares the row's creation day.
 */
export const CONDITION_FIELDS = ['status', 'owner', 'created'] as const;
export const CONDITION_OPS: Record<(typeof CONDITION_FIELDS)[number], readonly { key: string; label: string }[]> = {
  status: [{ key: 'is', label: 'is' }, { key: 'not', label: 'is not' }],
  owner: [{ key: 'is', label: 'is' }, { key: 'not', label: 'is not' }],
  created: [{ key: 'after', label: 'is on or after' }, { key: 'before', label: 'is on or before' }],
};
export type SearchCondition = { field: (typeof CONDITION_FIELDS)[number]; op: string; value: string };

export function parseConditions(raw: string | string[] | undefined): SearchCondition[] {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out: SearchCondition[] = [];
  for (const item of list.slice(0, 8)) {
    const [field, op, ...rest] = item.split(':');
    const value = rest.join(':').trim().slice(0, 40);
    if (!(CONDITION_FIELDS as readonly string[]).includes(field ?? '') || !value) continue;
    const f = field as SearchCondition['field'];
    if (!CONDITION_OPS[f].some((o) => o.key === op)) continue;
    if (f === 'owner' && !/^[0-9a-f-]{36}$/.test(value)) continue;
    if (f === 'created' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) continue;
    out.push({ field: f, op: op as string, value });
  }
  return out;
}

export function conditionToParam(c: SearchCondition): string {
  return `${c.field}:${c.op}:${c.value}`;
}

