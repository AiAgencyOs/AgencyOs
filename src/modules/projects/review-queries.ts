import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { getTestIntegrationView, type TestIntegrationView } from './test-integration-queries';

/**
 * What a person needs to DECIDE on an agent's drafts and to link records, for one project, from the STORED state. Every read is guarded (G-054): a
 * failed read is `unreadable`, never rendered as "nothing to review". The agent's drafts are shown for what they are (proposals); nothing here is evidence.
 * Coverage gaps, integration observability, regression links and dependencies come from the test-integration view, so there is one reading of them.
 */

export type ReviewTestDraft = { id: string; taskId: string; taskTitle: string; name: string; layer: string; description: string; expected: string; status: string; reviewNote: string | null };
export type ReviewDocDraft = { id: string; kind: string; title: string; status: string; body: string };
export type DefectOption = { id: string; title: string; status: string };
export type BuildOption = { id: string; version: number; title: string };
export type RunOption = { id: string; deliverableId: string; suite: string; createdAt: string };
export type TaskOption = { id: string; title: string };
export type ConnectionOption = { id: string; name: string; health: string };
export type LinkDetail = { id: string; defectId: string; defectTitle: string; testCaseName: string; state: string; defectiveBuildId: string | null };

export type ReviewView = {
  integration: TestIntegrationView;
  testDrafts: ReviewTestDraft[];
  docDrafts: ReviewDocDraft[];
  defects: DefectOption[];
  builds: BuildOption[];
  runs: RunOption[];
  tasks: TaskOption[];
  connections: ConnectionOption[];
  links: LinkDetail[];
};

/** The marker the Documentation agent's door writes at the head of every draft body; it is removed only by an Admin's review. */
export const DOC_DRAFT_MARKER = 'DRAFT (written by the Documentation agent';

type Row = Record<string, unknown>;
const rows = (d: unknown): Row[] => (Array.isArray(d) ? (d as Row[]) : []);

export async function getReviewView(projectId: string): Promise<ReviewView> {
  const supabase = await createClient();
  const [integration, drafts, docs, defects, builds, runs, tasks, conns, links] = await Promise.all([
    getTestIntegrationView(projectId),
    supabase.schema('projects').from('test_case_drafts' as never).select('id, task_id, name, layer, description, expected, status, review_note').eq('project_id', projectId).order('created_at', { ascending: false }).limit(50),
    supabase.schema('projects').from('technical_documents' as never).select('id, kind, title, status, body').eq('project_id', projectId).eq('status', 'partial').ilike('body', `${DOC_DRAFT_MARKER}%`).order('updated_at', { ascending: false }).limit(50),
    supabase.schema('qa').from('defects' as never).select('id, title, status').eq('project_id', projectId).order('created_at', { ascending: false }).limit(100),
    supabase.schema('projects').from('deliverables' as never).select('id, version, title').eq('project_id', projectId).eq('kind', 'build').order('version', { ascending: false }).limit(30),
    supabase.schema('qa').from('test_runs' as never).select('id, deliverable_id, suite, created_at').eq('project_id', projectId).order('created_at', { ascending: false }).limit(50),
    supabase.schema('projects').from('tasks' as never).select('id, title').eq('project_id', projectId).is('archived_at', null).neq('status', 'cancelled').order('title', { ascending: true }).limit(200),
    supabase.schema('projects').from('integration_connections' as never).select('id, name, health').eq('project_id', projectId).order('name', { ascending: true }).limit(50),
    supabase.schema('qa').from('regression_links' as never).select('id, defect_id, test_case_name, state, defective_deliverable_id').eq('project_id', projectId).order('created_at', { ascending: false }).limit(50),
  ]);
  if (drafts.error) unreadable('test case drafts for review', drafts.error);
  if (docs.error) unreadable('documentation drafts for review', docs.error);
  if (defects.error) unreadable('defects for review', defects.error);
  if (builds.error) unreadable('builds for review', builds.error);
  if (runs.error) unreadable('test runs for review', runs.error);
  if (tasks.error) unreadable('tasks for review', tasks.error);
  if (conns.error) unreadable('integration connections for review', conns.error);
  if (links.error) unreadable('regression links for review', links.error);

  const taskTitle = new Map(rows(tasks.data).map((t) => [String(t.id), String(t.title)]));
  const defectTitle = new Map(rows(defects.data).map((d) => [String(d.id), String(d.title)]));
  return {
    integration,
    testDrafts: rows(drafts.data).map((d) => ({
      id: String(d.id),
      taskId: String(d.task_id),
      taskTitle: taskTitle.get(String(d.task_id)) ?? 'A task',
      name: String(d.name),
      layer: String(d.layer),
      description: String(d.description),
      expected: String(d.expected),
      status: String(d.status),
      reviewNote: (d.review_note as string | null) ?? null,
    })),
    docDrafts: rows(docs.data).map((d) => ({ id: String(d.id), kind: String(d.kind), title: String(d.title), status: String(d.status), body: String(d.body ?? '') })),
    defects: rows(defects.data).map((d) => ({ id: String(d.id), title: String(d.title), status: String(d.status) })),
    builds: rows(builds.data).map((b) => ({ id: String(b.id), version: Number(b.version), title: String(b.title) })),
    runs: rows(runs.data).map((r) => ({ id: String(r.id), deliverableId: String(r.deliverable_id), suite: String(r.suite), createdAt: String(r.created_at) })),
    tasks: [...taskTitle].map(([id, title]) => ({ id, title })),
    connections: rows(conns.data).map((c) => ({ id: String(c.id), name: String(c.name), health: String(c.health) })),
    links: rows(links.data).map((l) => ({
      id: String(l.id),
      defectId: String(l.defect_id),
      defectTitle: defectTitle.get(String(l.defect_id)) ?? 'A defect',
      testCaseName: String(l.test_case_name),
      state: String(l.state),
      defectiveBuildId: (l.defective_deliverable_id as string | null) ?? null,
    })),
  };
}
