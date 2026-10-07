import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * Post-deploy smoke failures of released maintenance changes, from the STORED rows. A failed read is `unreadable`, never "nothing here".
 * Reading is internal-only (RLS). Nothing is computed here: the decision and its independence are the database's.
 */

export type SmokeFailure = {
  id: string;
  workItemId: string;
  deploymentRef: string;
  evidenceRef: string;
  reason: string;
  severity: 'minor' | 'major' | 'critical';
  status: 'open' | 'decided';
  reportedBy: string;
  reportedAt: string;
  decision: 'rollback_executed' | 'forward_fix' | 'false_alarm' | null;
  decisionNote: string | null;
  decidedAt: string | null;
};

export type SmokeView = { viewerId: string; failures: SmokeFailure[]; releasedItems: { id: string; title: string }[] };

type Row = Record<string, unknown>;
type Res = PromiseLike<{ data: unknown; error: { message: string } | null }>;
type Loose = { from(table: string): { select(columns: string): { eq(column: string, value: string): Res & { order(column: string, o: { ascending: boolean }): Res & { limit(n: number): Res } } } } };

export async function readSmokeView(projectId: string): Promise<SmokeView> {
  const context = await requireInternal();
  const supabase = await createClient();
  const projects = supabase.schema('projects') as unknown as Loose;
  const [failures, released] = await Promise.all([
    projects.from('maintenance_smoke_failures').select('id, work_item_id, deployment_ref, evidence_ref, reason, severity, status, reported_by, reported_at, decision, decision_note, decided_at').eq('project_id', projectId).order('reported_at', { ascending: false }).limit(50),
    projects.from('maintenance_work_items').select('id, title, status').eq('project_id', projectId).order('created_at', { ascending: false }).limit(50),
  ]);
  if (failures.error) unreadable('readSmokeView.failures', failures.error);
  if (released.error) unreadable('readSmokeView.releasedItems', released.error);
  const rows = (failures.data as Row[] | null) ?? [];
  return {
    viewerId: context.userId,
    failures: rows.map((r) => ({
      id: String(r.id), workItemId: String(r.work_item_id), deploymentRef: String(r.deployment_ref), evidenceRef: String(r.evidence_ref), reason: String(r.reason),
      severity: r.severity as SmokeFailure['severity'], status: r.status as SmokeFailure['status'], reportedBy: String(r.reported_by), reportedAt: String(r.reported_at),
      decision: (r.decision as SmokeFailure['decision']) ?? null, decisionNote: r.decision_note === null || r.decision_note === undefined ? null : String(r.decision_note), decidedAt: r.decided_at === null || r.decided_at === undefined ? null : String(r.decided_at),
    })),
    releasedItems: ((released.data as Row[] | null) ?? []).filter((r) => r.status === 'released').map((r) => ({ id: String(r.id), title: String(r.title) })),
  };
}
