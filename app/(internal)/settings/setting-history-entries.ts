import 'server-only';

import { agencyClock } from '@/lib/admin/agency-clock';
import { readSettingHistory } from '@/lib/admin/settings-history';

import type { SettingHistoryEntry } from './setting-history';

/** How many recorded changes a setting's History drawer carries — the last few, not the whole trail. */
const LAST_FEW = 10;

/**
 * The per-setting History affordance's data, read once per page (F-1).
 *
 * One read of the audit trail through `readSettingHistory` (which goes through
 * the audit read door, `readAuditLog`, admin-tier — no table of its own), and
 * one clock. The returned function answers, for one key or for the several a
 * single form writes together (the sending window is two), the newest changes
 * shaped for `<SettingHistory>`: old value, new value, who, when. A read that
 * fails throws — an empty drawer would say "never changed" about a setting
 * that was.
 */
export async function loadSettingHistory(): Promise<(...keys: string[]) => SettingHistoryEntry[]> {
  const [history, clock] = await Promise.all([readSettingHistory(), agencyClock()]);
  const show = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v));

  return (...keys: string[]) => {
    const several = keys.length > 1;
    return keys
      .flatMap((key) =>
        (history.get(key) ?? []).map((h) => ({
          auditId: h.auditId,
          before: several && show(h.before) ? `${key}: ${show(h.before)}` : show(h.before),
          after: several ? `${key}: ${show(h.after) || '—'}` : show(h.after),
          actor: `${h.actorType ?? 'unknown'} ${h.actorId ? h.actorId.slice(0, 8) : ''}`.trim(),
          atLabel: clock.dateTime(h.at),
        })),
      )
      .sort((a, b) => b.auditId - a.auditId)
      .slice(0, LAST_FEW);
  };
}
