import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * Phase 7c for the Admin: the Phase 7 Failure Queue (a DERIVED read: `projects.p7_failure_queue` computes it from the current rows, nothing is stored) and the
 * client action requests of a project. Every read is guarded (`unreadable`), so a failed read is never rendered as "nothing is wrong". The tables are not in the
 * generated database types, so the reads go through a minimal structural type.
 */

type Row = Record<string, unknown>;
type Res = PromiseLike<{ data: unknown; error: { message: string } | null }>;
type Loose = {
  rpc(fn: string, args: Record<string, unknown>): Res;
  from(table: string): { select(columns: string): { eq(column: string, value: string): Res & { order(column: string, options: { ascending: boolean }): Res & { limit(n: number): Res } } } };
};

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const rows = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);

export type FailureItem = { kind: string; projectId: string; projectName: string; subjectId: string; since: string; ageHours: number; detail: string };

export type ClientActionView = {
  id: string;
  kind: string;
  title: string;
  instructions: string;
  dueAt: string;
  status: string;
  overdue: boolean;
  submittedName: string | null;
  submittedAt: string | null;
  submissionNote: string | null;
  submissionRef: string | null;
  returnedNote: string | null;
};

export async function readFailureQueue(staleHours = 24): Promise<FailureItem[]> {
  const supabase = await createClient();
  const { data, error } = await (supabase.schema('projects') as unknown as Loose).rpc('p7_failure_queue', { p_stale_hours: staleHours });
  if (error) unreadable('readFailureQueue', error);
  return rows(data).map((r) => ({
    kind: String(r.kind),
    projectId: String(r.project_id),
    projectName: String(r.project_name),
    subjectId: String(r.subject_id),
    since: String(r.since),
    ageHours: Number(r.age_hours),
    detail: String(r.detail),
  }));
}

export async function readProjectFailures(projectId: string, staleHours = 24): Promise<FailureItem[]> {
  return (await readFailureQueue(staleHours)).filter((f) => f.projectId === projectId);
}

export async function readClientActionRequests(projectId: string): Promise<ClientActionView[]> {
  const supabase = await createClient();
  const { data, error } = await (supabase.schema('projects') as unknown as Loose)
    .from('p7c_client_action_requests')
    .select('id, kind, title, instructions, due_at, status, submitted_name, submitted_at, submission_note, submission_ref, returned_note')
    .eq('project_id', projectId)
    .order('due_at', { ascending: true })
    .limit(50);
  if (error) unreadable('readClientActionRequests', error);
  const now = Date.now();
  return rows(data).map((r) => ({
    id: String(r.id),
    kind: String(r.kind),
    title: String(r.title),
    instructions: String(r.instructions),
    dueAt: String(r.due_at),
    status: String(r.status),
    overdue: r.status === 'open' && Date.parse(String(r.due_at)) < now,
    submittedName: str(r.submitted_name),
    submittedAt: str(r.submitted_at),
    submissionNote: str(r.submission_note),
    submissionRef: str(r.submission_ref),
    returnedNote: str(r.returned_note),
  }));
}
