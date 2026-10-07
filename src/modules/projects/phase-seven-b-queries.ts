import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * Phase 7b overview for the Admin panel: the client's portal requests (and whether a person has settled them), the handover access log, the archive and the
 * retention policy an Admin set, the records marked eligible for review, and the Orchestrator's recorded Phase 7 routing decisions. One read of the STORED
 * state; every read is guarded (`unreadable`), so a failed read is never rendered as "nothing yet". These tables are not in the generated database types,
 * so the reads go through a minimal structural type.
 */

type Row = Record<string, unknown>;
type Res = PromiseLike<{ data: unknown; error: { message: string } | null }>;
type Loose = {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): Res & { order(column: string, options: { ascending: boolean }): Res & { limit(n: number): Res } };
    };
  };
};

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const rows = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);

export type PhaseSevenBView = {
  requests: { id: string; kind: string; version: number; note: string | null; requestedName: string; requestedAt: string; settlement: { decision: string; note: string | null; decidedAt: string } | null }[];
  accessLog: { event: string; itemKind: string | null; version: number; at: string }[];
  archive: { state: string; portalReadOnly: boolean; startedAt: string; archivedAt: string | null; policy: Record<string, { version: number; indefinite: boolean; days: number | null }> } | null;
  policies: { recordClass: string; version: number; indefinite: boolean; days: number | null; portalReadOnly: boolean | null; reason: string }[];
  reviews: { recordClass: string; policyVersion: number; eligibleAt: string }[];
  routing: { taskType: string; outcome: string; code: string; toAgent: string | null; reason: string; decidedAt: string }[];
};

export async function readPhaseSevenB(projectId: string): Promise<PhaseSevenBView> {
  const supabase = await createClient();
  const projects = supabase.schema('projects') as unknown as Loose;

  const requestsRes = await projects.from('p7b_portal_requests').select('id, kind, package_version, note, requested_name, requested_at').eq('project_id', projectId).order('requested_at', { ascending: false }).limit(50);
  if (requestsRes.error) unreadable('readPhaseSevenB.requests', requestsRes.error);
  const settlementsRes = await projects.from('p7b_portal_request_settlements').select('request_id, decision, note, decided_at, organization_id').eq('organization_id', await organizationOf(projects, projectId)).order('decided_at', { ascending: false }).limit(200);
  if (settlementsRes.error) unreadable('readPhaseSevenB.settlements', settlementsRes.error);
  const settled = new Map(rows(settlementsRes.data).map((s) => [String(s.request_id), { decision: String(s.decision), note: str(s.note), decidedAt: String(s.decided_at) }]));

  const logRes = await projects.from('p7b_handover_access_log').select('event, item_kind, package_version, at').eq('project_id', projectId).order('at', { ascending: false }).limit(20);
  if (logRes.error) unreadable('readPhaseSevenB.accessLog', logRes.error);

  const archiveRes = await projects.from('p7b_archives').select('state, portal_read_only, started_at, archived_at, policy_snapshot').eq('project_id', projectId).order('started_at', { ascending: false }).limit(1);
  if (archiveRes.error) unreadable('readPhaseSevenB.archive', archiveRes.error);
  const archive = rows(archiveRes.data)[0];

  const policyRes = await projects.from('p7b_retention_policies').select('record_class, version, indefinite, retention_days, portal_read_only, reason').eq('organization_id', await organizationOf(projects, projectId)).order('version', { ascending: false }).limit(200);
  if (policyRes.error) unreadable('readPhaseSevenB.policies', policyRes.error);
  const latest = new Map<string, Row>();
  for (const p of rows(policyRes.data)) if (!latest.has(String(p.record_class))) latest.set(String(p.record_class), p);

  const reviewRes = await projects.from('p7b_retention_reviews').select('record_class, policy_version, eligible_at').eq('project_id', projectId).order('eligible_at', { ascending: false }).limit(50);
  if (reviewRes.error) unreadable('readPhaseSevenB.reviews', reviewRes.error);

  const routeRes = await projects.from('p7b_routing_decisions').select('task_type, outcome, code, to_agent, reason, decided_at').eq('project_id', projectId).order('decided_at', { ascending: false }).limit(20);
  if (routeRes.error) unreadable('readPhaseSevenB.routing', routeRes.error);

  return {
    requests: rows(requestsRes.data).map((r) => ({
      id: String(r.id),
      kind: String(r.kind),
      version: Number(r.package_version),
      note: str(r.note),
      requestedName: String(r.requested_name),
      requestedAt: String(r.requested_at),
      settlement: settled.get(String(r.id)) ?? null,
    })),
    accessLog: rows(logRes.data).map((r) => ({ event: String(r.event), itemKind: str(r.item_kind), version: Number(r.package_version), at: String(r.at) })),
    archive: archive
      ? {
          state: String(archive.state),
          portalReadOnly: archive.portal_read_only === true,
          startedAt: String(archive.started_at),
          archivedAt: str(archive.archived_at),
          policy: ((archive.policy_snapshot ?? {}) as Record<string, { version: number; indefinite: boolean; days: number | null }>),
        }
      : null,
    policies: [...latest.values()].map((p) => ({
      recordClass: String(p.record_class),
      version: Number(p.version),
      indefinite: p.indefinite === true,
      days: typeof p.retention_days === 'number' ? p.retention_days : null,
      portalReadOnly: typeof p.portal_read_only === 'boolean' ? p.portal_read_only : null,
      reason: String(p.reason),
    })),
    reviews: rows(reviewRes.data).map((r) => ({ recordClass: String(r.record_class), policyVersion: Number(r.policy_version), eligibleAt: String(r.eligible_at) })),
    routing: rows(routeRes.data).map((r) => ({ taskType: String(r.task_type), outcome: String(r.outcome), code: String(r.code), toAgent: str(r.to_agent), reason: String(r.reason), decidedAt: String(r.decided_at) })),
  };
}

/** The project's organization, from the project row RLS already scopes (the tables above are filtered by it where they have no project column). */
async function organizationOf(projects: Loose, projectId: string): Promise<string> {
  const res = await projects.from('projects').select('organization_id').eq('id', projectId).order('created_at', { ascending: false }).limit(1);
  if (res.error) unreadable('readPhaseSevenB.organization', res.error);
  const org = str(rows(res.data)[0]?.organization_id);
  if (!org) throw new Error('readPhaseSevenB: the project is not visible to this session');
  return org;
}
