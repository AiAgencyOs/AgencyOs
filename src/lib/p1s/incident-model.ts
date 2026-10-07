import { asRows } from '@/lib/p13/loose-client';

/** A29 (P1-BLUEPRINT-035): the rows of `ai.p1s_incident_queue`, parsed defensively. Pure, so a test can call it. */

export type IncidentSeverity = 'critical' | 'high' | 'medium' | 'low';
export type IncidentSource = 'task' | 'security' | 'escalation' | 'job' | 'outage';

export type IncidentRow = {
  key: string;
  source: IncidentSource;
  sourceId: string;
  sourceTaskId: string | null;
  severity: IncidentSeverity;
  title: string;
  state: 'open' | 'closed';
  owner: string;
  openedAt: string;
  ageMinutes: number;
  uncertainSideEffect: boolean;
  outageProvider: string | null;
  runbookKey: string;
  detail: string;
  correlationId: string | null;
};

const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
const SOURCES = ['task', 'security', 'escalation', 'job', 'outage'] as const;

export function parseIncidentRows(data: unknown): IncidentRow[] {
  return asRows(data).flatMap((r) => {
    const severity = String(r.severity);
    const source = String(r.source);
    if (!(SEVERITIES as readonly string[]).includes(severity) || !(SOURCES as readonly string[]).includes(source)) return [];
    return [
      {
        key: String(r.incident_key),
        source: source as IncidentSource,
        sourceId: String(r.source_id),
        sourceTaskId: r.source_task_id ? String(r.source_task_id) : null,
        severity: severity as IncidentSeverity,
        title: String(r.title ?? ''),
        state: r.state === 'closed' ? ('closed' as const) : ('open' as const),
        owner: String(r.owner_label ?? ''),
        openedAt: String(r.opened_at),
        ageMinutes: Number(r.age_minutes) || 0,
        uncertainSideEffect: r.uncertain_side_effect === true,
        outageProvider: r.outage_provider ? String(r.outage_provider) : null,
        runbookKey: String(r.runbook_key ?? ''),
        detail: String(r.detail ?? ''),
        correlationId: r.correlation_id ? String(r.correlation_id) : null,
      },
    ];
  });
}

/** Age as people say it: minutes under an hour, hours under two days, else days. */
export function formatAge(minutes: number): string {
  if (minutes < 60) return `${Math.max(0, minutes)} min`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h`;
  return `${Math.round(minutes / 1440)} d`;
}
