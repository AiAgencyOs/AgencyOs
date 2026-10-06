import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { DEVELOPMENT_SPECIALIST_KEYS, validateProposal, type Proposal } from './specialist-proposals';

/**
 * What staff see of specialist proposals for one project, from the STORED records. Every read is guarded (G-054): a failed read is `unreadable`, never
 * rendered as "no proposals". Each proposal is shown with the validator's verdict: the same rules the door enforces, run again over what is stored,
 * so a reader can see a stored proposal still satisfies them against the task as it is now (its affected paths may have been replanned since).
 */

export type ProposalRow = {
  id: string;
  agentKey: string;
  outcome: string;
  summary: string;
  plannedFiles: string[];
  plannedTests: string[];
  risks: string[];
  evidencePlan: string[];
  createdAt: string;
  verdict: { ok: true } | { ok: false; messages: string[] };
};
export type RoutedTask = { taskId: string; title: string; agentKey: string; proposals: ProposalRow[] };
export type SpecialistView = { tasks: RoutedTask[] };

type Row = Record<string, unknown>;
const rows = (d: unknown): Row[] => (Array.isArray(d) ? (d as Row[]) : []);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export async function getSpecialistView(projectId: string): Promise<SpecialistView> {
  const supabase = await createClient();
  const handoffs = await supabase
    .schema('ai')
    .from('handoffs')
    .select('subject_id, to_agent, context')
    .eq('project_id', projectId)
    .eq('subject_type', 'development_task')
    .in('to_agent', [...DEVELOPMENT_SPECIALIST_KEYS])
    .order('created_at', { ascending: false })
    .limit(200);
  if (handoffs.error) unreadable('specialist handoffs', handoffs.error);
  const routed = rows(handoffs.data);
  const taskIds = [...new Set(routed.map((h) => String(h.subject_id)))];
  if (taskIds.length === 0) return { tasks: [] };

  const [tasks, proposals, defects, states] = await Promise.all([
    supabase.schema('projects').from('tasks').select('id, title, required_capability, affected_paths').in('id', taskIds),
    supabase
      .schema('projects')
      .from('specialist_proposals' as never)
      .select('id, task_id, agent_key, outcome, plan_summary, planned_files, planned_tests, risks, evidence_plan, detail, created_at')
      .in('task_id', taskIds)
      .order('created_at', { ascending: false })
      .limit(200),
    supabase.schema('qa').from('defects').select('id, task_id').in('task_id', taskIds),
    supabase.schema('projects').from('phase_five_agent_state').select('agent_key, state').eq('project_id', projectId),
  ]);
  if (tasks.error) unreadable('specialist tasks', tasks.error);
  if (proposals.error) unreadable('specialist proposals', proposals.error);
  if (defects.error) unreadable('specialist defects', defects.error);
  if (states.error) unreadable('specialist agent state', states.error);

  const notRequired = new Set(rows(states.data).filter((s) => s.state === 'not_required').map((s) => String(s.agent_key)));
  const taskById = new Map(rows(tasks.data).map((t) => [String(t.id), t]));
  const envelopeByTask = new Map<string, Row>();
  for (const h of routed) if (!envelopeByTask.has(String(h.subject_id))) envelopeByTask.set(String(h.subject_id), ((h.context as { envelope?: Row } | null)?.envelope ?? {}) as Row);

  const out: RoutedTask[] = [];
  for (const taskId of taskIds) {
    const task = taskById.get(taskId);
    if (!task) continue;
    const agent = String(task.required_capability ?? '');
    const env = envelopeByTask.get(taskId) ?? {};
    const linked = rows(defects.data).filter((d) => String(d.task_id) === taskId).map((d) => String(d.id));
    const mine = rows(proposals.data).filter((p) => String(p.task_id) === taskId);
    out.push({
      taskId,
      title: String(task.title ?? ''),
      agentKey: agent,
      proposals: mine.map((p): ProposalRow => {
        const detail = (p.detail ?? {}) as Row;
        const stored = {
          outcome: p.outcome === 'not_required' ? 'not_required' : 'proposal',
          summary: String(p.plan_summary ?? ''),
          plannedFiles: strings(p.planned_files),
          plannedTests: strings(p.planned_tests),
          risks: strings(p.risks),
          evidencePlan: strings(p.evidence_plan),
          defectId: (detail.defectId as string | undefined) ?? null,
          rootCause: (detail.rootCause as string | undefined) ?? null,
          findings: (detail.findings as Proposal['findings']) ?? null,
          migrations: (detail.migrations as string[] | undefined) ?? null,
          measurement: (detail.measurement as Proposal['measurement']) ?? null,
          target: (detail.target as string | undefined) ?? null,
        } as Proposal;
        const verdict = validateProposal(stored, {
          agentKey: String(p.agent_key),
          affectedPaths: strings(task.affected_paths),
          requiredCapability: agent || null,
          requiredEvidence: strings(env.requiredEvidence),
          linkedDefectIds: linked,
          recordedNotRequired: notRequired.has(String(p.agent_key)),
        });
        return {
          id: String(p.id),
          agentKey: String(p.agent_key),
          outcome: String(p.outcome),
          summary: stored.summary,
          plannedFiles: stored.plannedFiles,
          plannedTests: stored.plannedTests,
          risks: stored.risks,
          evidencePlan: stored.evidencePlan,
          createdAt: String(p.created_at),
          verdict: verdict.ok ? { ok: true } : { ok: false, messages: verdict.messages },
        };
      }),
    });
  }
  return { tasks: out };
}
