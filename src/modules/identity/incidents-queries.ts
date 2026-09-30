import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import type { IncidentKind, IncidentSeverity } from './incidents-schema';

/**
 * SCR-069 — the incident and exception history, read-only. `security.incidents`
 * under its internal select policy; the doors in `incidents-service.ts` are
 * the only writes.
 */

export type IncidentRow = {
  id: string;
  kind: IncidentKind;
  severity: IncidentSeverity;
  summary: string;
  evidence: Record<string, unknown>;
  openedAt: string;
  openedByName: string | null;
  resolvedAt: string | null;
  resolvedByName: string | null;
  resolution: string | null;
};

export async function listIncidents(limit = 200): Promise<IncidentRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('security')
    .from('incidents')
    .select('id, kind, severity, summary, evidence, opened_at, opened_by, resolved_at, resolved_by, resolution')
    .order('opened_at', { ascending: false })
    .limit(limit);
  if (error) unreadable('listIncidents', error);

  const rows = data ?? [];
  const ids = [...new Set(rows.flatMap((r) => [r.opened_by, r.resolved_by]).filter((id): id is string => id !== null))];
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const { data: users, error: usersError } = await supabase.schema('core').from('users').select('id, full_name, email').in('id', ids);
    if (usersError) unreadable('listIncidents.users', usersError);
    for (const u of users ?? []) names.set(u.id, u.full_name ?? u.email);
  }
  const name = (id: string | null) => (id ? (names.get(id) ?? id.slice(0, 8)) : null);

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as IncidentKind,
    severity: r.severity as IncidentSeverity,
    summary: r.summary,
    evidence: (r.evidence && typeof r.evidence === 'object' && !Array.isArray(r.evidence) ? r.evidence : {}) as Record<string, unknown>,
    openedAt: r.opened_at,
    openedByName: name(r.opened_by),
    resolvedAt: r.resolved_at,
    resolvedByName: name(r.resolved_by),
    resolution: r.resolution,
  }));
}

export async function countOpenIncidents(): Promise<number> {
  const supabase = await createClient();
  const { count, error } = await supabase.schema('security').from('incidents').select('id', { count: 'exact', head: true }).is('resolved_at', null);
  if (error) unreadable('countOpenIncidents', error);
  return count ?? 0;
}
