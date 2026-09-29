import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, unreadable, type Result } from '@/lib/result';

/**
 * Alerts a person acknowledges — SCR-067, `core.alerts` (20261001150000).
 *
 * Raised by the runner (a dead job, a provider over budget) through
 * `core.raise_alert`; read here for the Operations page and the incident
 * banner; acknowledged through `core.acknowledge_alert`, with a reason,
 * audited. `job.requeue`'s two roles — owner and ops_admin — may
 * acknowledge, and the function checks `core.is_admin()` again itself.
 */

export type AlertSeverity = 'info' | 'warning' | 'critical';

export type AlertRow = {
  id: string;
  source: string;
  severity: AlertSeverity;
  summary: string;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  acknowledgedAt: string | null;
  acknowledgedByName: string | null;
  acknowledgeReason: string | null;
};

const COLUMNS = 'id, source, severity, summary, occurrences, first_seen_at, last_seen_at, acknowledged_at, acknowledged_by, acknowledge_reason';

type Raw = {
  id: string;
  source: string;
  severity: string;
  summary: string;
  occurrences: number;
  first_seen_at: string;
  last_seen_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  acknowledge_reason: string | null;
};

async function withNames(rows: Raw[]): Promise<AlertRow[]> {
  const supabase = await createClient();
  const ids = [...new Set(rows.map((r) => r.acknowledged_by).filter((id): id is string => id !== null))];
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const { data, error } = await supabase.schema('core').from('users').select('id, full_name, email').in('id', ids);
    if (error) unreadable('listAlerts.users', error);
    for (const u of data ?? []) names.set(u.id, u.full_name ?? u.email);
  }
  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    severity: r.severity as AlertSeverity,
    summary: r.summary,
    occurrences: r.occurrences,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    acknowledgedAt: r.acknowledged_at,
    acknowledgedByName: r.acknowledged_by ? (names.get(r.acknowledged_by) ?? r.acknowledged_by.slice(0, 8)) : null,
    acknowledgeReason: r.acknowledge_reason,
  }));
}

/** Every open alert, most severe and most recent first. */
export async function listOpenAlerts(limit = 100): Promise<AlertRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('core')
    .from('alerts')
    .select(COLUMNS)
    .is('acknowledged_at', null)
    .order('last_seen_at', { ascending: false })
    .limit(limit);
  if (error) unreadable('listOpenAlerts', error);
  const order: Record<string, number> = { critical: 0, warning: 1, info: 2 };
  const rows = (data ?? []) as Raw[];
  rows.sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
  return withNames(rows);
}

/** The most recently acknowledged alerts — what somebody looked at, and why they closed it. */
export async function listAcknowledgedAlerts(limit = 25): Promise<AlertRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('core')
    .from('alerts')
    .select(COLUMNS)
    .not('acknowledged_at', 'is', null)
    .order('acknowledged_at', { ascending: false })
    .limit(limit);
  if (error) unreadable('listAcknowledgedAlerts', error);
  return withNames((data ?? []) as Raw[]);
}

export type OpenAlertCounts = { critical: number; warning: number; info: number };

export async function countOpenAlerts(): Promise<OpenAlertCounts> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('core').from('alerts').select('severity').is('acknowledged_at', null).limit(1_000);
  if (error) unreadable('countOpenAlerts', error);
  const counts: OpenAlertCounts = { critical: 0, warning: 0, info: 0 };
  for (const r of data ?? []) {
    if (r.severity === 'critical') counts.critical += 1;
    else if (r.severity === 'warning') counts.warning += 1;
    else counts.info += 1;
  }
  return counts;
}

export async function acknowledgeAlert(alertId: string, reason: string): Promise<Result<{ alertId: string }>> {
  if (!/^[0-9a-f-]{36}$/i.test(alertId)) return err('VALIDATION', 'That is not an alert id.');
  const trimmed = reason.trim();
  if (!trimmed) return err('VALIDATION', 'Say what was done about it — the reason is what the audit row keeps.');
  if (trimmed.length > 500) return err('VALIDATION', 'Keep the reason under 500 characters.');

  const context = await requireInternal();
  if (!can(context, 'job.requeue')) {
    return err('FORBIDDEN', 'You do not have permission to acknowledge alerts.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase.schema('core').rpc('acknowledge_alert', { p_alert_id: alertId, p_reason: trimmed });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'acknowledgeAlert', alertId, detail: error.message }));
    return err('INTERNAL', 'Could not acknowledge that alert.');
  }

  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  switch (row?.outcome) {
    case 'acknowledged':
      return ok({ alertId });
    case 'already_acknowledged':
      return err('CONFLICT', 'Somebody has already acknowledged that alert.');
    case 'not_found':
      return err('NOT_FOUND', 'That alert is not in this organisation.');
    case 'no_reason':
      return err('VALIDATION', 'Say what was done about it.');
    default:
      return err('FORBIDDEN', 'You do not have permission to acknowledge alerts.');
  }
}
