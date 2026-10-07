/**
 * P1-BLUEPRINT-030 / 044: pure helpers for the policy-version screen. No I/O; the page and the tests both use them.
 */
export const POLICY_KINDS = ['pricing', 'discount', 'payment', 'approval', 'trust', 'negotiation', 'follow_up', 'routing', 'data'] as const;
export type PolicyKind = (typeof POLICY_KINDS)[number];

export const POLICY_KIND_LABEL: Record<PolicyKind, string> = {
  pricing: 'Pricing',
  discount: 'Discount',
  payment: 'Payment',
  approval: 'Approval',
  trust: 'Trust',
  negotiation: 'Negotiation',
  follow_up: 'Follow-up',
  routing: 'Routing',
  data: 'Data restrictions',
};

export type PolicyVersionRow = {
  id: string;
  policy_kind: PolicyKind;
  version: number;
  status: 'draft' | 'active' | 'superseded';
  summary: string;
  body: Record<string, unknown>;
  effective_from: string | null;
  activated_at: string | null;
  activation_reason: string | null;
};

export type BodyChange = { path: string; before: unknown; after: unknown; type: 'added' | 'removed' | 'changed' };

function flatten(value: unknown, prefix: string, out: Map<string, unknown>): void {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0 && prefix) out.set(prefix, {});
    for (const [k, v] of entries) flatten(v, prefix ? `${prefix}.${k}` : k, out);
    return;
  }
  out.set(prefix, value);
}

/** The impact preview: exactly which settings a draft would change against the version now in force. Sorted by path. */
export function diffPolicyBodies(active: Record<string, unknown> | null, draft: Record<string, unknown>): BodyChange[] {
  const a = new Map<string, unknown>();
  const d = new Map<string, unknown>();
  flatten(active ?? {}, '', a);
  flatten(draft, '', d);
  const changes: BodyChange[] = [];
  for (const [path, after] of d) {
    if (!a.has(path)) changes.push({ path, before: undefined, after, type: 'added' });
    else if (JSON.stringify(a.get(path)) !== JSON.stringify(after)) changes.push({ path, before: a.get(path), after, type: 'changed' });
  }
  for (const [path, before] of a) if (!d.has(path)) changes.push({ path, before, after: undefined, type: 'removed' });
  return changes.sort((x, y) => x.path.localeCompare(y.path));
}

/** One line per kind: what is in force, what is waiting. A kind with nothing says so; it is never invented. */
export function indexByKind(rows: readonly PolicyVersionRow[]): Record<PolicyKind, { active: PolicyVersionRow | null; draft: PolicyVersionRow | null; history: PolicyVersionRow[] }> {
  const out = {} as Record<PolicyKind, { active: PolicyVersionRow | null; draft: PolicyVersionRow | null; history: PolicyVersionRow[] }>;
  for (const k of POLICY_KINDS) out[k] = { active: null, draft: null, history: [] };
  for (const r of [...rows].sort((x, y) => y.version - x.version)) {
    const slot = out[r.policy_kind];
    if (!slot) continue;
    if (r.status === 'active') slot.active = r;
    else if (r.status === 'draft') slot.draft = r;
    else slot.history.push(r);
  }
  return out;
}

/** The text of a form → a JSON object, or the reason it is not one. */
export function parsePolicyBody(text: string): { ok: true; body: Record<string, unknown> } | { ok: false; problem: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, problem: 'The policy body is empty.' };
  if (trimmed.length > 20000) return { ok: false, problem: 'The policy body is too long.' };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, problem: 'The policy body must be a JSON object.' };
    return { ok: true, body: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, problem: 'The policy body is not valid JSON.' };
  }
}
