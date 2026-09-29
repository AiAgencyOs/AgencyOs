'use server';

import { getAuthContext } from '@/lib/auth/session';
import { isInternalRole } from '@/lib/auth/claims';
import { anyKillSwitchActive, KILL_SWITCH_LABEL } from '@/lib/observability/kill-switches';
import { listOpenAlerts } from '@/lib/observability/alerts';

export type IncidentBannerState = {
  /** Unacknowledged critical alerts, most recent first. */
  critical: { id: string; summary: string }[];
  /** Emergency controls currently engaged. */
  engaged: string[];
};

/**
 * What the cross-app incident banner shows — SCR-067/068. Fetched by the
 * banner AFTER the page has rendered and again when `core.alerts` or
 * `core.kill_switches` change, on the bell's pattern, so the layout's own
 * render path still makes no database read. Signed-out or non-internal
 * callers get nothing rather than an error.
 */
export async function readIncidentBannerAction(): Promise<IncidentBannerState> {
  const context = await getAuthContext();
  if (!context || !isInternalRole(context.role)) return { critical: [], engaged: [] };

  const [alerts, switches] = await Promise.all([listOpenAlerts(50), anyKillSwitchActive()]);
  return {
    critical: alerts.filter((a) => a.severity === 'critical').map((a) => ({ id: a.id, summary: a.summary })),
    engaged: switches.map((s) => KILL_SWITCH_LABEL[s.switch]),
  };
}
