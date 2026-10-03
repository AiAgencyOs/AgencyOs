import 'server-only';

import { readAuditLog } from '@/lib/audit/queries';
import { requireInternal } from '@/lib/auth/session';

/**
 * Per-setting history — SCR-071's "current value, effective date, history".
 * Every settings door audits against the organisation row
 * (`organization.setting_set` with the key in `after.key`,
 * `organization.timezone_set`, `organization.renamed`, …), so the history
 * of one setting is the audit trail filtered to that subject and grouped by
 * the key each entry names. Read from the trail, never a second table.
 */

export type SettingChange = {
  auditId: number;
  key: string;
  before: unknown;
  after: unknown;
  actorType: string | null;
  actorId: string | null;
  at: string;
};

/** The key an audit entry is about, from the vocabulary the doors write. */
export function settingKeyOf(action: string, after: Record<string, unknown> | null, before: Record<string, unknown> | null): string | null {
  if (action === 'organization.setting_set') {
    const key = after?.key ?? before?.key;
    return typeof key === 'string' ? key : null;
  }
  if (action === 'organization.timezone_set') return 'timezone';
  if (action === 'organization.renamed') return 'name';
  if (action.startsWith('organization.') && action.endsWith('_set')) return action.slice('organization.'.length, -'_set'.length);
  return null;
}

function valueOf(action: string, snapshot: Record<string, unknown> | null): unknown {
  if (!snapshot) return null;
  if (action === 'organization.setting_set') return snapshot.value ?? null;
  const keys = Object.keys(snapshot);
  return keys.length === 1 ? snapshot[keys[0] as string] : snapshot;
}

/** Every recorded change to the organisation's settings, newest first, keyed by setting. */
export async function readSettingHistory(limit = 200): Promise<Map<string, SettingChange[]>> {
  const context = await requireInternal();
  if (!context.organizationId) return new Map();

  const entries = await readAuditLog({ subjectId: context.organizationId, actionPrefix: 'organization.', limit });
  const byKey = new Map<string, SettingChange[]>();
  for (const e of entries) {
    const key = settingKeyOf(e.action, e.after, e.before);
    if (!key) continue;
    const list = byKey.get(key) ?? [];
    list.push({
      auditId: e.id,
      key,
      before: valueOf(e.action, e.before),
      after: valueOf(e.action, e.after),
      actorType: e.actorType,
      actorId: e.actorId,
      at: e.createdAt,
    });
    byKey.set(key, list);
  }
  return byKey;
}
